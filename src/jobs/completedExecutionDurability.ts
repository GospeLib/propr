/**
 * The durability barrier on a published `completed` for a task that ran a model execution.
 *
 * `completed` is the signal a downstream consumer acts on, and the only other thing it has to
 * read is the history. The start-time `claude_execution` placeholder is durable the moment the
 * agent starts; everything that supersedes it — the in-place rewrite and the appended final
 * `claude_execution` entry — was best effort. So a partially persisted success could leave the
 * durable history as `[provisional success:false, completed]`, which a value-only reader takes
 * for a failed delivery and re-dispatches, forever.
 *
 * The invariant this module enforces: a task never reaches a published `completed` unless the
 * durable history carries either a final (phase-labelled) model result or the terminal
 * `agentOutcome`. The evidence rides on the completed transition itself and the transition is
 * published with `requireDurableHistory`, so the two cannot come apart: `updateTaskState` rolls
 * its Redis projection back and throws when the database row does not land, meaning nothing —
 * not Redis, not the database, not the realtime event — ever shows `completed` without evidence.
 *
 * A write that rejects is not proof that nothing landed: an INSERT can commit and lose its
 * acknowledgement. So every attempt carries one idempotency key (`transition_id`, unique in
 * `task_history`), and after any failure the history is read back by that key before anything is
 * decided — a lost acknowledgement is recognised as the completion it is, rather than rolled back
 * and overwritten by a `failed` fallback that would make a delivered success look re-dispatchable.
 *
 * When the database genuinely will not take the write, the work is not discarded: the task is
 * settled as durably `failed` carrying the same terminal evidence (including an `agentOutcome`
 * that says the model succeeded, and the PR/commit the run produced) plus
 * `completionPersistenceFailed`. That record is terminal, durable and self-describing, so it can
 * be neither mistaken for a delivered success nor read as a fresh unrun task. If even that
 * cannot be persisted, the error propagates and the job fails loudly rather than lying.
 */
import { randomUUID } from 'node:crypto';
import { db, ErrorCategories, TaskStates } from '@propr/core';
import type { ClaudeResultSummary, UpdateMetadata, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';
import { ClaudeResultPhases } from './claudeExecutionResult.js';

/** Refused before anything is published: the caller gave no final execution evidence to record. */
export const COMPLETION_WITHOUT_EXECUTION_EVIDENCE = 'COMPLETION_WITHOUT_DURABLE_EXECUTION_EVIDENCE';
/** The completed entry could not be persisted; the task was settled as failed instead. */
export const COMPLETION_HISTORY_NOT_DURABLE = 'COMPLETION_HISTORY_NOT_DURABLE';
/**
 * The write failed and the history could not be read back, so whether `completed` is durable is
 * unknown. Nothing terminal is written on a guess; the job fails loudly instead.
 */
export const COMPLETION_DURABILITY_UNVERIFIABLE = 'COMPLETION_DURABILITY_UNVERIFIABLE';

const MAX_DURABLE_COMPLETION_ATTEMPTS = 3;
const DURABLE_COMPLETION_RETRY_DELAY_MS = 50;

type CompletionStateManager = Pick<WorkerStateManager, 'updateTaskState' | 'markTaskFailed'>;

export interface DurableCompletionOptions {
    stateManager: CompletionStateManager;
    taskId: string;
    metadata: UpdateMetadata;
    correlatedLogger?: Logger;
}

function isFinalModelResult(value: unknown): boolean {
    return (value as ClaudeResultSummary | undefined)?.resultPhase === ClaudeResultPhases.FINAL;
}

/**
 * Whether this completion carries what the barrier requires: a final (phase-labelled) model
 * result, or the terminal `agentOutcome`. A provisional result is not evidence of anything.
 */
export function carriesTerminalExecutionEvidence(metadata: UpdateMetadata): boolean {
    const history = (metadata.historyMetadata ?? {}) as Record<string, unknown>;
    const agentOutcome = history.agentOutcome as { success?: unknown } | undefined;
    return isFinalModelResult(metadata.claudeResult)
        || isFinalModelResult(history.claudeResult)
        || typeof agentOutcome?.success === 'boolean';
}

/** Settles a success whose completed entry will not persist, without discarding its evidence. */
async function settleUnrecordableCompletionAsFailed(options: DurableCompletionOptions, cause: Error): Promise<void> {
    const { stateManager, taskId, metadata, correlatedLogger } = options;
    correlatedLogger?.error({ taskId, error: cause.message },
        'Completed task history could not be persisted; settling the task as failed with its execution evidence');
    await stateManager.markTaskFailed(taskId, new Error(`${COMPLETION_HISTORY_NOT_DURABLE}: ${cause.message}`), {
        errorCategory: ErrorCategories.POST_PROCESSING,
        transitionId: terminalTransitionId(taskId, TaskStates.FAILED),
        ...(metadata.claudeResult ? { claudeResult: metadata.claudeResult } : {}),
        ...(metadata.prResult ? { prResult: metadata.prResult } : {}),
        ...(metadata.commitHash ? { commitHash: metadata.commitHash } : {}),
        historyMetadata: { ...(metadata.historyMetadata ?? {}), completionPersistenceFailed: true },
        requireDurableHistory: true,
    });
}

/**
 * The idempotency key for one logical terminal transition.
 *
 * Deterministic for that transition: it is computed once, before the first write, and the same
 * value is reused by every retry and by the read-back, so all of them address exactly one row.
 * Non-colliding across genuinely different transitions: the key carries the transition's target
 * state and task id and ends in a fresh 122-bit random UUID, so a second terminal transition of
 * the same task — a later completion, or the `failed` settlement below — is a different key and
 * can never be mistaken for, or blocked by, this one.
 */
export function terminalTransitionId(taskId: string, state: string): string {
    return `${state}:${taskId}:${randomUUID()}`;
}

/** What the durable history says about a completion whose write did not acknowledge. */
type DurableCompletion = 'durable' | 'absent' | 'unverifiable';

/**
 * Establishes what is actually durable after an ambiguous write, rather than assuming.
 *
 * A rejected INSERT promise is not proof that nothing landed: the row can commit and the
 * acknowledgement be lost. So the history is read back — first for this exact transition key, then
 * for any `completed` row of the task — and only `absent` (a read that succeeded and found
 * nothing) permits a retry or a `failed` settlement.
 */
async function readBackDurableCompletion(options: DurableCompletionOptions, transitionId: string): Promise<DurableCompletion> {
    const { taskId, correlatedLogger } = options;
    try {
        const byTransition = await db('task_history').where({ task_id: taskId, transition_id: transitionId }).first();
        if (byTransition) return 'durable';
        const byState = await db('task_history').where({ task_id: taskId, state: TaskStates.COMPLETED }).first();
        return byState ? 'durable' : 'absent';
    } catch (error) {
        correlatedLogger?.error({ taskId, transitionId, error: (error as Error).message },
            'Could not read the task history back to establish whether the completed entry is durable');
        return 'unverifiable';
    }
}

/**
 * The completed entry is durable although the client saw an error, so the task IS completed. The
 * strict write rolled the Redis projection back and published no event; both are brought back
 * into line with the durable history. The re-published entry carries the same transition key, so
 * the uniqueness constraint rejects its insert and no second completed row is written.
 */
async function reconcileDurablyCompletedTask(options: DurableCompletionOptions, transitionId: string): Promise<void> {
    const { stateManager, taskId, metadata, correlatedLogger } = options;
    correlatedLogger?.warn({ taskId, transitionId },
        'The completed history entry committed despite the failed write; reconciling the projection instead of failing the task');
    try {
        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, { ...metadata, transitionId });
    } catch (error) {
        // The durable history already says completed, which is what a consumer reads; a projection
        // that could not be caught up is logged, never converted into a terminal failure.
        correlatedLogger?.error({ taskId, error: (error as Error).message },
            'Could not reconcile the projection of an already-durable completed task');
    }
}

/**
 * Publishes `completed` only once its terminal execution evidence is durable.
 *
 * Throws `COMPLETION_WITHOUT_DURABLE_EXECUTION_EVIDENCE` when the caller has no final evidence to
 * record — the completion is refused outright rather than published unreadable.
 *
 * Every attempt carries one idempotency key, and no failed attempt is believed: the history is
 * read back before anything else is decided. A commit whose acknowledgement was lost is
 * recognised as the success it is; only a confirmed absence is retried, and only a confirmed
 * absence may settle as failed. When the read-back itself cannot be performed, nothing terminal
 * is written and `COMPLETION_DURABILITY_UNVERIFIABLE` propagates.
 */
export async function publishCompletedWithDurableExecutionEvidence(options: DurableCompletionOptions): Promise<void> {
    const { stateManager, taskId, metadata } = options;
    if (!carriesTerminalExecutionEvidence(metadata)) throw new Error(COMPLETION_WITHOUT_EXECUTION_EVIDENCE);

    const transitionId = terminalTransitionId(taskId, TaskStates.COMPLETED);
    let lastError: Error | undefined;
    let lastReadBack: DurableCompletion = 'absent';
    for (let attempt = 0; attempt < MAX_DURABLE_COMPLETION_ATTEMPTS; attempt++) {
        try {
            await stateManager.updateTaskState(taskId, TaskStates.COMPLETED,
                { ...metadata, transitionId, requireDurableHistory: true });
            return;
        } catch (error) {
            lastError = error as Error;
            options.correlatedLogger?.warn({ taskId, attempt, transitionId, error: lastError.message },
                'Could not durably publish the completed task history entry');
            lastReadBack = await readBackDurableCompletion(options, transitionId);
            if (lastReadBack === 'durable') {
                await reconcileDurablyCompletedTask(options, transitionId);
                return;
            }
            if (attempt < MAX_DURABLE_COMPLETION_ATTEMPTS - 1) {
                await new Promise(resolve => setTimeout(resolve, DURABLE_COMPLETION_RETRY_DELAY_MS));
            }
        }
    }
    const cause = lastError ?? new Error('unknown');
    if (lastReadBack === 'unverifiable') {
        throw new Error(`${COMPLETION_DURABILITY_UNVERIFIABLE}: ${cause.message}`);
    }
    await settleUnrecordableCompletionAsFailed(options, cause);
}

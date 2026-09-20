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
 * acknowledgement. So the transition carries an idempotency key (`transition_id`, unique in
 * `task_history`) and the history is read back by that key before anything is decided. The key is
 * NOT invented per attempt: it is derived from the caller's durable logical-operation identity
 * and claimed in `task_terminal_transitions` before the terminal write, so a process that dies
 * after a committed insert and a queue that redelivers the job arrive at the SAME key and
 * recognise the completion that is already durable, instead of writing a second one or settling
 * `failed` over a delivered success.
 *
 * When the database genuinely will not take the write, the work is not discarded: the task is
 * settled as durably `failed` carrying the same terminal evidence (including an `agentOutcome`
 * that says the model succeeded, and the PR/commit the run produced) plus
 * `completionPersistenceFailed`. That record is terminal, durable and self-describing, so it can
 * be neither mistaken for a delivered success nor read as a fresh unrun task.
 *
 * When durability cannot be ESTABLISHED at all — the read-back itself fails, or the identity
 * cannot be claimed — nothing terminal is written on a guess. `CompletionDurabilityUnverifiableError`
 * propagates, and every outer failure handler on every path re-throws it instead of settling, so
 * an unverifiable completion can never be followed by `failed`.
 */
import { db, ErrorCategories, TaskStates, durableExecutionCompletionGuard, claimTerminalTransition } from '@propr/core';
import type { ClaudeResultSummary, UpdateMetadata, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';
import { ClaudeResultPhases } from './claudeExecutionResult.js';
import { CompletionDurabilityUnverifiableError, COMPLETION_DURABILITY_UNVERIFIABLE, isCompletionDurabilityUnverifiable }
    from './completionDurabilityOutcome.js';

// Re-exported so a caller that already imports the barrier needs no second import; a failure
// handler that only needs to RECOGNISE the outcome imports the dependency-free module directly.
export { CompletionDurabilityUnverifiableError, COMPLETION_DURABILITY_UNVERIFIABLE, isCompletionDurabilityUnverifiable };

/** Refused before anything is published: the caller gave no final execution evidence to record. */
export const COMPLETION_WITHOUT_EXECUTION_EVIDENCE = 'COMPLETION_WITHOUT_DURABLE_EXECUTION_EVIDENCE';
/** The completed entry could not be persisted; the task was settled as failed instead. */
export const COMPLETION_HISTORY_NOT_DURABLE = 'COMPLETION_HISTORY_NOT_DURABLE';
const MAX_DURABLE_COMPLETION_ATTEMPTS = 3;
const DURABLE_COMPLETION_RETRY_DELAY_MS = 50;
/** The settlement is its own logical transition of the same operation, and claims its own key. */
const COMPLETION_PERSISTENCE_FAILED_SUFFIX = '#completion-persistence-failed';

type CompletionStateManager = Pick<WorkerStateManager, 'updateTaskState' | 'markTaskFailed'>;

export interface DurableCompletionOptions {
    stateManager: CompletionStateManager;
    taskId: string;
    /**
     * The durable identity of the logical operation publishing this completion — the execution
     * admission receipt, or the queue job that owns this attempt. It must be readable again,
     * unchanged, after the process dies and the queue redelivers the job: it is what makes the
     * idempotency key survive exactly the failure the key exists for. Build it with
     * `durableOperationIdentity`, never from a clock, a random value or an attempt counter.
     */
    operationId: string;
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
    const { stateManager, taskId, metadata, operationId, correlatedLogger } = options;
    correlatedLogger?.error({ taskId, error: cause.message },
        'Completed task history could not be persisted; settling the task as failed with its execution evidence');
    const transitionId = await claimTerminalTransition(taskId, TaskStates.FAILED, `${operationId}${COMPLETION_PERSISTENCE_FAILED_SUFFIX}`);
    await stateManager.markTaskFailed(taskId, new Error(`${COMPLETION_HISTORY_NOT_DURABLE}: ${cause.message}`), {
        errorCategory: ErrorCategories.POST_PROCESSING,
        transitionId,
        ...(metadata.claudeResult ? { claudeResult: metadata.claudeResult } : {}),
        ...(metadata.prResult ? { prResult: metadata.prResult } : {}),
        ...(metadata.commitHash ? { commitHash: metadata.commitHash } : {}),
        historyMetadata: { ...(metadata.historyMetadata ?? {}), completionPersistenceFailed: true },
        requireDurableHistory: true,
    });
}

/** What the durable history says about a completion whose write did not acknowledge. */
type DurableCompletion = 'durable' | 'absent' | 'unverifiable';

/**
 * Establishes what is actually durable after an ambiguous write, rather than assuming.
 *
 * A rejected INSERT promise is not proof that nothing landed: the row can commit and the
 * acknowledgement be lost. So the history is read back by this transition's claimed key — and by
 * nothing else. There is deliberately no "any completed row for this task" fallback: an older
 * completed row of some other transition is not evidence that THIS one committed, and inferring
 * from it is exactly how a reconciliation republished a completion whose evidence never landed.
 * Only `absent` (a read that succeeded and found no row for this key) permits a retry or a
 * `failed` settlement.
 */
async function readBackDurableCompletion(options: DurableCompletionOptions, transitionId: string): Promise<DurableCompletion> {
    const { taskId, correlatedLogger } = options;
    try {
        const byTransition = await db('task_history').where({ task_id: taskId, transition_id: transitionId }).first();
        return byTransition ? 'durable' : 'absent';
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
        await stateManager.updateTaskState(taskId, TaskStates.COMPLETED,
            { ...metadata, transitionId, completionGuard: durableExecutionCompletionGuard(transitionId) });
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
 * The transition identity is claimed durably first, so every attempt — including one made by a
 * different process after a crash — addresses the same row. No failed attempt is believed: the
 * history is read back by that key before anything else is decided. A commit whose
 * acknowledgement was lost is recognised as the success it is; only a confirmed absence is
 * retried, and only a confirmed absence may settle as failed. When durability cannot be
 * established, `CompletionDurabilityUnverifiableError` propagates and nothing terminal is written.
 */
export async function publishCompletedWithDurableExecutionEvidence(options: DurableCompletionOptions): Promise<void> {
    const { stateManager, taskId, metadata, operationId } = options;
    if (!carriesTerminalExecutionEvidence(metadata)) throw new Error(COMPLETION_WITHOUT_EXECUTION_EVIDENCE);

    let transitionId: string;
    try {
        transitionId = await claimTerminalTransition(taskId, TaskStates.COMPLETED, operationId);
    } catch (error) {
        // Without a durable identity a retry cannot recognise a completion that already committed
        // on an earlier delivery, so no terminal state may be written on this attempt either.
        throw new CompletionDurabilityUnverifiableError(taskId, `the transition identity could not be claimed: ${(error as Error).message}`);
    }

    let lastError: Error | undefined;
    let lastReadBack: DurableCompletion = 'absent';
    for (let attempt = 0; attempt < MAX_DURABLE_COMPLETION_ATTEMPTS; attempt++) {
        try {
            await stateManager.updateTaskState(taskId, TaskStates.COMPLETED,
                { ...metadata, transitionId, requireDurableHistory: true, completionGuard: durableExecutionCompletionGuard(transitionId) });
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
        throw new CompletionDurabilityUnverifiableError(taskId, cause.message);
    }
    await settleUnrecordableCompletionAsFailed(options, cause);
}

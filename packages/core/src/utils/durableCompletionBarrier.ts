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
 * A completion that IS already durable is brought back into line with a PROJECTION-ONLY
 * reconciliation: Redis and the realtime event are caught up and no second history row is
 * appended. The previous shape — re-running the full transition and relying on the unique index
 * to reject its insert — left Redis nonterminal whenever that rejection was swallowed, which is
 * exactly the state a later finalizer mistook for "nothing has settled this task yet".
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
 *
 * It lives in core, beside the state manager and the transition claim, because the publishers
 * that need it are not all in one place: the queue jobs in `src/jobs` reach it through
 * `completedExecutionDurability.ts`, and the synchronous native-analysis route in `packages/api`
 * — which cannot import that tree — reaches it directly.
 */
import type { Logger } from 'pino';
import { db } from '../db/connection.js';
import { ErrorCategories } from './errorHandler.js';
import { durableExecutionCompletionGuard, type CompletionGuard } from './completionGuard.js';
import { claimTerminalTransition } from './terminalTransitionClaim.js';
import {
    ClaudeResultPhases,
    TaskStates,
    type ClaudeResultSummary,
    type UpdateMetadata,
} from './workerStateManager.types.js';
import { CompletionDurabilityUnverifiableError } from './completionDurabilityOutcome.js';
import type { WorkerStateManager } from './workerStateManager.js';

/** Refused before anything is published: the caller gave no final execution evidence to record. */
export const COMPLETION_WITHOUT_EXECUTION_EVIDENCE = 'COMPLETION_WITHOUT_DURABLE_EXECUTION_EVIDENCE';
/** The completed entry could not be persisted; the task was settled as failed instead. */
export const COMPLETION_HISTORY_NOT_DURABLE = 'COMPLETION_HISTORY_NOT_DURABLE';
/** The durable history holds no completed row for this exact transition identity. */
export const DURABLE_COMPLETION_ABSENT = 'DURABLE_COMPLETION_ABSENT';
const MAX_DURABLE_COMPLETION_ATTEMPTS = 3;
const DURABLE_COMPLETION_RETRY_DELAY_MS = 50;
/**
 * The settlement is its own logical transition of the same operation, and claims its own key.
 *
 * Exported because a caller that has to know whether ANY terminal record of its operation became
 * durable — the native-analysis route, deciding whether it may hand its execution lease back —
 * must be able to derive this identity too. Guessing it, or omitting it, would read a settled
 * operation as unsettled and re-admit paid work.
 */
export const COMPLETION_PERSISTENCE_FAILED_SUFFIX = '#completion-persistence-failed';

type CompletionStateManager = Pick<WorkerStateManager, 'updateTaskState' | 'markTaskFailed' | 'projectDurableCompletion'>;

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

/** What the barrier established about the completion it was asked to publish. */
export interface DurableCompletionResult {
    /**
     * `published` — the completed entry is durable under `transitionId`.
     * `settled_failed` — the write was confirmed absent and the run was settled as failed
     * instead, carrying its execution evidence.
     */
    outcome: 'published' | 'settled_failed';
    /**
     * The durably claimed identity of the completion. A caller that hands its outcome to another
     * process — a queue result a finalizer will read — passes this on, because it is the only
     * thing that lets that process verify the completion instead of asserting one.
     */
    transitionId: string;
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

/**
 * Reads the durable completed row for this EXACT transition identity, and mints the capability
 * only when it is there.
 *
 * This is how a publisher that did not itself run the execution may certify one: it cannot
 * assert a completion, it can only relay one the history already proves, under the same key the
 * executing path claimed. A read that fails is `unverifiable` — never "absent" — because "the
 * database would not answer" and "nothing was written" are different facts and only the second
 * one permits any terminal decision.
 *
 * There is deliberately no "any completed row for this task" fallback: an older completed row of
 * some other transition is not evidence that THIS one committed, and inferring from it is exactly
 * how a reconciliation republished a completion whose evidence never landed.
 */
export async function certifyDurableCompletion(taskId: string, transitionId: string): Promise<CompletionGuard> {
    if (!transitionId.trim()) {
        throw new CompletionDurabilityUnverifiableError(taskId, 'no terminal transition identity was offered to certify');
    }
    let row: unknown;
    try {
        row = await db('task_history')
            .where({ task_id: taskId, transition_id: transitionId, state: TaskStates.COMPLETED })
            .first();
    } catch (error) {
        throw new CompletionDurabilityUnverifiableError(taskId,
            `the completed history could not be read back for ${transitionId}: ${(error as Error).message}`);
    }
    if (!row) throw new Error(`${DURABLE_COMPLETION_ABSENT}: no completed history row for ${transitionId} on ${taskId}`);
    return durableExecutionCompletionGuard(transitionId);
}

/** Whether this error means the durable history proved the completion is simply not there. */
export function isDurableCompletionAbsent(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith(DURABLE_COMPLETION_ABSENT);
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
 * nothing else. Only `absent` (a read that succeeded and found no row for this key) permits a
 * retry or a `failed` settlement.
 */
async function readBackDurableCompletion(options: DurableCompletionOptions, transitionId: string): Promise<DurableCompletion> {
    const { taskId, correlatedLogger } = options;
    try {
        await certifyDurableCompletion(taskId, transitionId);
        return 'durable';
    } catch (error) {
        if (isDurableCompletionAbsent(error)) return 'absent';
        correlatedLogger?.error({ taskId, transitionId, error: (error as Error).message },
            'Could not read the task history back to establish whether the completed entry is durable');
        return 'unverifiable';
    }
}

/**
 * The completed entry is durable although the client saw an error, so the task IS completed. The
 * strict write rolled the Redis projection back and published no event; both are brought back
 * into line with the durable history through a projection-only reconciliation, which appends no
 * second history row and so cannot leave an unkeyed, evidence-free completion behind.
 */
async function reconcileDurablyCompletedTask(options: DurableCompletionOptions, transitionId: string): Promise<void> {
    const { stateManager, taskId, metadata, correlatedLogger } = options;
    correlatedLogger?.warn({ taskId, transitionId },
        'The completed history entry committed despite the failed write; reconciling the projection instead of failing the task');
    try {
        await stateManager.projectDurableCompletion(taskId, {
            transitionId,
            reason: metadata.reason,
            historyMetadata: metadata.historyMetadata,
        });
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
export async function publishCompletedWithDurableExecutionEvidence(
    options: DurableCompletionOptions,
): Promise<DurableCompletionResult> {
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
            return { outcome: 'published', transitionId };
        } catch (error) {
            lastError = error as Error;
            options.correlatedLogger?.warn({ taskId, attempt, transitionId, error: lastError.message },
                'Could not durably publish the completed task history entry');
            lastReadBack = await readBackDurableCompletion(options, transitionId);
            if (lastReadBack === 'durable') {
                await reconcileDurablyCompletedTask(options, transitionId);
                return { outcome: 'published', transitionId };
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
    return { outcome: 'settled_failed', transitionId };
}

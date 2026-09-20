import {
    TaskStates,
    taskStateExpectation,
    type JobResult,
    type TaskStatePublicationResult,
    type TaskState,
    type TaskStateExpectation,
    type UpdateMetadata,
    type WorkerStateManager,
    nonExecutingCompletionGuard,
} from '@propr/core';
import { sanitizeErrorMessage } from './errorSanitizer.js';
import { isCompletionDurabilityUnverifiable } from './completionDurabilityOutcome.js';

/**
 * The finalizer reconciles a task from its BullMQ job outcome; it runs no model execution of its
 * own. That is exactly why it may not certify one on its own authority: a `complete` or `partial`
 * job result is the report of an EXECUTING job, and settling it here with a non-executing
 * capability mints a completion that carries no execution evidence and no transition key — the
 * shape a value-only consumer re-dispatches on.
 *
 * So the two cases are split:
 *
 * - An EXECUTED outcome (`complete`, `completed`, `partial`) is only relayed. The job result must
 *   carry the transition identity the executing path durably claimed, that exact completed row
 *   must be readable in `task_history`, and the reconciliation is projection-only: Redis and the
 *   realtime event are caught up and NOTHING is appended. Anything less — no identity offered, no
 *   row for it, or a read that could not be made — is refused as `unverifiable_completion`, and
 *   the task is deliberately left unsettled rather than settled on a guess.
 * - A PRE-EXECUTION SKIP is the only completion this module publishes itself, and only when the
 *   job result proves the skip happened before any agent ran (`preExecutionSkip: true`). There is
 *   genuinely no execution evidence to be had, and there was no execution to have it.
 *
 * A processor that DID execute and settled its own terminal state through the barrier is seen
 * here as `already_terminal` and left alone.
 */
const FINALIZER_COMPLETION_REASON =
    'the job skipped before any agent ran, which its result proves; nothing executed to have evidence of';

const MAX_FINALIZATION_RETRY_DELAY_MS = 1_000;
const TERMINAL_STATES = new Set<TaskState>([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);
/** Job result statuses that report an executed run, and so may only ever be relayed. */
const EXECUTED_COMPLETION_STATUSES = new Set(['complete', 'completed', 'partial']);

type TaskStateStore = Pick<
    WorkerStateManager,
    'getTaskState' | 'updateTaskStateIfCurrentDetailed' | 'projectDurableCompletion'
>;

export type PRCommentTaskFinalizationOutcome =
    | 'finalized'
    | 'projection_reconciled'
    | 'unverifiable_completion'
    | 'partial_publication'
    | 'already_terminal'
    | 'retry_pending'
    | 'state_changed'
    | 'task_missing';

export interface PRCommentTaskFinalizationResult {
    outcome: PRCommentTaskFinalizationOutcome;
    stateChanged: boolean;
    publication?: TaskStatePublicationResult;
    /** Why an executed completion could not be relayed, for the operator who has to act on it. */
    unverifiableReason?: string;
}

export interface PRCommentTaskFinalizationOptions {
    expectation?: TaskStateExpectation;
    signal?: AbortSignal;
}

interface FinalTransition {
    state: TaskState;
    metadata: UpdateMetadata;
}

function sanitizedProcessorText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim()
        ? sanitizeErrorMessage(value)
        : undefined;
}

function publicationSucceeded(publication: TaskStatePublicationResult): boolean {
    return publication.historyPersisted && publication.eventPublished;
}

async function waitForFinalizationRetry(attempt: number): Promise<void> {
    const delayMs = Math.min(10 * (2 ** attempt), MAX_FINALIZATION_RETRY_DELAY_MS);
    await new Promise(resolve => setTimeout(resolve, delayMs));
}

function historyMetadataFor(result: JobResult | undefined): Record<string, unknown> {
    const safeStatus = sanitizedProcessorText(result?.status);
    const reason = result ? sanitizedProcessorText(result.reason) : undefined;
    return {
        finalizedBy: 'bullmq_completed',
        jobResultStatus: safeStatus ?? null,
        jobResultReason: reason ?? null,
    };
}

/** The identity the executing path claimed for its completion, when the result carries one. */
function claimedTransitionId(result: JobResult | undefined): string | undefined {
    const claimed = (result as { terminalTransitionId?: unknown } | undefined)?.terminalTransitionId;
    return typeof claimed === 'string' && claimed.trim() ? claimed : undefined;
}

/** Whether the result proves its skip happened before any agent execution started. */
function provesPreExecutionSkip(result: JobResult | undefined): boolean {
    return (result as { preExecutionSkip?: unknown } | undefined)?.preExecutionSkip === true;
}

function completedTransition(result: JobResult | undefined): FinalTransition {
    const status = result?.status;
    const safeStatus = sanitizedProcessorText(status);
    const reason = result ? sanitizedProcessorText(result.reason) : undefined;
    const historyMetadata = historyMetadataFor(result);

    switch (status) {
        case 'skipped':
            return {
                state: TaskStates.COMPLETED,
                metadata: {
                    reason: sanitizeErrorMessage(`PR comment job skipped${reason ? `: ${reason}` : ''}`),
                    historyMetadata,
                    completionGuard: nonExecutingCompletionGuard(FINALIZER_COMPLETION_REASON),
                },
            };
        case 'cancelled':
        case 'requeued':
        case 'rescheduled':
            return {
                state: TaskStates.CANCELLED,
                metadata: {
                    reason: sanitizeErrorMessage(`PR comment job ${status}${reason ? `: ${reason}` : ''}`),
                    historyMetadata,
                },
            };
        case 'failed':
            return failedTransition(reason ?? 'PR comment job returned a failed result', 'bullmq_completed');
        default: {
            const diagnostic = status
                ? `Unexpected PR comment job result status: ${safeStatus ?? '[invalid]'}`
                : 'PR comment job completed without a result status';
            return failedTransition(diagnostic, 'bullmq_completed');
        }
    }
}

function failedTransition(errorMessage: string, finalizedBy: string): FinalTransition {
    const message = sanitizeErrorMessage(errorMessage);
    return {
        state: TaskStates.FAILED,
        metadata: {
            reason: 'PR comment job failed',
            error: { message, category: 'worker' },
            historyMetadata: { finalizedBy, error: message },
        },
    };
}

async function applyFinalTransition(
    taskId: string,
    transition: FinalTransition,
    stateManager: TaskStateStore,
    options: PRCommentTaskFinalizationOptions = {},
): Promise<PRCommentTaskFinalizationResult> {
    for (let attempt = 0; ; attempt++) {
        options.signal?.throwIfAborted();
        const current = await stateManager.getTaskState(taskId);
        options.signal?.throwIfAborted();
        if (!current) return { outcome: 'task_missing', stateChanged: false };
        if (TERMINAL_STATES.has(current.state)) {
            return { outcome: 'already_terminal', stateChanged: false };
        }
        const updated = await stateManager.updateTaskStateIfCurrentDetailed(
            taskId,
            options.expectation ?? taskStateExpectation(current),
            transition.state,
            transition.metadata,
        );
        if (updated) {
            return {
                outcome: publicationSucceeded(updated.publication)
                    ? 'finalized'
                    : 'partial_publication',
                stateChanged: true,
                publication: updated.publication,
            };
        }
        if (options.expectation) {
            return { outcome: 'state_changed', stateChanged: false };
        }
        await waitForFinalizationRetry(attempt);
    }
}

/**
 * Relays an executed completion the durable history already proves, appending nothing.
 *
 * The projection verifies the caller's exact transition identity against `task_history` and
 * refuses to move without it, so a missing identity, a missing row or an unreadable database all
 * end here as `unverifiable_completion` — never as a freshly minted completion, and never as a
 * `failed` settlement over work that may well have been delivered.
 */
async function relayExecutedCompletion(
    taskId: string,
    result: JobResult | undefined,
    stateManager: TaskStateStore,
    options: PRCommentTaskFinalizationOptions,
): Promise<PRCommentTaskFinalizationResult> {
    const transitionId = claimedTransitionId(result);
    if (!transitionId) {
        return {
            outcome: 'unverifiable_completion',
            stateChanged: false,
            unverifiableReason: `a ${result?.status} job result carried no claimed terminal transition identity`,
        };
    }
    options.signal?.throwIfAborted();
    try {
        const projected = await stateManager.projectDurableCompletion(taskId, {
            transitionId,
            reason: 'PR comment job completed',
            historyMetadata: historyMetadataFor(result),
        });
        if (projected === 'projected') return { outcome: 'projection_reconciled', stateChanged: true };
        if (projected === 'task_missing') return { outcome: 'task_missing', stateChanged: false };
        if (projected === 'already_completed') return { outcome: 'already_terminal', stateChanged: false };
        return {
            outcome: 'unverifiable_completion',
            stateChanged: false,
            unverifiableReason: `the task holds a different terminal state than the completion claimed by ${transitionId}`,
        };
    } catch (error) {
        return {
            outcome: 'unverifiable_completion',
            stateChanged: false,
            unverifiableReason: (error as Error).message,
        };
    }
}

export async function finalizeCompletedPRCommentTask(
    taskId: string,
    result: JobResult | undefined,
    stateManager: TaskStateStore,
    options?: PRCommentTaskFinalizationOptions,
): Promise<PRCommentTaskFinalizationResult> {
    const status = result?.status;
    if (status !== undefined && EXECUTED_COMPLETION_STATUSES.has(status)) {
        return relayExecutedCompletion(taskId, result, stateManager, options ?? {});
    }
    if (status === 'skipped' && !provesPreExecutionSkip(result)) {
        // A skip that cannot show it preceded execution is indistinguishable here from an
        // executed run reported as a skip, and a completion is not something to guess at.
        return {
            outcome: 'unverifiable_completion',
            stateChanged: false,
            unverifiableReason: 'a skipped job result did not prove the skip preceded any agent execution',
        };
    }
    return applyFinalTransition(taskId, completedTransition(result), stateManager, options);
}

export async function finalizeFailedPRCommentTask(
    taskId: string,
    error: Error,
    stateManager: TaskStateStore,
    options?: PRCommentTaskFinalizationOptions,
): Promise<PRCommentTaskFinalizationResult> {
    // A job that failed because its completion could not be verified may already have committed
    // that completion. Settling `failed` over it is the exact re-dispatch defect this prevents.
    if (isCompletionDurabilityUnverifiable(error)) {
        return { outcome: 'unverifiable_completion', stateChanged: false, unverifiableReason: error.message };
    }
    return applyFinalTransition(
        taskId,
        failedTransition(error.message, 'bullmq_failed'),
        stateManager,
        options,
    );
}

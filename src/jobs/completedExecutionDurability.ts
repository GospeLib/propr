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
 * When the database genuinely will not take the write, the work is not discarded: the task is
 * settled as durably `failed` carrying the same terminal evidence (including an `agentOutcome`
 * that says the model succeeded, and the PR/commit the run produced) plus
 * `completionPersistenceFailed`. That record is terminal, durable and self-describing, so it can
 * be neither mistaken for a delivered success nor read as a fresh unrun task. If even that
 * cannot be persisted, the error propagates and the job fails loudly rather than lying.
 */
import { ErrorCategories, TaskStates } from '@propr/core';
import type { ClaudeResultSummary, UpdateMetadata, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';
import { ClaudeResultPhases } from './claudeExecutionResult.js';

/** Refused before anything is published: the caller gave no final execution evidence to record. */
export const COMPLETION_WITHOUT_EXECUTION_EVIDENCE = 'COMPLETION_WITHOUT_DURABLE_EXECUTION_EVIDENCE';
/** The completed entry could not be persisted; the task was settled as failed instead. */
export const COMPLETION_HISTORY_NOT_DURABLE = 'COMPLETION_HISTORY_NOT_DURABLE';

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
        ...(metadata.claudeResult ? { claudeResult: metadata.claudeResult } : {}),
        ...(metadata.prResult ? { prResult: metadata.prResult } : {}),
        ...(metadata.commitHash ? { commitHash: metadata.commitHash } : {}),
        historyMetadata: { ...(metadata.historyMetadata ?? {}), completionPersistenceFailed: true },
        requireDurableHistory: true,
    });
}

/**
 * Publishes `completed` only once its terminal execution evidence is durable.
 *
 * Throws `COMPLETION_WITHOUT_DURABLE_EXECUTION_EVIDENCE` when the caller has no final evidence to
 * record — the completion is refused outright rather than published unreadable.
 */
export async function publishCompletedWithDurableExecutionEvidence(options: DurableCompletionOptions): Promise<void> {
    const { stateManager, taskId, metadata } = options;
    if (!carriesTerminalExecutionEvidence(metadata)) throw new Error(COMPLETION_WITHOUT_EXECUTION_EVIDENCE);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_DURABLE_COMPLETION_ATTEMPTS; attempt++) {
        try {
            await stateManager.updateTaskState(taskId, TaskStates.COMPLETED, { ...metadata, requireDurableHistory: true });
            return;
        } catch (error) {
            lastError = error as Error;
            options.correlatedLogger?.warn({ taskId, attempt, error: lastError.message },
                'Could not durably publish the completed task history entry');
            if (attempt < MAX_DURABLE_COMPLETION_ATTEMPTS - 1) {
                await new Promise(resolve => setTimeout(resolve, DURABLE_COMPLETION_RETRY_DELAY_MS));
            }
        }
    }
    await settleUnrecordableCompletionAsFailed(options, lastError ?? new Error('unknown'));
}

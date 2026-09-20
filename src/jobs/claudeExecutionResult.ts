/**
 * Provisional-versus-final truth for the `claude_execution` task-history entry.
 *
 * The session/container callbacks run the moment an agent starts, long before any outcome
 * exists. The record they write is a placeholder, and its `success: false` means "no result
 * yet", not "the execution failed". Downstream consumers (Ezer re-dispatch) read that entry to
 * decide whether a delivery succeeded, so the placeholder must say so about itself and the real
 * outcome must supersede it in place once the execution returns.
 *
 * Reader contract, for a reader holding only the history:
 * - `claudeResult.resultPhase === 'provisional'` — execution-start marker. Never evidence of failure.
 * - `claudeResult.resultPhase === 'final'` — the execution returned; `success` is the real outcome.
 * - a genuine failure is `resultPhase: 'final'` with `success: false` (and a terminal failed entry).
 */
import { TaskStates } from '@propr/core';
import type { ClaudeResultPhase, ClaudeResultSummary, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';

/** The two records an execution can have. Runtime home of the phase labels. */
export const ClaudeResultPhases = {
    PROVISIONAL: 'provisional',
    FINAL: 'final',
} as const satisfies Record<string, ClaudeResultPhase>;

type ExecutionResultStateManager = Pick<WorkerStateManager, 'updateHistoryMetadata'>;

/** The start-time placeholder: an execution has begun and has not produced a result yet. */
export function provisionalClaudeExecutionResult(
    sessionId: string,
    conversationId?: string,
): ClaudeResultSummary {
    return { success: false, resultPhase: ClaudeResultPhases.PROVISIONAL, sessionId, conversationId };
}

/** The execution returned: this is its real outcome, whatever it was. */
export function finalClaudeExecutionResult(summary: ClaudeResultSummary): ClaudeResultSummary {
    return { ...summary, resultPhase: ClaudeResultPhases.FINAL };
}

/**
 * Supersedes any provisional placeholder on the `claude_execution` history entry with the
 * execution's real result, merging so correlation (admissionId/operationId/sessionId) and
 * container (containerId/containerName/worktreePath) metadata other consumers read survive.
 *
 * Returns the final summary so the caller records the same labelled value on the task itself.
 * Safe when no placeholder was ever written (container-first ordering, or no callback at all):
 * the merge simply adds the final result, and the caller's own terminal write still lands.
 */
export async function recordFinalClaudeExecutionResult(
    stateManager: ExecutionResultStateManager,
    taskId: string,
    summary: ClaudeResultSummary,
    correlatedLogger?: Logger,
): Promise<ClaudeResultSummary> {
    const claudeResult = finalClaudeExecutionResult(summary);
    try {
        await stateManager.updateHistoryMetadata(taskId, TaskStates.CLAUDE_EXECUTION, { claudeResult });
    } catch (error) {
        // Bookkeeping failure must not discard the execution; the caller still records the
        // final result on the task, and this entry keeps its self-declared provisional label.
        correlatedLogger?.warn({ error: (error as Error).message, taskId },
            'Failed to supersede provisional execution result on claude_execution history entry');
    }
    return claudeResult;
}

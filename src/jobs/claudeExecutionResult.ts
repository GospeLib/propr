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
 * - Failed final results carry `failureKind`: provider_error, usage_limit, timeout, max_turns,
 *   agent_error, or infrastructure. Older records may omit it; absence means unknown.
 * - `usageResetAt` is ISO-8601 and only accompanies usage_limit when the provider reports
 *   a reset/Retry-After. Absence gives no retry-time guarantee; readers must not infer one.
 * - Provisional and successful results carry neither failure field. Read the final correlated
 *   result before deciding whether to retry; these causes do not themselves authorize a retry.
 * - a genuine failure is `resultPhase: 'final'` with `success: false` (and a terminal failed entry).
 */
import { classifyExecutionFailure, ClaudeResultPhases, TaskStates } from '@propr/core';
import type { ClaudeResultSummary, WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';

/**
 * The two records an execution can have. The constants live in core, beside the
 * `ClaudeResultPhase` type and the durability barrier that reads them; this tree keeps the name
 * it has always imported.
 */
export { ClaudeResultPhases };

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
    const { failureKind, usageResetAt, ...rest } = summary;
    return { ...rest, resultPhase: ClaudeResultPhases.FINAL,
        ...(!summary.success ? classifyExecutionFailure({ ...summary, failureKind, usageResetAt,
            agentRan: !!summary.sessionId || summary.numTurns !== undefined || summary.finalOutput !== undefined,
        }) : {}),
    };
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

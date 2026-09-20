/**
 * The terminal task-state record for an issue job: status, PR/commit result, and the
 * truthful agent outcome plus any preserved partial-work checkpoint Ezer reads back.
 *
 * Kept free of database and plan-issue side effects so post-processing can write the
 * record for a stopped admitted execution before any destructive worktree cleanup.
 */
import { resolveAgentTerminationReason, ErrorCategories } from '@propr/core';
import type { ClaudeCodeResponse, CommitResult, UpdateMetadata, WorkerStateManager } from '@propr/core';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { buildAgentOutcome } from './executionOutcome.js';
import { finalClaudeExecutionResult } from './claudeExecutionResult.js';
import { publishCompletedWithDurableExecutionEvidence } from './completedExecutionDurability.js';

export function getTaskCompletionStatus(claudeResult: ClaudeCodeResponse | null, postProcessingResult: PostProcessingResult | null): string {
  if (postProcessingResult?.pr && claudeResult && resolveAgentTerminationReason(claudeResult)) {
    return 'partial_with_pr';
  }
  if (!claudeResult?.success) {
    return 'claude_processing_failed';
  }
  return postProcessingResult?.pr ? 'complete_with_pr' : 'claude_success_no_changes';
}

/** Truthful outcome and any preserved partial-work checkpoint, recorded on the terminal task entry. */
function buildTerminalEvidence(claudeResult: ClaudeCodeResponse | null, postProcessingResult: PostProcessingResult | null) {
  const executionCheckpoint = postProcessingResult?.executionCheckpoint;
  const retainedWorktreePath = postProcessingResult?.retainedWorktreePath;
  return {
    ...(claudeResult ? { agentOutcome: buildAgentOutcome(claudeResult) } : {}),
    ...(executionCheckpoint ? { executionCheckpoint } : {}),
    // The checkpoint push failed: name the retained local worktree (and its local commit,
    // already in executionCheckpoint.sha) so recovery can find the partial work.
    ...(retainedWorktreePath ? { retainedWorktreePath } : {}),
  };
}

/** Everything the completed entry must carry: the PR/commit record and the terminal evidence. */
function completionMetadata(
  claudeResult: ClaudeCodeResponse | null,
  taskResult: { prUrl?: string; prNumber?: number },
  commitResultData: { commitHash: string; commitMessage: string } | null,
  evidence: Record<string, unknown>,
): UpdateMetadata {
  const finalResult = claudeResult
    ? finalClaudeExecutionResult({
      success: claudeResult.success,
      sessionId: claudeResult.sessionId,
      conversationId: claudeResult.conversationId,
      executionTime: claudeResult.executionTime,
    })
    : undefined;
  return {
    reason: 'Task completed successfully',
    prResult: taskResult,
    ...(finalResult ? { claudeResult: finalResult } : {}),
    historyMetadata: {
      pr: (taskResult.prUrl && taskResult.prNumber) ? { number: taskResult.prNumber, url: taskResult.prUrl } : null,
      commitResult: commitResultData,
      ...evidence,
    },
  };
}

export interface TerminalStateParams {
  stateManager: WorkerStateManager;
  taskId: string;
  claudeResult: ClaudeCodeResponse | null;
  postProcessingResult: PostProcessingResult | null;
  commitResult: CommitResult | null;
}

export interface TerminalStatePolicy {
  /** Throw unless the terminal history entry is persisted to the database, not only Redis. */
  requireDurableHistory?: boolean;
}

export async function markTaskTerminalState(params: TerminalStateParams, policy: TerminalStatePolicy = {}): Promise<void> {
  const { stateManager, taskId, claudeResult, postProcessingResult, commitResult } = params;
  const status = getTaskCompletionStatus(claudeResult, postProcessingResult);
  const commitResultData = commitResult
    ? { commitHash: commitResult.commitHash, commitMessage: commitResult.commitMessage }
    : null;
  const evidence = buildTerminalEvidence(claudeResult, postProcessingResult);
  const taskResult = {
    status,
    claudeSuccess: claudeResult?.success || false,
    prCreated: !!postProcessingResult?.pr,
    prNumber: postProcessingResult?.pr?.number ?? undefined,
    prUrl: postProcessingResult?.pr?.url ?? undefined,
    commitResult: commitResultData,
    ...evidence
  };

  if (status === 'claude_processing_failed') {
    await stateManager.markTaskFailed(
      taskId,
      new Error(claudeResult?.error || 'Agent processing failed'),
      {
        errorCategory: ErrorCategories.CLAUDE_EXECUTION,
        prResult: taskResult,
        historyMetadata: {
          pr: (taskResult.prUrl && taskResult.prNumber)
            ? { number: taskResult.prNumber, url: taskResult.prUrl }
            : null,
          commitResult: commitResultData,
          // Terminal evidence Ezer reads from the failed history entry.
          ...evidence
        },
        ...(policy.requireDurableHistory ? { requireDurableHistory: true } : {}),
      }
    );
    return;
  }

  if (policy.requireDurableHistory) throw Error('DURABLE_TERMINAL_STATE_ONLY_FOR_FAILED_EXECUTION');
  // `completed` is published only once this evidence is durable, and the evidence rides on the
  // completed entry itself so the two cannot come apart. See completedExecutionDurability.ts.
  await publishCompletedWithDurableExecutionEvidence({
    stateManager,
    taskId,
    metadata: completionMetadata(claudeResult, taskResult, commitResultData, evidence),
  });
}

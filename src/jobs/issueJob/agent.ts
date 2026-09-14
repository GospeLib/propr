import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const typedGit = promisify(execFile);
/**
 * Agent execution for GitHub issue job.
 */

import {
  TaskStates, AgentRegistry, generateClaudePrompt, updateFileChangesFromWorktree, recordLLMMetrics,
  resolveAgentTerminationReason
} from '@propr/core';
import type { AgentExecutionResult, ClaudeCodeResponse, ClaudeResult } from '@propr/core';
import type { ExecutionParams, JobContext } from './types.js';
import { localizeContentImages } from '../issueJobHelpers.js';
import {
  createSessionIdCallback,
  createContainerIdCallback,
  deriveVerifiedExecutionCorrelation,
  startFileChangesMonitor,
} from '../issueJobCallbacks.js';
import { redisClient } from './config.js';
import { buildAdmittedWorkerEnvironment } from '../ezerAdmittedWorkerEnvironment.js';
import { verifyConfiguredEzerAdmission } from '../ezerExecutionAdmission.js';

export function toClaudeResult(response: AgentExecutionResult): ClaudeResult {
  return {
    model: response.modelUsed,
    success: response.success,
    executionTime: response.executionTimeMs,
    sessionId: response.sessionId,
    conversationId: response.conversationId,
    finalResult: response.summary ? { type: 'result', result: response.summary } : null,
    conversationLog: response.conversationLog,
    error: response.error,
    terminationReason: response.terminationReason,
    tokenUsage: response.tokenUsage
  };
}

/**
 * Converts AgentExecutionResult to ClaudeCodeResponse for backwards compatibility
 * with existing post-processing code.
 */
export function agentResultToClaudeResponse(result: AgentExecutionResult): ClaudeCodeResponse {
  const terminationReason = resolveAgentTerminationReason(result);
  return {
    success: result.success,
    model: result.modelUsed,
    ...(result.reasoningLevel && { reasoningLevel: result.reasoningLevel }),
    executionTime: result.executionTimeMs,
    output: null,
    sessionId: result.sessionId || null,
    conversationId: result.conversationId,
    finalResult: result.summary || terminationReason === 'max_turns'
      ? { type: 'result', result: result.summary, subtype: terminationReason === 'max_turns' ? 'error_max_turns' : undefined }
      : null,
    rawOutput: result.rawOutput,
    summary: result.summary || null,
    logs: result.logs,
    exitCode: result.exitCode ?? null,
    error: result.error,
    terminationReason,
    modifiedFiles: result.modifiedFiles,
    commitMessage: result.commitMessage || null,
    conversationLog: result.conversationLog,
    tokenUsage: result.tokenUsage,
    usageMetrics: result.usageMetrics
  };
}

export async function executeAgentAndRecordMetrics(executionParams: ExecutionParams, context: JobContext): Promise<ClaudeCodeResponse> {
  const { worktreeInfo, issueRef, githubToken, currentIssueData, issueComments } = executionParams;
  const { taskId, agentAlias, modelName, stateManager, correlatedLogger, correlationId } = context;

  // Get the agent from registry
  const registry = AgentRegistry.getInstance();
  const agent = registry.getAgentByAlias(agentAlias);

  if (!agent) {
    throw new Error(`Agent not found: ${agentAlias}`);
  }

  correlatedLogger.info({
    agentAlias,
    agentType: agent.config.type,
    modelName,
    issueNumber: issueRef.number,
    reasoningLevel: issueRef.reasoningLevel
  }, 'Executing task with agent');
  const agentIssueRef = {
    number: issueRef.number,
    repoOwner: issueRef.repoOwner,
    repoName: issueRef.repoName
  };
  // Localize remote images in issue body and comments
  const issueBodyHtml = (currentIssueData.data as { body_html?: string }).body_html;
  const localizedBody = currentIssueData.data.body
    ? await localizeContentImages(currentIssueData.data.body, worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: issueBodyHtml, issueOrPrId: issueRef.number })
    : undefined;

  const localizedComments = await Promise.all(
    issueComments.map(async (comment) => ({
      ...comment,
      body: comment.body ? await localizeContentImages(comment.body, worktreeInfo.worktreePath, correlatedLogger, { bodyHtml: comment.body_html, issueOrPrId: issueRef.number }) : comment.body
    }))
  );

  // Build prompt for the agent
  const prompt = generateClaudePrompt({
    issueRef: agentIssueRef,
    branchName: worktreeInfo.branchName,
    modelName,
    issueDetails: {
      title: currentIssueData.data.title,
      body: localizedBody,
      comments: localizedComments,
      labels: currentIssueData.data.labels,
      created_at: currentIssueData.data.created_at,
      user: currentIssueData.data.user
    },
    baseBranch: issueRef.baseBranch || null
  });

  const typed = context.typedInvestigation;
  const storyPrompt = context.storyExecution
    ? `${prompt}\n\nEzer signed story execution contract: ${JSON.stringify(context.storyExecution)}. Only edit the exact allowedPaths. Keep the admitted base and branch unchanged. Run repository checks inside this sandbox and report their actual results; never bypass checks or claim unrun validation. Leave commit, push, and PR publication to ProPR. Do not merge or approve anything.`
    : prompt;
  if(typed?.provider&&agent.config.type!==typed.provider)throw new Error('TYPED_PROVIDER_ROUTE_MISMATCH');
  if(typed?.model&&modelName!==typed.model)throw new Error('TYPED_MODEL_ROUTE_MISMATCH');
  const deadline = typed?.deadline ?? context.executionDeadline;
  if (context.storyExecution && !deadline) throw new Error('STORY_EXECUTION_DEADLINE_REQUIRED');
  let remainingMs = deadline ? Date.parse(deadline) - Date.now() : undefined;
  if (remainingMs !== undefined && (!Number.isFinite(remainingMs) || remainingMs <= 0)) throw new Error('EXECUTION_DEADLINE_EXCEEDED');
  const typedBase = typed ? (await typedGit('git',['rev-parse','HEAD'],{cwd:worktreeInfo.worktreePath})).stdout.trim() : undefined;
  // Preparation may fail without spending authority. Atomic receipt consumption is the final
  // gate before invoking the configured agent; missing/expired receipts never reach it.
  if (context.ezerAdmissionPrepared) {
    context.ezerAdmissionVerified = await verifyConfiguredEzerAdmission(issueRef,
      binding => { if (JSON.stringify(binding) !== JSON.stringify(context.typedInvestigation)) throw new Error('PREPARED_TYPED_AUTHORITY_CHANGED'); },
      binding => { if (JSON.stringify(binding) !== JSON.stringify(context.storyExecution)) throw new Error('PREPARED_STORY_AUTHORITY_CHANGED'); },
      value => { if (value !== context.executionDeadline) throw new Error('PREPARED_EXECUTION_DEADLINE_CHANGED'); });
    if (!context.ezerAdmissionVerified) throw new Error('ezer-execution-admission-refused:protection-changed');
  }
  remainingMs = deadline ? Date.parse(deadline) - Date.now() : undefined;
  if (remainingMs !== undefined && remainingMs <= 0) throw new Error('EXECUTION_DEADLINE_EXCEEDED');
  const admittedWorkerEnvironment = buildAdmittedWorkerEnvironment(
    issueRef,
    taskId,
    context.ezerAdmissionVerified,
  );
  const verifiedExecutionCorrelation = deriveVerifiedExecutionCorrelation(
    context.ezerAdmissionVerified,
    issueRef.executionAdmissionReceipt,
  );
  // Execute task via agent abstraction
  const stopFileChanges = startFileChangesMonitor(
    signal => updateFileChangesFromWorktree(taskId, worktreeInfo.worktreePath, signal),
    error => correlatedLogger.debug({ error: (error as Error).message }, 'Periodic file changes update failed'),
  );
  let agentResult;
  try {
    agentResult = await agent.executeTask({
      worktreePath: worktreeInfo.worktreePath,
      issueRef: agentIssueRef,
      prompt: typed ? `${prompt}\n\nEzer signed typed investigation: ${typed.kind}; item ${typed.itemId}. This is NOT implementation authority. Only create ${typed.outputPath}, the ${typed.outputKind}. Use the required artifact sections stated in the admitted issue; recommendations are not owner decisions. Do not change any other file, merge, approve, or claim a unit outcome. Deadline ${typed.deadline}.` : storyPrompt,
      timeoutMs: remainingMs,
      disableOptionalStorybookMcp: Boolean(typed) && agent.config.type === 'codex' && process.env.PROPR_TYPED_STORYBOOK_MCP_UNAVAILABLE === 'true',
      model: modelName,
      githubToken: githubToken.token,
      branchName: worktreeInfo.branchName,
      environment: admittedWorkerEnvironment,
      reasoningLevel: issueRef.reasoningLevel,
      onSessionId: createSessionIdCallback(taskId, issueRef, {
        modelName,
        stateManager,
        correlatedLogger,
        redisClient,
        verifiedExecutionCorrelation,
      }),
      onContainerId: createContainerIdCallback(taskId, stateManager, correlatedLogger, worktreeInfo.worktreePath, verifiedExecutionCorrelation),
      taskId
    });
  } finally {
    await stopFileChanges();
  }

  // Check if task was cancelled during execution
  const currentState = await stateManager.getTaskState(taskId);
  const TERMINAL_STATES: string[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
  if (currentState && TERMINAL_STATES.includes(currentState.state)) {
    correlatedLogger.info({ taskId, currentState: currentState.state }, 'Task already in terminal state after agent execution, skipping state update');
    if (currentState.state === TaskStates.CANCELLED) {
      throw new Error('Execution aborted by user request');
    }
    throw new Error(`Task already in terminal state: ${currentState.state}`);
  }


  if (typed && typedBase) {
    if (Date.parse(typed.deadline) <= Date.now()) throw new Error('TYPED_DEADLINE_EXCEEDED');
    const changed = await typedGit('git',['diff','--name-only',typedBase,'--'],{cwd:worktreeInfo.worktreePath});
    const untracked = await typedGit('git',['ls-files','--others','--exclude-standard'],{cwd:worktreeInfo.worktreePath});
    const paths = [...new Set(`${changed.stdout}\n${untracked.stdout}`.split('\n').filter(Boolean))];
    if (paths.length === 0) throw new Error(`TYPED_OUTPUT_MISSING: ${agentResult.error || agentResult.summary || 'Provider returned without the required artifact.'}`);
    if (paths.length !== 1 || paths[0] !== typed.outputPath) throw new Error('TYPED_OUTPUT_SCOPE_VIOLATION');
  }
  // Convert to ClaudeCodeResponse for backwards compatibility
  const claudeResult = agentResultToClaudeResponse(agentResult);


  await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
    reason: `${agent.config.type} agent execution completed`,
    claudeResult: { success: claudeResult.success, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
    historyMetadata: {
      sessionId: claudeResult.sessionId,
      conversationId: claudeResult.conversationId,
      model: claudeResult.model,
      ...verifiedExecutionCorrelation,
    }
  });

  await recordLLMMetrics(toClaudeResult(agentResult), { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName }, { jobType: 'issue', correlationId, taskId });

  correlatedLogger.info({
    agentAlias,
    success: agentResult.success,
    executionTimeMs: agentResult.executionTimeMs,
    modelUsed: agentResult.modelUsed
  }, 'Agent execution completed');

  // Capture file changes after execution
  try {
    const fileChanges = await updateFileChangesFromWorktree(taskId, worktreeInfo.worktreePath);
    correlatedLogger.debug({ taskId, fileCount: fileChanges.length }, 'Captured file changes after agent execution');
  } catch (fileChangesError) {
    correlatedLogger.warn({ error: (fileChangesError as Error).message }, 'Failed to capture file changes');
  }

  return claudeResult;
}

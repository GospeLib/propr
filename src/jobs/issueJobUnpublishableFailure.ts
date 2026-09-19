/**
 * The unpublishable-agent-failure and stopped-admitted-execution paths: what happens
 * when an agent run produces nothing worth publishing, or when post-processing itself
 * fails after the agent succeeded. Split out of issueJobPostProcessing.ts (INV-4) —
 * behavior is unchanged, only the module boundary moved.
 */
import type { Logger } from 'pino';
import type { ClaudeCodeResponse } from '@propr/core';
import { preserveExecutionCheckpoint, resolveRepositoryGitDir, type ExecutionCheckpointRecord, type StoryExecutionContract } from '@propr/core';
import type { WorktreeInfo, WorkerStateManager } from '@propr/core';
import { resolveAgentTerminationReason } from '@propr/core';
import { safeUpdateLabels } from '@propr/core';
import { generateCompletionComment } from '@propr/core';
import { redactSecrets } from '@propr/core';
import type { RepoValidationResult, PRValidationResult } from '@propr/core';
import type { IssueJobData } from '@propr/core';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { handleNoCodeChanges } from './issueJobPostProcessingHelpers.js';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import type { GitHubToken } from './githubTypes.js';
import { classifyExecutionFailure } from './executionOutcome.js';
import { markTaskTerminalState } from './terminalTaskState.js';
import { saveRetainedCheckpoint } from './checkpointRetentionStore.js';

export function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function formatErrorBlock(title: string, message: string): string {
    const redacted = redactSecrets(message || 'Unknown error').slice(0, 4000);
    return `**${title}:**\n${redacted}\n\n`;
}

export function hasPublishableAgentWork(claudeResult: ClaudeCodeResponse | null): boolean {
    if (!claudeResult) return false;
    return claudeResult.success || resolveAgentTerminationReason(claudeResult) !== undefined;
}

export type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

export interface PostProcessOptions {
    execution?: StoryExecutionContract;
    octokit: Octokit;
    issueRef: IssueJobData;
    worktreeInfo: WorktreeInfo;
    currentIssueData: { data: { title: string; labels: Array<{ name: string }> } };
    claudeResult: ClaudeCodeResponse;
    modelName: string;
    repoValidation: RepoValidationResult;
    repoUrl: string;
    githubToken: GitHubToken;
    PR_LABEL: string;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    jobId: string | undefined;
    correlatedLogger: Logger;
    taskId?: string;
    stateManager?: WorkerStateManager;
}

export async function handleUnpublishableAgentFailure(options: {
    internalRecovery?: boolean;
    octokit: Octokit;
    issueRef: IssueJobData;
    claudeResult: ClaudeCodeResponse;
    AI_PROCESSING_TAG: string;
    correlatedLogger: Logger;
}): Promise<PostProcessingResult> {
    const { octokit, issueRef, claudeResult, AI_PROCESSING_TAG, correlatedLogger } = options;
    const errorMessage = claudeResult.error?.trim() || 'The coding agent stopped before producing publishable work.';

    correlatedLogger.warn({ issueNumber: issueRef.number, error: redactSecrets(errorMessage) }, 'Agent execution failed without publishable work');
    const labelUpdate = await safeUpdateLabels(
        { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
        [AI_PROCESSING_TAG],
        [],
    );
    if (!labelUpdate.success) {
        const details = labelUpdate.errors.length > 0 ? `: ${labelUpdate.errors.join('; ')}` : '';
        throw new Error(`Failed to remove the processing label from issue #${issueRef.number}${details}`);
    }

    if (options.internalRecovery) return { success: false, pr: null, updatedLabels: [], error: errorMessage };
    const completionComment = await generateCompletionComment(claudeResult, {
        number: issueRef.number,
        repoOwner: issueRef.repoOwner,
        repoName: issueRef.repoName,
    }, { publishedAs: 'issue_comment' });
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner: issueRef.repoOwner,
        repo: issueRef.repoName,
        issue_number: issueRef.number,
        body: `❌ **AI processing failed before producing publishable work.**\n\n${formatErrorBlock('System Error', errorMessage)}${completionComment}`,
    });

    return { success: false, pr: null, updatedLabels: [], error: errorMessage };
}

function formatFallbackDiagnostics(claudeResult: ClaudeCodeResponse, postProcessingError: unknown): string {
    const systemError = claudeResult?.success === false ? claudeResult.error?.trim() : '';
    const postProcessingMessage = getErrorMessage(postProcessingError).trim();
    let diagnostics = '';

    if (systemError) {
        diagnostics += formatErrorBlock('System Error', systemError);
    }

    if (postProcessingMessage && postProcessingMessage !== systemError) {
        diagnostics += formatErrorBlock('Post-processing Error', postProcessingMessage);
    }

    return diagnostics;
}

export async function handlePostProcessingFailure(
    options: PostProcessOptions,
    postProcessingError: unknown,
    canMarkDone = hasPublishableAgentWork(options.claudeResult),
): Promise<PostProcessingResult> {
    const { octokit, issueRef, claudeResult, AI_PROCESSING_TAG, AI_DONE_TAG, jobId, correlatedLogger } = options;

    correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (postProcessingError as Error).message }, 'Deterministic post-processing failed');

    try {
        const completedLabels = canMarkDone ? [AI_DONE_TAG] : [];
        await safeUpdateLabels({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, [AI_PROCESSING_TAG], completedLabels);
        const completionComment = await generateCompletionComment(
            claudeResult,
            { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName },
            { publishedAs: 'issue_comment' },
        );
        const fallbackHeading = canMarkDone
            ? '⚠️ **Post-processing encountered an error, but ProPR analysis was completed.**'
            : '❌ **AI processing failed before producing publishable work.**';
        await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
            owner: issueRef.repoOwner, repo: issueRef.repoName, issue_number: issueRef.number,
            body: `${fallbackHeading}\n\n${formatFallbackDiagnostics(claudeResult, postProcessingError)}${completionComment}`,
        });
        return { success: false, pr: null, updatedLabels: completedLabels, error: (postProcessingError as Error).message };
    } catch (fallbackError) {
        correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (fallbackError as Error).message }, 'Fallback post-processing also failed');
        return { success: false, pr: null, updatedLabels: [], error: (postProcessingError as Error).message };
    }
}

export async function handleMissingCommit(options: PostProcessOptions): Promise<PostProcessingResult> {
    const { octokit, issueRef, claudeResult, currentIssueData, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger } = options;
    if (claudeResult.success) {
        return handleNoCodeChanges({
            octokit,
            issueRef,
            claudeResult,
            currentIssueData,
            AI_PROCESSING_TAG,
            AI_DONE_TAG,
            correlatedLogger,
        });
    }

    return handleUnpublishableAgentFailure({
        octokit,
        issueRef,
        claudeResult,
        AI_PROCESSING_TAG,
        correlatedLogger,
    });
}

/** Error carrying the checkpoint already preserved when later failure handling throws. */
export type ErrorWithExecutionCheckpoint = Error & {
    executionCheckpoint?: ExecutionCheckpointRecord;
    /** Set when the checkpoint push failed; the worktree at this path must be retained. */
    retainedWorktreePath?: string;
};

/**
 * Hands the retained worktree to the recurring checkpoint-retention reconciler, which
 * retries publication and bounds retained disk. Registration failure is logged, never
 * thrown: the checkpoint commit is already pinned locally and cleanup still retains.
 */
async function registerRetainedWorktree(taskId: string, worktreeInfo: WorktreeInfo, correlatedLogger: Logger): Promise<void> {
    try {
        await saveRetainedCheckpoint({
            taskId, worktreePath: worktreeInfo.worktreePath, branchName: worktreeInfo.branchName,
            gitDir: await resolveRepositoryGitDir(worktreeInfo.worktreePath),
            retainedAt: new Date().toISOString(), publishAttempts: 0,
        });
    } catch (error) {
        correlatedLogger.error({ taskId, worktreePath: worktreeInfo.worktreePath, error: getErrorMessage(error) },
            'Could not register retained checkpoint worktree for reconciliation');
    }
}

/**
 * Preserves a stopped admitted execution's partial work, then durably records the failed
 * terminal task entry naming that checkpoint BEFORE anything else can fail or the worktree
 * is removed. Label updates and cleanup come after, so a crash past this point can never
 * leave a pushed checkpoint ref that Ezer has no record of.
 */
export async function handleStoppedAdmittedExecution(options: PostProcessOptions, execution: StoryExecutionContract): Promise<PostProcessingResult> {
    const { octokit, issueRef, worktreeInfo, claudeResult, repoUrl, githubToken, AI_PROCESSING_TAG, correlatedLogger, taskId, stateManager } = options;
    // Without a task record there is nowhere durable to name a checkpoint; never push an orphan.
    if (!taskId || !stateManager) throw Error('STORY_EXECUTION_TERMINAL_STATE_UNAVAILABLE');
    const executionCheckpoint = await preserveExecutionCheckpoint({
        worktreePath: worktreeInfo.worktreePath,
        execution,
        taskId,
        failureClassification: classifyExecutionFailure(claudeResult),
        author: AI_COMMIT_AUTHOR,
        repoUrl,
        authToken: githubToken.token,
    });
    const log = executionCheckpoint.status === 'failed' ? correlatedLogger.error.bind(correlatedLogger) : correlatedLogger.info.bind(correlatedLogger);
    log({ issueNumber: issueRef.number, executionCheckpoint }, 'Admitted execution stopped before success; partial work checkpoint recorded');
    // The checkpoint push failed: the local worktree at this path is the only surviving
    // copy of the partial work. Cleanup must retain it, and recovery must be able to find
    // it, regardless of what happens past this point.
    const retainedWorktreePath = executionCheckpoint.status === 'failed' ? worktreeInfo.worktreePath : undefined;
    if (retainedWorktreePath) await registerRetainedWorktree(taskId, worktreeInfo, correlatedLogger);
    const stopped: PostProcessingResult = {
        success: false, pr: null, updatedLabels: [], executionCheckpoint,
        ...(retainedWorktreePath ? { retainedWorktreePath } : {}),
    };
    try {
        await markTaskTerminalState({ stateManager, taskId, claudeResult, postProcessingResult: stopped, commitResult: null },
            { requireDurableHistory: true });
    } catch (error) {
        (error as ErrorWithExecutionCheckpoint).executionCheckpoint = executionCheckpoint;
        (error as ErrorWithExecutionCheckpoint).retainedWorktreePath = retainedWorktreePath;
        throw error;
    }
    try {
        const result = await handleUnpublishableAgentFailure({
            internalRecovery: true, octokit, issueRef, claudeResult, AI_PROCESSING_TAG, correlatedLogger,
        });
        return { ...result, executionCheckpoint, terminalStateRecorded: true, ...(retainedWorktreePath ? { retainedWorktreePath } : {}) };
    } catch (error) {
        (error as ErrorWithExecutionCheckpoint).executionCheckpoint = executionCheckpoint;
        (error as ErrorWithExecutionCheckpoint).retainedWorktreePath = retainedWorktreePath;
        throw error;
    }
}

export type { RepoValidationResult, PRValidationResult };

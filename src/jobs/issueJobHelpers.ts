import type { Logger } from 'pino';
import {
    db,
    getModelShortName,
    MODEL_INFO_MAP,
    buildAgentModelLlmLabel,
    getAgentTypeFromModel,
    isEpicBranch,
    resolveAgentTerminationReason,
} from '@propr/core';
export { localizeContentImages, cleanupIssueAssets, type LocalizeContentImagesOptions } from './contentUtils.js';
export {
    calculateUsageLimitDelay,
    handleSimpleUsageLimitError,
    handleUsageLimitError,
    handleGenericError,
    type UsageLimitError,
    type GenericErrorOptions
} from './errorHandlers.js';
import type { ClaudeCodeResponse, IssueJobData, JobResult, WorkerStateManager, WorktreeInfo, CommitResult, RepoValidationResult } from '@propr/core';

export type RepoValidation = RepoValidationResult;

export { createPullRequest } from './issueJobPRCreation.js';

export const REQUEUE_BUFFER_MS = parseInt(process.env.REQUEUE_BUFFER_MS || String(5 * 60 * 1000), 10);
export const REQUEUE_JITTER_MS = parseInt(process.env.REQUEUE_JITTER_MS || String(2 * 60 * 1000), 10);

// Re-export getModelShortName for consumers that import from this file
export { getModelShortName };

export interface PostProcessingResult {
    success: boolean;
    pr: {
        number: number;
        url: string;
        title: string;
    } | null;
    updatedLabels: string[];
    error?: string;
    /** Admitted execution stopped before success: its partial work, never a publication. */
    executionCheckpoint?: import('@propr/core').ExecutionCheckpointRecord;
    /** The failed terminal task record (with any checkpoint) is already durably persisted. */
    terminalStateRecorded?: boolean;
    /**
     * Set when the checkpoint push failed: the local worktree holds the only surviving
     * copy of the partial work, so cleanup must retain it rather than delete it. Recorded
     * on the terminal task entry so a later recovery can find it.
     */
    retainedWorktreePath?: string;
}

export type Octokit = {
    request: <T = unknown>(endpoint: string, options: Record<string, unknown>) => Promise<T>;
};

export function buildIssueReference(
    issueNumber: number,
    hasCommit: boolean,
    claudeResult: ClaudeCodeResponse | null
): string {
    const incompleteExecution = claudeResult ? resolveAgentTerminationReason(claudeResult) : undefined;
    return hasCommit && !incompleteExecution ? `Closes #${issueNumber}` : `Addresses #${issueNumber}`;
}

export function getPullRequestModelLabel(
    issueRef: Pick<IssueJobData, 'agentAlias' | 'modelLabel'>,
    modelName: string
): string | null {
    const modelInfo = MODEL_INFO_MAP[modelName];
    if (modelInfo && issueRef.agentAlias) {
        return buildAgentModelLlmLabel(
            getAgentTypeFromModel(modelName),
            issueRef.agentAlias,
            modelInfo
        );
    }
    if (issueRef.modelLabel?.startsWith('llm-')) return issueRef.modelLabel;
    return modelInfo?.githubLabel || null;
}

export async function updateTaskTitleInStorage(
    taskId: string,
    issueRef: IssueJobData,
    stateManager: WorkerStateManager,
    correlatedLogger: Logger
): Promise<void> {
    try {
        await db('tasks')
            .where({ task_id: taskId })
            .update({ initial_job_data: JSON.stringify(issueRef) });
        correlatedLogger.info({ taskId, title: issueRef.title }, 'Updated task with title/subtitle in DB');
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to update task with title/subtitle in DB');
    }
    try {
        const state = await stateManager.getTaskState(taskId);
        if (state) {
            state.issueRef = { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName };
            await stateManager.updateTaskState(taskId, state.state, {
                reason: 'Updated task title/subtitle',
                historyMetadata: { title: issueRef.title, subtitle: issueRef.subtitle }
            });
            correlatedLogger.info({ taskId, title: issueRef.title }, 'Updated task with title/subtitle in Redis');
        }
    } catch (redisError) {
        correlatedLogger.warn({ taskId, error: (redisError as Error).message }, 'Failed to update task with title/subtitle in Redis');
    }
}

/**
 * Ensure a child PR's base branch exists before creating the PR.
 *
 * Epic base branches (ProPR-managed, e.g. `187-epic-modernize-and-n7j`) can be
 * deleted after their Epic PR is closed. On a rerun the child issue still
 * carries the `base-<branch>` label, so the child PR targets a branch that no
 * longer exists and GitHub rejects it with
 * `{"field":"base","code":"invalid"}`. Recreate the missing epic base branch
 * from the repository default branch so the child PR can be created again.
 *
 * Only ProPR epic branches are auto-created — a missing user-specified base
 * (e.g. a typo'd `base-develop`) is left to fail loudly rather than silently
 * fabricating a branch.
 */
export interface EnsureEpicBaseBranchOptions {
    owner: string;
    repo: string;
    baseBranch: string;
    defaultBranch: string | undefined;
    correlatedLogger: Logger;
}

export async function ensureEpicBaseBranchExists(
    octokit: Octokit,
    options: EnsureEpicBaseBranchOptions
): Promise<void> {
    const { owner, repo, baseBranch, defaultBranch, correlatedLogger } = options;
    if (!isEpicBranch(baseBranch)) return;

    try {
        await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${baseBranch}` });
        return; // Base branch already exists.
    } catch (error) {
        if ((error as { status?: number }).status !== 404) throw error;
    }

    const source = defaultBranch || 'main';
    const sourceRef = await octokit.request<{ data: { object: { sha: string } } }>('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner, repo, ref: `heads/${source}`
    });
    const sha = sourceRef.data.object.sha;

    try {
        await octokit.request('POST /repos/{owner}/{repo}/git/refs', { owner, repo, ref: `refs/heads/${baseBranch}`, sha });
        correlatedLogger.info({ baseBranch, source, sha }, 'Recreated missing epic base branch from default branch before PR creation');
    } catch (error) {
        const err = error as Error & { status?: number };
        // Concurrent job created it first — that's fine.
        if (err.status === 422 && err.message?.includes('Reference already exists')) {
            correlatedLogger.info({ baseBranch }, 'Epic base branch already recreated by a concurrent job');
            return;
        }
        throw error;
    }
}

interface FinalResultResults {
    worktreeInfo: WorktreeInfo | undefined;
    claudeResult: ClaudeCodeResponse | null;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
}

function determineResultStatus(claudeResult: ClaudeCodeResponse | null, postProcessingResult: PostProcessingResult | null): string {
    if (!claudeResult?.success) return 'claude_processing_failed';
    if (postProcessingResult?.pr) return 'complete_with_pr';
    return 'claude_success_no_changes';
}

function buildClaudeResultSection(claudeResult: ClaudeCodeResponse | null): { success: boolean } {
    return {
        success: claudeResult?.success ?? false,
        executionTime: claudeResult?.executionTime ?? 0,
        modifiedFiles: claudeResult?.modifiedFiles ?? [],
        conversationLog: claudeResult?.conversationLog ?? [],
        error: claudeResult?.error ?? null,
        sessionId: claudeResult?.sessionId ?? null,
        conversationId: claudeResult?.conversationId ?? null,
        model: claudeResult?.model ?? null,
        tokenUsage: claudeResult?.tokenUsage ?? null
    } as { success: boolean };
}

function buildPostProcessingSection(postProcessingResult: PostProcessingResult | null): { success: boolean; pr: PostProcessingResult['pr']; updatedLabels: string[] } {
    return {
        success: postProcessingResult?.success ?? false,
        pr: postProcessingResult?.pr ?? null,
        updatedLabels: postProcessingResult?.updatedLabels ?? []
    };
}

export function buildFinalResult(issueRef: IssueJobData, localRepoPath: string, results: FinalResultResults): JobResult {
    const { worktreeInfo, claudeResult, postProcessingResult } = results;
    return {
        status: determineResultStatus(claudeResult, postProcessingResult),
        issueNumber: issueRef.number,
        repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
        gitSetup: { localRepoPath, worktreeCreated: !!worktreeInfo, branchName: worktreeInfo?.branchName },
        claudeResult: buildClaudeResultSection(claudeResult),
        postProcessing: buildPostProcessingSection(postProcessingResult)
    };
}

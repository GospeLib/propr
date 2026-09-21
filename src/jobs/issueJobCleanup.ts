import type { Logger } from 'pino';
import type { ClaudeCodeResponse } from '@propr/core';
import { cleanupWorktree } from '@propr/core';
import type { WorktreeInfo, CommitResult } from '@propr/core';
import type { RepoValidationResult } from '@propr/core';
import type { IssueJobData } from '@propr/core';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { handlePRValidation } from './issueJobPRValidation.js';
import { isRetainedCheckpointWorktree } from './checkpointRetentionStore.js';

type RepoValidation = RepoValidationResult;

export interface CleanupOptions {
    worktreeInfo: WorktreeInfo | undefined;
    localRepoPath: string;
    claudeResult: ClaudeCodeResponse | null | undefined;
    postProcessingResult: PostProcessingResult | null;
    jobId: string | undefined;
    issueRef: IssueJobData;
    correlatedLogger: Logger;
}

export async function cleanupWorktreeIfExists(options: CleanupOptions): Promise<void> {
    const { worktreeInfo, localRepoPath, claudeResult, postProcessingResult, jobId, issueRef, correlatedLogger } = options;
    if (!worktreeInfo) return;

    // A failed checkpoint push hands the worktree to the checkpoint-retention reconciler: it
    // is never deleted here, regardless of WORKTREE_RETENTION_STRATEGY. The registry check
    // also covers error paths where no post-processing result reached this point.
    try {
        const retain = postProcessingResult?.executionCheckpoint?.status === 'failed' ||
            await isRetainedCheckpointWorktree(worktreeInfo.worktreePath);
        const wasSuccessful = claudeResult?.success && postProcessingResult?.pr;
        await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
            deleteBranch: !wasSuccessful, success: !!wasSuccessful,
            retentionStrategy: process.env.WORKTREE_RETENTION_STRATEGY || 'always_delete',
            retain,
        });
        if (retain) {
            correlatedLogger.warn({ jobId, issueNumber: issueRef.number, worktreePath: worktreeInfo.worktreePath },
                'Retained worktree: checkpoint not yet published; the checkpoint-retention reconciler owns it');
        }
    } catch (cleanupError) {
        correlatedLogger.warn({ jobId, issueNumber: issueRef.number, error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
    }
}

export interface FinalValidationOptions {
    claudeResult: ClaudeCodeResponse | undefined;
    worktreeInfo: WorktreeInfo | undefined;
    issueRef: IssueJobData;
    octokit: import('./issueJobUnpublishableFailure.js').Octokit;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    repoValidation: RepoValidation;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    localRepoPath: string;
    jobId: string | undefined;
    correlationId: string;
    correlatedLogger: Logger;
}

export async function performFinalValidation(options: FinalValidationOptions): Promise<void> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, localRepoPath, jobId, correlationId, correlatedLogger } = options;
    let resolvedPostProcessingResult = postProcessingResult;

    if (claudeResult?.success && worktreeInfo?.branchName) {
        try {
            resolvedPostProcessingResult = await handlePRValidation({ claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger, jobId });
        } catch (validationError) {
            correlatedLogger.error({ jobId, issueNumber: issueRef.number, error: (validationError as Error).message }, 'Final PR validation failed');
        }
    }

    await cleanupWorktreeIfExists({ worktreeInfo, localRepoPath, claudeResult, postProcessingResult: resolvedPostProcessingResult, jobId, issueRef, correlatedLogger });
}

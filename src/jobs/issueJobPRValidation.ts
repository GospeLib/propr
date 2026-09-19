import type { Logger } from 'pino';
import type { ClaudeCodeResponse } from '@propr/core';
import type { WorktreeInfo, CommitResult } from '@propr/core';
import { validatePRCreation } from '@propr/core';
import { getAuthenticatedOctokit, linkPRToPlanIssue } from '@propr/core';
import { safeUpdateLabels } from '@propr/core';
import type { RepoValidationResult, PRValidationResult } from '@propr/core';
import type { IssueJobData } from '@propr/core';
import type { PostProcessingResult } from './issueJobHelpers.js';
import { hasPublishableAgentWork, type Octokit } from './issueJobUnpublishableFailure.js';

type RepoValidation = RepoValidationResult;
type PRValidation = PRValidationResult;

export interface PRValidationOptions {
    claudeResult: ClaudeCodeResponse | null;
    worktreeInfo: WorktreeInfo | undefined;
    issueRef: IssueJobData;
    octokit: Octokit;
    postProcessingResult: PostProcessingResult | null;
    commitResult: CommitResult | null;
    repoValidation: RepoValidation;
    AI_PROCESSING_TAG: string;
    AI_DONE_TAG: string;
    correlationId: string;
    correlatedLogger: Logger;
    jobId: string | undefined;
}

export async function handlePRValidation(options: PRValidationOptions): Promise<PostProcessingResult | null> {
    const { claudeResult, worktreeInfo, issueRef, octokit, postProcessingResult, commitResult, repoValidation, AI_PROCESSING_TAG, AI_DONE_TAG, correlationId, correlatedLogger } = options;

    if (!worktreeInfo) return postProcessingResult;

    const finalPRValidation: PRValidation = await validatePRCreation({
        owner: issueRef.repoOwner, repoName: issueRef.repoName,
        branchName: worktreeInfo.branchName, expectedPrNumber: postProcessingResult?.pr?.number, correlationId
    });

    if (finalPRValidation.isValid && !postProcessingResult?.pr) {
        await safeUpdateLabels({ octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger }, [AI_PROCESSING_TAG], [AI_DONE_TAG]);

        // Link PR to plan issue if found during validation
        if (finalPRValidation.pr?.number) {
            const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
            await linkPRToPlanIssue(repository, issueRef.number, finalPRValidation.pr.number);
            correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber: finalPRValidation.pr.number }, 'Linked PR to plan issue (found during validation)');
        }

        return { success: true, pr: finalPRValidation.pr ? { number: finalPRValidation.pr.number, url: finalPRValidation.pr.url, title: finalPRValidation.pr.title } : null, updatedLabels: postProcessingResult?.updatedLabels || [] };
    }

    // Only retry PR creation if:
    // 1. PR validation failed (no PR found)
    // 2. Agent execution completed, or stopped at a publishable timeout/turn limit
    // 3. There were actual commits (commitResult !== null means changes were made and a PR is expected)
    const shouldPublishAgentWork = hasPublishableAgentWork(claudeResult);
    if (!finalPRValidation.isValid && shouldPublishAgentWork && commitResult !== null) {
        await retryPRCreationViaAPI({ worktreeInfo, issueRef, repoValidation, correlatedLogger });
    } else if (!finalPRValidation.isValid && shouldPublishAgentWork && commitResult === null) {
        correlatedLogger.info({ issueNumber: issueRef.number }, 'No PR validation needed - no code changes were made');
    }
    return postProcessingResult;
}

interface RetryPRCreationOptions {
    worktreeInfo: WorktreeInfo;
    issueRef: IssueJobData;
    repoValidation: RepoValidation;
    correlatedLogger: Logger;
}

/**
 * Retries PR creation via GitHub API when the initial PR creation failed.
 * This is a fallback that uses direct API calls instead of having Claude create the PR.
 */
async function retryPRCreationViaAPI(options: RetryPRCreationOptions): Promise<void> {
    const { worktreeInfo, issueRef, repoValidation, correlatedLogger } = options;

    const targetBaseBranch = issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main';

    correlatedLogger.info({
        issueNumber: issueRef.number,
        branchName: worktreeInfo.branchName,
        baseBranch: targetBaseBranch
    }, 'Retrying PR creation via GitHub API');

    try {
        const octokit = await getAuthenticatedOctokit();

        const prResponse = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            title: `Fix issue #${issueRef.number}`,
            head: worktreeInfo.branchName,
            base: targetBaseBranch,
            body: `Resolves #${issueRef.number}\n\n_PR created via retry mechanism_`
        });

        const prNumber = prResponse.data.number;
        correlatedLogger.info({ issueNumber: issueRef.number, prNumber }, 'PR creation retry successful');

        // Link PR to plan issue
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
        await linkPRToPlanIssue(repository, issueRef.number, prNumber);
        correlatedLogger.info({ repository, issueNumber: issueRef.number, prNumber }, 'Linked PR to plan issue (retry creation)');

    } catch (error) {
        const err = error as Error & { status?: number };

        // If PR already exists (422), try to find it
        if (err.status === 422) {
            correlatedLogger.info({ issueNumber: issueRef.number }, 'PR already exists, searching for it');

            const octokit = await getAuthenticatedOctokit();
            const existingPRs = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`,
                state: 'open'
            });

            if (existingPRs.data.length > 0) {
                const existingPR = existingPRs.data[0];
                correlatedLogger.info({ issueNumber: issueRef.number, prNumber: existingPR.number }, 'Found existing PR');

                const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
                await linkPRToPlanIssue(repository, issueRef.number, existingPR.number);
            }
        } else {
            correlatedLogger.error({
                issueNumber: issueRef.number,
                branchName: worktreeInfo.branchName,
                error: err.message,
                status: err.status
            }, 'PR creation retry failed');
        }
    }
}

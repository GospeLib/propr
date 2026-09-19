import type { Logger } from 'pino';
import {
    generateCompletionComment,
    getModelShortName,
    withRetry,
    retryConfigs,
    appendVisualPreviewSection,
    renderVisualPreviewSection,
    renderVisualPreviewUploadFailureSection,
    type VisualPreviewEvidence
} from '@propr/core';
import type { ClaudeCodeResponse, IssueJobData, WorktreeInfo, CommitResult } from '@propr/core';
import {
    isVisualPreviewUploadAuthenticationError,
    publishPullRequestVisualPreviews,
} from '../github/visualPreviewAttachments.js';
import type { StoryPublicationMetadata } from './publicationMetadata.js';
import { buildIssueReference, getPullRequestModelLabel, type Octokit, type RepoValidation, type PostProcessingResult } from './issueJobHelpers.js';

interface CreatePROptions {
    commitResult: CommitResult | null;
    claudeResult: ClaudeCodeResponse | null;
    modelName: string;
    repoValidation: RepoValidation;
    PR_LABEL: string;
    correlatedLogger: Logger;
    issueTitle: string;
    visualPreview?: {
        evidence: VisualPreviewEvidence;
        worktreePath: string;
    };
    publicationMetadata?: StoryPublicationMetadata;
}

export async function createPullRequest(
    octokit: Octokit,
    issueRef: IssueJobData,
    worktreeInfo: WorktreeInfo,
    options: CreatePROptions
): Promise<PostProcessingResult> {
    const { commitResult, claudeResult, modelName, repoValidation, PR_LABEL, correlatedLogger, issueTitle, visualPreview, publicationMetadata } = options;
    const jobId = `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}`;

    const modelShortName = getModelShortName(modelName);
    const prTitle = publicationMetadata?.prTitle ?? '[' + issueRef.number + ' by ' + modelShortName + '] ' + issueTitle;

    const completionComment = await generateCompletionComment(claudeResult, { number: issueRef.number, repoOwner: issueRef.repoOwner, repoName: issueRef.repoName });
    const basePrBody = publicationMetadata?.prBody ?? `## AI Implementation Summary

${buildIssueReference(issueRef.number, commitResult !== null, claudeResult)}

**Branch:** \`${worktreeInfo.branchName}\`
**Commits:** ${commitResult ? `✅ Changes committed (${commitResult.commitHash.substring(0, 7)})` : '❌ No changes made'}

---

${completionComment}

---

### 💡 Need changes?

Comment on this PR to request refinements — the AI agent monitors comments and will update the implementation based on your feedback. Keep iterating until you're satisfied!`;
    const visualPreviewSection = !publicationMetadata && visualPreview && commitResult
        ? renderVisualPreviewSection({
            assets: [],
            toolSuggestions: visualPreview.evidence.toolSuggestions
        }, {})
        : '';
    const prBody = publicationMetadata ? basePrBody : appendVisualPreviewSection(basePrBody, visualPreviewSection);

    try {
        const prResponse = await octokit.request<{ data: { number: number; html_url: string; title: string } }>('POST /repos/{owner}/{repo}/pulls', {
            owner: issueRef.repoOwner,
            repo: issueRef.repoName,
            title: prTitle,
            head: worktreeInfo.branchName,
            base: issueRef.baseBranch || repoValidation.repoData?.defaultBranch || 'main',
            body: prBody,
            draft: false
        });

        correlatedLogger.info({
            jobId,
            issueNumber: issueRef.number,
            prNumber: prResponse.data.number,
            prUrl: prResponse.data.html_url
        }, 'PR created successfully');

        // Add PR label and model label (for followup comments to use the same model)
        const modelLabel = getPullRequestModelLabel(issueRef, modelName);
        const labelsToAdd = modelLabel ? [PR_LABEL, modelLabel] : [PR_LABEL];
        try {
            await withRetry(
                () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    issue_number: prResponse.data.number,
                    labels: labelsToAdd
                }),
                retryConfigs.githubApi,
                `add_pr_label_${prResponse.data.number}`
            );
            correlatedLogger.info({ prNumber: prResponse.data.number, labels: labelsToAdd }, 'Added PR labels to new PR');
        } catch (labelError) {
            correlatedLogger.warn({ prNumber: prResponse.data.number, labels: labelsToAdd, error: (labelError as Error).message }, 'Failed to add PR labels to new PR after retries');
        }

        if (!publicationMetadata && visualPreview && commitResult && visualPreview.evidence.assets.length > 0) {
            try {
                await publishPullRequestVisualPreviews({
                    owner: issueRef.repoOwner,
                    repo: issueRef.repoName,
                    pullRequestNumber: prResponse.data.number,
                    body: basePrBody,
                    evidence: visualPreview.evidence,
                    worktreePath: visualPreview.worktreePath,
                    octokit
                });
                correlatedLogger.info({ prNumber: prResponse.data.number, previewCount: visualPreview.evidence.assets.length }, 'Uploaded visual previews to pull request');
            } catch (previewError) {
                correlatedLogger.warn({ prNumber: prResponse.data.number, error: (previewError as Error).message }, 'Could not upload visual previews; publishing a text-only explanation');
                try {
                    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        pull_number: prResponse.data.number,
                        body: appendVisualPreviewSection(basePrBody, renderVisualPreviewUploadFailureSection(
                            visualPreview.evidence,
                            { authenticationFailure: isVisualPreviewUploadAuthenticationError(previewError) }
                        ))
                    });
                } catch (fallbackError) {
                    correlatedLogger.warn({ prNumber: prResponse.data.number, error: (fallbackError as Error).message }, 'Could not publish the text-only visual preview upload explanation');
                }
            }
        }

        return {
            success: true,
            pr: {
                number: prResponse.data.number,
                url: prResponse.data.html_url,
                title: prResponse.data.title
            },
            updatedLabels: []
        };

    } catch (prError) {
        correlatedLogger.warn({
            jobId,
            issueNumber: issueRef.number,
            branchName: worktreeInfo.branchName,
            error: (prError as Error).message
        }, 'Direct PR creation failed, checking if PR already exists...');

        return await findExistingPR({ octokit, issueRef, worktreeInfo, prError: prError as Error, correlatedLogger, PR_LABEL, modelName });
    }
}

interface FindExistingPROptions {
    octokit: Octokit;
    issueRef: IssueJobData;
    worktreeInfo: WorktreeInfo;
    prError: Error;
    correlatedLogger: Logger;
    PR_LABEL: string;
    modelName: string;
}

async function findExistingPR(options: FindExistingPROptions): Promise<PostProcessingResult> {
    const { octokit, issueRef, worktreeInfo, prError, correlatedLogger, PR_LABEL, modelName } = options;
    try {
        const existingPRs = await octokit.request<{ data: Array<{ number: number; html_url: string; title: string; base: { ref: string } }> }>('GET /repos/{owner}/{repo}/pulls', { owner: issueRef.repoOwner, repo: issueRef.repoName, head: `${issueRef.repoOwner}:${worktreeInfo.branchName}`, state: 'open' });
        if (existingPRs.data.length > 0) {
            const existingPR = existingPRs.data[0];
            correlatedLogger.info({ issueNumber: issueRef.number, prNumber: existingPR.number, prUrl: existingPR.html_url, currentBase: existingPR.base.ref }, 'Found existing PR for branch');

            const expectedBase = issueRef.baseBranch;
            if (expectedBase && existingPR.base.ref !== expectedBase) {
                correlatedLogger.info({ prNumber: existingPR.number, currentBase: existingPR.base.ref, expectedBase }, 'PR has wrong base branch, updating...');
                try {
                    await octokit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        pull_number: existingPR.number,
                        base: expectedBase
                    });
                    correlatedLogger.info({ prNumber: existingPR.number, newBase: expectedBase }, 'Updated PR base branch');
                } catch (updateError) {
                    correlatedLogger.warn({ prNumber: existingPR.number, error: (updateError as Error).message }, 'Failed to update PR base branch');
                }
            }

            // Add PR label and model label (for followup comments to use the same model)
            const modelLabel = getPullRequestModelLabel(issueRef, modelName);
            const labelsToAdd = modelLabel ? [PR_LABEL, modelLabel] : [PR_LABEL];
            try {
                await withRetry(
                    () => octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
                        owner: issueRef.repoOwner,
                        repo: issueRef.repoName,
                        issue_number: existingPR.number,
                        labels: labelsToAdd
                    }),
                    retryConfigs.githubApi,
                    `add_pr_label_existing_${existingPR.number}`
                );
                correlatedLogger.info({ prNumber: existingPR.number, labels: labelsToAdd }, 'Added PR labels to existing PR');
            } catch (labelError) {
                correlatedLogger.warn({ prNumber: existingPR.number, labels: labelsToAdd, error: (labelError as Error).message }, 'Failed to add PR labels to existing PR after retries');
            }

            return { success: true, pr: { number: existingPR.number, url: existingPR.html_url, title: existingPR.title }, updatedLabels: [] };
        }
        throw prError;
    } catch { throw prError; }
}

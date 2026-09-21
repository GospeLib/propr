import { setTimeout } from 'timers/promises';
import type { ClaudeCodeResponse } from '@propr/core';
import { verifyStoryPublication } from '@propr/core';
import type { CommitResult } from '@propr/core';
import {
    cleanupPreparedVisualPreviewEvidence, commitChanges,
    loadRepositoryVisualPreviewSettings, prepareVisualPreviewEvidence, pushBranch,
    TaskStates,
    describeAgentTermination,
    resolveAgentTerminationReason
} from '@propr/core';
import { safeUpdateLabels } from '@propr/core';
import { createPullRequest, ensureEpicBaseBranchExists, type PostProcessingResult } from './issueJobHelpers.js';
import { handleCreatedPlanIssuePR } from './issueJobPostProcessingHelpers.js';
import { buildStoryCommitMessage, buildStoryPublicationMetadata } from './publicationMetadata.js';
import { requireStoryPublicationPolicy } from './storyPublicationPolicy.js';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { publishSignedStoryCommit } from './signedStoryPublication.js';
import {
    hasPublishableAgentWork,
    handleUnpublishableAgentFailure,
    handlePostProcessingFailure,
    handleMissingCommit,
    handleStoppedAdmittedExecution,
    getErrorMessage,
    type PostProcessOptions,
} from './issueJobUnpublishableFailure.js';

export type { Octokit, PostProcessOptions } from './issueJobUnpublishableFailure.js';

function buildImplementationCompletionNote(claudeResult: ClaudeCodeResponse): string {
    const terminationReason = resolveAgentTerminationReason(claudeResult);
    if (terminationReason) return `Partial implementation: ${describeAgentTermination(terminationReason)}`;
    return claudeResult.success
        ? 'Implementation completed successfully.'
        : 'Implementation attempted - see PR comments for details.';
}

export interface PostProcessResult {
    commitResult: CommitResult | null;
    postProcessingResult: PostProcessingResult | null;
}

export async function performPostProcessing(options: PostProcessOptions): Promise<PostProcessResult> {
    const { octokit, issueRef, worktreeInfo, currentIssueData, claudeResult, modelName, repoValidation, repoUrl, githubToken, PR_LABEL, AI_PROCESSING_TAG, AI_DONE_TAG, correlatedLogger, taskId, stateManager } = options;
    let commitResult: CommitResult | null = null;
    let postProcessingResult: PostProcessingResult | null = null;
    let preparedVisualPreview: Awaited<ReturnType<typeof prepareVisualPreviewEvidence>> | undefined;
    // An admitted execution that stopped before success (turn limit, lease, or any failure)
    // never publishes; its partial work is preserved on a checkpoint ref before cleanup.
    if (options.execution !== undefined && !claudeResult.success)
        return { commitResult, postProcessingResult: await handleStoppedAdmittedExecution(options, options.execution) };
    const storyChangedPaths = options.execution
        ? await verifyStoryPublication(worktreeInfo.worktreePath, options.execution)
        : [];

    try {
        if (!hasPublishableAgentWork(claudeResult)) {
            postProcessingResult = await handleUnpublishableAgentFailure({
                octokit,
                issueRef,
                claudeResult,
                AI_PROCESSING_TAG,
                correlatedLogger,
            });
            return { commitResult, postProcessingResult };
        }

        const completionNote = buildImplementationCompletionNote(claudeResult);
        const signedStoryId = options.execution ? options.execution.taskAssignment?.taskId ?? issueRef.executionAdmissionReceipt?.storyId : undefined;
        const taskLinkRequired = options.execution
            ? (await requireStoryPublicationPolicy({
                worktreePath: worktreeInfo.worktreePath,
                changedPaths: storyChangedPaths,
                signedStoryId: issueRef.executionAdmissionReceipt?.storyId,
                taskAssignment: options.execution?.taskAssignment,
            })).taskLinkRequired
            : false;
        let commitMessage = signedStoryId
            ? buildStoryCommitMessage(signedStoryId, taskLinkRequired, options.execution)
            : `fix(ai): Resolve issue #${issueRef.number} - ${currentIssueData.data.title.substring(0, 50)}\n\nImplemented by ProPR AI using ${modelName} model.\n\n${completionNote}`;
        if (!signedStoryId && claudeResult?.commitMessage) commitMessage = claudeResult.commitMessage;

        // Signed execution fixes the allowed paths and publication metadata; ordinary
        // upstream visual-preview cleanup must not mutate that admitted candidate.
        if (!options.execution) preparedVisualPreview = await prepareVisualPreviewEvidence({
            worktreePath: worktreeInfo.worktreePath,
            settings: await loadRepositoryVisualPreviewSettings(`${issueRef.repoOwner}/${issueRef.repoName}`),
            taskId: taskId || `${issueRef.repoOwner}-${issueRef.repoName}-${issueRef.number}`
        });

        commitResult = options.execution?.taskAssignment ? await publishSignedStoryCommit({
            octokit: octokit as never, owner: issueRef.repoOwner, repo: issueRef.repoName,
            worktreePath: worktreeInfo.worktreePath, execution: options.execution, commitMessage,
        }) : await commitChanges(
            worktreeInfo.worktreePath, commitMessage,
            AI_COMMIT_AUTHOR,
            { issueNumber: issueRef.number, issueTitle: currentIssueData.data.title, execution: options.execution }
        );

        claudeResult.modifiedFiles = commitResult?.filesChanged || claudeResult.modifiedFiles;

        // Successful no-change runs are complete; interrupted no-change runs have
        // no partial implementation to publish and must remain retryable.
        if (commitResult === null) {
            postProcessingResult = await handleMissingCommit(options);
            return { commitResult, postProcessingResult };
        }

        if (!options.execution?.taskAssignment) await pushBranch(worktreeInfo.worktreePath, worktreeInfo.branchName, { repoUrl, authToken: githubToken.token, execution: options.execution });

        correlatedLogger.debug('Waiting for branch propagation...');
        await setTimeout(3000);

        // Check for cancellation before creating PR
        if (taskId && stateManager) {
            const currentState = await stateManager.getTaskState(taskId);
            if (currentState?.state === TaskStates.CANCELLED) {
                correlatedLogger.info({ taskId }, 'Task was cancelled by user, skipping PR creation');
                throw new Error('Execution aborted by user request');
            }
        }

        // Self-heal a deleted epic base branch (e.g. after its Epic PR was
        // closed) so the child PR isn't rejected with base "invalid" on rerun.
        if (issueRef.baseBranch && !options.execution) {
            await ensureEpicBaseBranchExists(octokit, {
                owner: issueRef.repoOwner,
                repo: issueRef.repoName,
                baseBranch: issueRef.baseBranch,
                defaultBranch: repoValidation.repoData?.defaultBranch,
                correlatedLogger
            });
        }

        const publicationMetadata = signedStoryId ? buildStoryPublicationMetadata({
            execution: options.execution,
            storyId: signedStoryId,
            issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
            commitHash: commitResult.commitHash,
            taskLinkRequired,
        }) : undefined;
        postProcessingResult = await createPullRequest(
            octokit, issueRef, worktreeInfo,
            {
                commitResult,
                claudeResult,
                modelName,
                repoValidation,
                PR_LABEL,
                correlatedLogger,
                issueTitle: currentIssueData.data.title,
                publicationMetadata,
                visualPreview: preparedVisualPreview ? {
                    evidence: preparedVisualPreview.evidence,
                    worktreePath: worktreeInfo.worktreePath
                } : undefined
            }
        );
        if (options.execution) {
            const prNumber = postProcessingResult?.pr?.number;
            if (!prNumber) throw Error('STORY_EXECUTION_PR_REQUIRED');
            const { data: current } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
                owner: issueRef.repoOwner, repo: issueRef.repoName, pull_number: prNumber }) as {
                    data: { head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
                        base?: { ref?: string; repo?: { full_name?: string } }; merged?: boolean; state?: string;
                        title?: string; body?: string; auto_merge?: unknown } };
            const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
            if (current.head?.sha !== commitResult.commitHash || current.head.ref !== options.execution.featureBranch ||
                current.head.repo?.full_name !== repository || current.base?.repo?.full_name !== repository ||
                current.base.ref !== options.execution.targetBranch || current.merged !== false || current.state !== 'open')
                throw Error('STORY_EXECUTION_PUBLICATION_CHANGED');
            if (options.execution.publicationMetadata && (current.title !== publicationMetadata?.prTitle ||
                current.body !== publicationMetadata?.prBody || current.auto_merge != null))
                throw Error('STORY_EXECUTION_PUBLICATION_METADATA_CHANGED');
        }

        // Update plan issue status to 'under_review' if PR was created successfully
        if (postProcessingResult?.pr?.number) {
            await handleCreatedPlanIssuePR({
                issueRef,
                currentIssueData,
                prNumber: postProcessingResult.pr.number,
                correlatedLogger,
            });
        }

        await safeUpdateLabels(
            { octokit, owner: issueRef.repoOwner, repo: issueRef.repoName, issueNumber: issueRef.number, logger: correlatedLogger },
            [AI_PROCESSING_TAG], [AI_DONE_TAG]
        );

    } catch (postProcessingError) {
        if (options.execution) throw postProcessingError;
        // A completed execution or an actual commit can be marked done during
        // fallback. A failed/interrupted run with no commit must remain retryable.
        const canMarkDone = claudeResult.success || commitResult !== null;
        postProcessingResult = await handlePostProcessingFailure(options, postProcessingError, canMarkDone);
    } finally {
        try {
            await cleanupPreparedVisualPreviewEvidence(preparedVisualPreview);
        } catch (cleanupError) {
            correlatedLogger.warn({ error: getErrorMessage(cleanupError) }, 'Could not clean up staged visual previews');
        }
    }

    return { commitResult, postProcessingResult };
}

export { handlePRValidation, type PRValidationOptions } from './issueJobPRValidation.js';
export { cleanupWorktreeIfExists, performFinalValidation, type CleanupOptions, type FinalValidationOptions } from './issueJobCleanup.js';

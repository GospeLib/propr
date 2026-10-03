import { publishSignedMaintenanceCommit } from './signedMaintenancePublication.js';
import { changedSinceSnapshot, snapshotWorktree } from './maintenanceWrittenPaths.js';
import { buildAdmittedWorkerEnvironment } from './ezerAdmittedWorkerEnvironment.js';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
    AgentRegistry,
    TaskStates,
    commitChanges,
    createLogFiles,
    db,
    getAuthenticatedOctokit,
    pushBranch,
    recordLLMMetrics,
} from '@propr/core';
import type { ClaudeCodeResponse, JobResult, WorkerStateManager, WorktreeInfo } from '@propr/core';
import { createContainerIdCallbackForPR, createSessionIdCallbackForPR } from './prCommentJobHelpers.js';
import { recordFinalClaudeExecutionResult } from './claudeExecutionResult.js';
import { publishCompletedWithDurableExecutionEvidence } from './completedExecutionDurability.js';
import { buildAgentOutcome } from './executionOutcome.js';
import { AI_COMMIT_AUTHOR } from './commitAuthor.js';
import { agentResultToClaudeResponse, toClaudeResult } from './prCommentJobUtils.js';
import {
    buildConflictResolutionPrompt, isWithinMergeScope,
    getAgentFailureDetail,
    buildMergeConflictComment,
    buildMergeConflictCommitMessage,
} from './mergeConflictHelpers.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';
import { installationTokenProvider, type GitHubToken } from './githubTypes.js';

const MAX_CONFLICT_MARKER_SCAN_BYTES = 1024 * 1024;
async function buildMergeCompletionHistoryMetadata(options: {
    stateManager: WorkerStateManager;
    taskId: string;
    pullRequestNumber: number;
    baseBranch: string;
    headBranch: string;
    model: string;
    commitHash: string;
    correlatedLogger: Logger;
}): Promise<Record<string, unknown>> {
    let previousHistoryMetadata: Record<string, unknown> = {};

    try {
        const state = await options.stateManager.getTaskState(options.taskId);
        previousHistoryMetadata = [...(state?.history || [])]
            .reverse()
            .find(entry => entry.metadata && Object.keys(entry.metadata).length > 0)
            ?.metadata || {};
        const issueRef = state?.issueRef as { title?: unknown; subtitle?: unknown; issueNumber?: unknown } | undefined;
        previousHistoryMetadata = {
            ...previousHistoryMetadata,
            ...(typeof issueRef?.title === 'string' && { title: issueRef.title }),
            ...(typeof issueRef?.subtitle === 'string' && { subtitle: issueRef.subtitle }),
            ...(typeof issueRef?.issueNumber === 'number' && { issueNumber: issueRef.issueNumber }),
        };
    } catch (stateError) {
        options.correlatedLogger.warn({ taskId: options.taskId, error: (stateError as Error).message }, 'Failed to load merge task metadata for completion history');
    }

    return {
        ...previousHistoryMetadata,
        commandMode: 'merge',
        pullRequestNumber: options.pullRequestNumber,
        baseBranch: options.baseBranch,
        headBranch: options.headBranch,
        model: options.model,
        commitHash: options.commitHash,
    };
}

async function verifyNoConflictMarkers(worktreeInfo: WorktreeInfo, pullRequestNumber: number, correlatedLogger: Logger): Promise<void> {
    const { execFileSync } = await import('child_process');
    const { readFileSync, statSync } = await import('fs');
    const { join } = await import('path');

    try {
        const trackedAndUntracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
            cwd: worktreeInfo.worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
        });
        const filePaths = new Set(trackedAndUntracked.split('\0').filter(Boolean));
        const markerLines: string[] = [];

        for (const filePath of filePaths) {
            const absolutePath = join(worktreeInfo.worktreePath, filePath);
            try {
                const stats = statSync(absolutePath);
                if (!stats.isFile() || stats.size > MAX_CONFLICT_MARKER_SCAN_BYTES) continue;
                const buffer = readFileSync(absolutePath);
                if (buffer.includes(0)) continue;
                const lines = buffer.toString('utf8').split(/\r?\n/);
                lines.forEach((line, index) => {
                    if (/^(<<<<<<<|=======|>>>>>>>)($|\s)/.test(line)) {
                        markerLines.push(`${filePath}:${index + 1}:${line}`);
                    }
                });
            } catch {
                // Ignore files that disappear or cannot be decoded while scanning.
            }
        }

        if (markerLines.length > 0) {
            correlatedLogger.error({
                pullRequestNumber,
                remainingMarkers: markerLines.length,
                firstFewMarkers: markerLines.slice(0, 5)
            }, 'Conflict markers still present after agent execution');
            throw new Error(`Agent failed to resolve all merge conflicts. ${markerLines.length} conflict marker(s) still present in files.`);
        }
    } catch (grepError) {
        if ((grepError as { status?: number }).status === 1) return;
        if ((grepError as Error).message?.includes('Agent failed to resolve')) throw grepError;
        correlatedLogger.warn({ error: (grepError as Error).message }, 'Failed to verify conflict markers, continuing');
    }
}

export async function handleMergeWithAgent(options: {
    executionAdmissionReceipt?: import('@propr/core').WorkerAdmissionReceipt;
    beforePublish?: () => Promise<void>;
    onPushed?: (head: string) => void;
    /** The exact base commit Git merged for an Ezer maintenance request. */
    mergedBaseSha?: string;
    conflictedFiles?: string[];
    worktreeInfo: WorktreeInfo;
    branchName: string;
    baseBranch: string;
    pullRequestNumber: number;
    repoUrl: string;
    repoOwner: string;
    repoName: string;
    githubToken: GitHubToken;
    octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    startingCommentId: number;
    stateManager: WorkerStateManager;
    taskId: string;
    /** Durable identity of the queue job owning this attempt; see the durability barrier. */
    operationId: string;
    correlationId: string;
    correlatedLogger: Logger;
    redisClient: Redis;
}): Promise<JobResult> {
    const { conflictedFiles, worktreeInfo, branchName, baseBranch, pullRequestNumber, repoUrl,
        repoOwner, repoName, githubToken, octokit, startingCommentId,
        stateManager, taskId, operationId, correlationId, correlatedLogger, redisClient } = options;

    const maintenance = options.executionAdmissionReceipt?.maintenance;
    const deadline = options.executionAdmissionReceipt?.executionDeadline;
    const scope = options.executionAdmissionReceipt?.scope;
    const prompt = (maintenance ? `Resolve conflicts only within these admitted paths: ${JSON.stringify(scope)}. Do not push, merge the PR, enable auto-merge, or run ultrafix.\n\n` : '') + buildConflictResolutionPrompt({
        pullRequestNumber, baseBranch, headBranch: branchName, conflictedFiles, worktreeInfo, repoOwner, repoName,
    });
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
    const agent = registry.getAgentByAlias(resolvedAlias);
    if (!agent) throw new Error(`Agent not found for alias: ${resolvedAlias}`);

    correlatedLogger.info({
        agentAlias: resolvedAlias, agentType: agent.config.type, model: resolvedModel, pullRequestNumber, conflictedFiles,
    }, 'Executing merge conflict resolution with agent');
    const wasCleanMerge = !conflictedFiles || conflictedFiles.length === 0;

    // The merge as Git left it, before the agent touches anything: the scope check measures from here.
    const preAgentSnapshot = maintenance ? snapshotWorktree(worktreeInfo.worktreePath) : undefined;
    await options.beforePublish?.();
    const agentResult = await agent.executeTask({
        environment: buildAdmittedWorkerEnvironment({ repoOwner, repoName, number: pullRequestNumber,
            baseBranch, executionAdmissionReceipt: options.executionAdmissionReceipt }, taskId, Boolean(options.executionAdmissionReceipt)),
        ...(deadline ? { timeoutMs: Math.max(1, Date.parse(deadline) - Date.now()) } : {}),
        worktreePath: worktreeInfo.worktreePath,
        issueRef: { number: pullRequestNumber, repoOwner, repoName },
        prompt,
        model: resolvedModel,
        githubToken: githubToken.token,
        branchName,
        onSessionId: createSessionIdCallbackForPR(taskId, { pullRequestNumber, repoOwner, repoName }, { llm: resolvedModel, stateManager, correlatedLogger, redisClient, verifiedExecutionCorrelation: options.executionAdmissionReceipt }),
        onContainerId: createContainerIdCallbackForPR(taskId, stateManager),
        taskId,
        prNumber: pullRequestNumber,
    });

    const claudeResult: ClaudeCodeResponse = agentResultToClaudeResponse(agentResult);
    await recordLLMMetrics(toClaudeResult(claudeResult), { number: pullRequestNumber, repoOwner, repoName }, { jobType: 'merge_conflict', correlationId, taskId });
    await createLogFiles(claudeResult as unknown, { number: pullRequestNumber, repoOwner, repoName });
    // Supersede the start-time provisional record before appending the completed entry, so the
    // history entry that describes this execution carries its real outcome.
    const executionSummary = await recordFinalClaudeExecutionResult(stateManager, taskId,
        { success: claudeResult.success, failureKind: claudeResult.failureKind, usageResetAt: claudeResult.usageResetAt, terminationReason: claudeResult.terminationReason, error: claudeResult.error, sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, executionTime: claudeResult.executionTime },
        correlatedLogger);
    await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, {
        reason: `${agent.config.type} agent execution completed for merge conflict resolution`,
        claudeResult: executionSummary,
        historyMetadata: { sessionId: claudeResult.sessionId, conversationId: claudeResult.conversationId, model: claudeResult.model },
    });
    if (!claudeResult.success) {
        throw new Error(`Agent execution failed during conflict resolution: ${getAgentFailureDetail(claudeResult)}`);
    }

    await verifyNoConflictMarkers(worktreeInfo, pullRequestNumber, correlatedLogger);
    if (maintenance) {
        const { execFileSync } = await import('node:child_process');
        const git = (args: string[]) => execFileSync('git', args, { cwd: worktreeInfo.worktreePath, encoding: 'utf8' });
        const written = changedSinceSnapshot(worktreeInfo.worktreePath, preAgentSnapshot!);
        if (!scope?.length || written.some(path => !isWithinMergeScope(path, scope))) throw new Error('maintenance-scope-changed');
        git(['merge-base', '--is-ancestor', maintenance.headSha, 'HEAD']);
    }
    const commitMessage = buildMergeConflictCommitMessage({
        baseBranch, headBranch: branchName, pullRequestNumber, conflictedFiles,
        model: claudeResult.model || resolvedModel, wasCleanMerge,
    });
    await options.beforePublish?.();
    let finalCommitHash: string;
    if (maintenance) {
        finalCommitHash = await publishSignedMaintenanceCommit({
            octokit, owner: repoOwner, repo: repoName, worktreePath: worktreeInfo.worktreePath,
            branch: branchName, headSha: maintenance.headSha, baseSha: maintenance.baseSha,
            mergedBaseSha: options.mergedBaseSha ?? maintenance.baseSha, commitMessage,
            beforePublish: async () => {
                await options.beforePublish?.();
                const written = changedSinceSnapshot(worktreeInfo.worktreePath, preAgentSnapshot!);
                if (!scope?.length || written.some(path => !isWithinMergeScope(path, scope))) throw new Error('maintenance-scope-changed');
            },
        });
    } else {
        const commitResult = await commitChanges(worktreeInfo.worktreePath, commitMessage, AI_COMMIT_AUTHOR, { issueNumber: pullRequestNumber, issueTitle: wasCleanMerge ? 'Verify clean merge' : 'Resolve merge conflicts' });
        const { simpleGit } = await import('simple-git');
        finalCommitHash = commitResult?.commitHash || (await simpleGit({ baseDir: worktreeInfo.worktreePath }).revparse(['HEAD'])).trim();
        await options.beforePublish?.();
        await pushBranch(worktreeInfo.worktreePath, branchName, { repoUrl, tokenRefreshFn: installationTokenProvider(octokit) });
    }
    options.onPushed?.(finalCommitHash);

    // Maintenance authorization ends at the acknowledged push. Later fence changes can
    // suppress notifications, but must not erase the publication from task history.
    if (!maintenance) await options.beforePublish?.();
    // `completed` is published only once the final execution evidence is durable; the evidence
    // rides on the completed entry itself. See completedExecutionDurability.ts.
    const completion = await publishCompletedWithDurableExecutionEvidence({
        stateManager, taskId, correlatedLogger, operationId,
        metadata: {
            reason: 'Merge conflict resolution completed successfully', commitHash: finalCommitHash,
            claudeResult: executionSummary,
            ...(maintenance ? { durableCommit: async (transaction: import('knex').Knex.Transaction) => {
                await transaction('tasks').where({ task_id: taskId }).update({ commit_hash: finalCommitHash });
            } } : {}),
            historyMetadata: {
                ...await buildMergeCompletionHistoryMetadata({
                    stateManager, taskId, pullRequestNumber, baseBranch, headBranch: branchName,
                    model: claudeResult.model || resolvedModel, commitHash: finalCommitHash, correlatedLogger,
                }),
                agentOutcome: buildAgentOutcome(claudeResult),
                ...(options.executionAdmissionReceipt ? { admissionId: options.executionAdmissionReceipt.admissionId, operationId: options.executionAdmissionReceipt.operationId, settlement: maintenance && finalCommitHash === maintenance.headSha ? 'no-change' : 'published', pushedHead: finalCommitHash } : {}),
            },
        },
    });
    try {
        await db('tasks').where({ task_id: taskId }).update({ commit_hash: finalCommitHash });
    } catch (dbError) {
        correlatedLogger.warn({ taskId, error: (dbError as Error).message }, 'Failed to save commit hash to database');
    }

    if (completion.outcome === 'settled_failed') {
        return { status: 'failed', reason: 'completion_history_not_durable', commit: finalCommitHash,
            pushedHead: finalCommitHash, pullRequestNumber };
    }

    try {
        if (maintenance) await options.beforePublish?.();
        const taskUrl = `${process.env.WEB_UI_URL || process.env.FRONTEND_URL || 'https://gitfix.dev'}/tasks/${taskId}`;
        const comment = buildMergeConflictComment({
            wasCleanMerge,
            commitHash: finalCommitHash, baseBranch, headBranch: branchName, conflictedFiles,
            resolutionSummary: claudeResult.summary, model: claudeResult.model || resolvedModel,
            executionTimeMs: claudeResult.executionTime, taskUrl,
        });
        await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
            owner: repoOwner, repo: repoName, comment_id: startingCommentId, body: comment,
        });
    } catch (commentError) {
        correlatedLogger.warn({ taskId, commitHash: finalCommitHash, error: (commentError as Error).message },
            'Merge completed, but the completion comment could not be published');
    }

    correlatedLogger.info({
        pullRequestNumber, commitHash: finalCommitHash, baseBranch, conflictedFiles, model: claudeResult.model || resolvedModel,
    }, 'Merge conflict resolution completed successfully');
    return {
        status: 'complete',
        commit: finalCommitHash,
        pullRequestNumber,
        mergeType: conflictedFiles && conflictedFiles.length > 0 ? 'conflict_resolved' : 'clean',
        claudeResult: { success: claudeResult.success },
    };
}

/** Same merge-conflict agent, with milestone authority and no fabricated story/PR task. */
export async function runMilestoneConflictAgent(options: {
    worktreePath: string;
    conflicts: string[];
    request: import('@propr/core').MilestoneMaintenanceRequest;
    logger: Logger;
    fence: () => Promise<void>;
}): Promise<void> {
    const { request: p } = options;
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();
    const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, options.logger);
    const agent = registry.getAgentByAlias(resolvedAlias);
    if (!agent) throw Error('milestone-agent-unavailable');
    await options.fence();
    const [repoOwner, repoName] = p.repository.split('/');
    const result = await agent.executeTask({
        worktreePath: options.worktreePath,
        issueRef: { number: p.issueNumber, repoOwner, repoName },
        prompt: `Resolve the merge of ${p.sourceSha} into ${p.fromHead} for milestone ${p.epicId}/${p.milestoneId}. Conflicts: ${JSON.stringify(options.conflicts)}. You may edit only ${JSON.stringify(p.scope)}. Leave the result uncommitted. Do not push, change HEAD, switch branches, or change remotes.`,
        model: resolvedModel,
        timeoutMs: Math.max(1, Date.parse(p.expiresAt) - Date.now()),
        branchName: p.branch,
        taskId: `milestone-${p.requestId}`,
        githubToken: '',
        environment: buildAdmittedWorkerEnvironment({ repoOwner, repoName, number: p.issueNumber,
            baseBranch: p.branch }, `milestone-${p.requestId}`, true),
    });
    if (!result.success) throw Error('milestone-conflict-agent-failed');
    await options.fence();
}

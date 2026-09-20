import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { logger } from '@propr/core';
import { getAuthenticatedOctokit } from '@propr/core';
import { withRetry, retryConfigs } from '@propr/core';
import { getStateManager, TaskStates } from '@propr/core';
import {
    createWorktreeForIssue,
    cleanupWorktree,
    getRepoUrl,
    ensureRepoCloned
} from '@propr/core';
import type { WorktreeInfo } from '@propr/core';
import { ensureGitRepository } from '@propr/core';
import { AgentRegistry, UsageLimitError } from '@propr/core';
import { generateTaskImportPrompt } from '@propr/core';
import { handleError } from '@propr/core';
import { handleSimpleUsageLimitError } from './issueJobHelpers.js';
import type { AgentExecutionResult, TaskImportJobData, JobResult, UpdateMetadata } from '@propr/core';
import { ErrorCategories } from '@propr/core';
import { agentResultToClaudeResponse } from './prFileUtils.js';
import { buildAgentOutcome } from './executionOutcome.js';
import { finalClaudeExecutionResult } from './claudeExecutionResult.js';
import { publishCompletedWithDurableExecutionEvidence } from './completedExecutionDurability.js';
import type { GitHubToken } from './githubTypes.js';
import { resolveDefaultAgentAndModel } from './prCommentAgentUtils.js';

interface TaskImportResult extends JobResult {
    repository?: string;
    success?: boolean;
    claudeResult?: {
        success: boolean;
        executionTime?: number;
        conversationTurns?: number;
        stdout?: string;
    };
}

/** A task-import run whose agent execution did not succeed; it fails, it never completes. */
export const TASK_IMPORT_EXECUTION_FAILED = 'TASK_IMPORT_EXECUTION_FAILED';

function logTaskImportExecution(
    correlatedLogger: Logger,
    agentResult: AgentExecutionResult,
    repository: string,
    user: string | undefined,
): void {
    if (agentResult.success) {
        correlatedLogger.info({ repository, user, stdout: agentResult.rawOutput || agentResult.logs },
            'Task import job completed successfully - agent executed gh commands');
        return;
    }
    correlatedLogger.error({ repository, user, error: agentResult.error }, 'Task import job failed');
}

/** The terminal evidence this run leaves on whichever terminal entry it reaches. */
function taskImportExecutionEvidence(agentResult: AgentExecutionResult): UpdateMetadata {
    return {
        claudeResult: finalClaudeExecutionResult({
            success: agentResult.success,
            sessionId: agentResult.sessionId,
            conversationId: agentResult.conversationId,
            executionTime: agentResult.executionTimeMs,
        }),
        historyMetadata: { agentOutcome: buildAgentOutcome(agentResultToClaudeResponse(agentResult)) },
    };
}

function taskImportExecutionFailure(agentResult: AgentExecutionResult): Error {
    return new Error(`${TASK_IMPORT_EXECUTION_FAILED}: ${agentResult.error ?? 'the agent reported no result'}`);
}

export async function processTaskImportJob(job: Job<TaskImportJobData>): Promise<TaskImportResult> {
    const { id: jobId, name: jobName, data } = job;
    const {
        taskDescription,
        repository,
        correlationId,
        user
    } = data;
    const correlatedLogger: Logger = logger.withCorrelation(correlationId);
    const stateManager = getStateManager();

    correlatedLogger.info({
        jobId,
        jobName,
        repository,
        user,
        taskDescriptionLength: taskDescription?.length || 0,
        taskDescriptionPreview: taskDescription?.substring(0, 100) + '...'
    }, 'Processing task import job...');

    let octokit: Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
    /** The run's terminal evidence, recorded on whichever terminal entry this job reaches. */
    let terminalExecutionEvidence: UpdateMetadata | undefined;
    let localRepoPath: string | undefined;
    let worktreeInfo: WorktreeInfo | undefined;
    const [repoOwner, repoName] = repository.split('/');
    const taskId = `task-import-${repoOwner}-${repoName}-${Date.now()}`;

    try {
        await stateManager.createTaskState(taskId, { number: 0, repoOwner, repoName }, correlationId);

        octokit = await withRetry(
            () => getAuthenticatedOctokit(),
            { ...retryConfigs.githubApi, correlationId },
            'get_authenticated_octokit'
        );

        if (!repoOwner || !repoName) {
            throw new Error(`Invalid repository format: ${repository}. Expected format: owner/name`);
        }

        const githubToken = await octokit.auth({ type: "installation" }) as GitHubToken;
        const repoUrl = getRepoUrl({ repoOwner, repoName });

        await ensureGitRepository(correlatedLogger);

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Cloning repository if needed' });
        localRepoPath = await ensureRepoCloned({ repoUrl, owner: repoOwner, repoName, authToken: githubToken.token });

        await stateManager.updateTaskState(taskId, TaskStates.PROCESSING, { reason: 'Creating worktree for analysis' });

        worktreeInfo = await createWorktreeForIssue(
            localRepoPath,
            { issueId: 'import', issueTitle: 'Task Import Analysis', owner: repoOwner, repoName },
            { baseBranch: null, octokit, modelName: 'planner' }
        );

        correlatedLogger.info({
            worktreePath: worktreeInfo.worktreePath,
            branchName: worktreeInfo.branchName
        }, 'Created worktree for task import analysis');

        await stateManager.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { reason: 'Generating task import prompt' });

        const prompt = generateTaskImportPrompt(taskDescription, repoOwner, repoName, worktreeInfo.worktreePath);


        const registry = AgentRegistry.getInstance();
        await registry.ensureInitialized();
        const { resolvedAlias, resolvedModel } = await resolveDefaultAgentAndModel(registry, correlatedLogger);
        const agent = registry.getAgentByAlias(resolvedAlias);
        if (!agent) throw new Error(`Configured default agent not found: ${resolvedAlias}`);

        const agentResult = await agent.executeTask({
            worktreePath: worktreeInfo.worktreePath,
            issueRef: {
                number: 0,
                repoOwner,
                repoName
            },
            githubToken: githubToken.token,
            prompt,
            branchName: worktreeInfo.branchName,
            model: resolvedModel,
            taskId,
        });

        correlatedLogger.info({
            agentAlias: resolvedAlias,
            model: resolvedModel,
            success: agentResult.success,
            executionTime: agentResult.executionTimeMs,
            conversationTurns: agentResult.conversationLog?.length || 0
        }, 'Task import analysis completed');

        logTaskImportExecution(correlatedLogger, agentResult, repository, user);

        // This job runs a model execution, so its terminal record carries the same evidence every
        // other executed path records: the final (phase-labelled) result and the agent outcome.
        terminalExecutionEvidence = taskImportExecutionEvidence(agentResult);
        // An unsuccessful execution is a failure, never a completion: it settles terminally as
        // failed in the catch below rather than publishing `completed` over a run that did not
        // deliver.
        if (!agentResult.success) throw taskImportExecutionFailure(agentResult);

        await stateManager.updateTaskState(taskId, TaskStates.POST_PROCESSING, { reason: 'Cleaning up worktree' });
        // `completed` is published only once its execution evidence is durable, and the evidence
        // rides on the completed entry itself. See completedExecutionDurability.ts.
        await publishCompletedWithDurableExecutionEvidence({
            stateManager, taskId, correlatedLogger,
            metadata: {
                reason: 'Task completed successfully',
                prResult: { status: 'complete', repository },
                claudeResult: terminalExecutionEvidence.claudeResult,
                historyMetadata: { repository, ...terminalExecutionEvidence.historyMetadata },
            },
        });

        return {
            status: 'complete',
            repository,
            success: agentResult.success,
            jobId,
            claudeResult: {
                success: agentResult.success,
                executionTime: agentResult.executionTimeMs,
                conversationTurns: agentResult.conversationLog?.length || 0,
                stdout: agentResult.rawOutput || agentResult.logs
            }
        };

    } catch (error) {
        if (error instanceof UsageLimitError) {
            return handleSimpleUsageLimitError(error, job as unknown as Job<{ repoOwner: string; repoName: string; number: number; modelName?: string; correlationId?: string }>, correlatedLogger, repository);
        }
        correlatedLogger.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Task import job failed');
        await stateManager.markTaskFailed(taskId, error as Error, {
            errorCategory: ErrorCategories.CLAUDE_EXECUTION,
            ...(terminalExecutionEvidence ?? {}),
        });
        handleError(error, 'Failed to process task import job', { correlationId });
        throw error;
    } finally {
        if (localRepoPath && worktreeInfo) {
            try {
                await cleanupWorktree(localRepoPath, worktreeInfo.worktreePath, worktreeInfo.branchName, {
                    deleteBranch: true,
                    success: true
                });
            } catch (cleanupError) {
                correlatedLogger.warn({ error: (cleanupError as Error).message }, 'Failed to cleanup worktree');
            }
        }
    }
}

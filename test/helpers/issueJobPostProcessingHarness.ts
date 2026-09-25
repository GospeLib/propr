/**
 * Shared module mocks and fixtures for the issue-job post-processing tests. Importing this
 * module installs the mocks before `issueJobPostProcessing.js` is loaded, so it must be the
 * first import of each test file that uses it.
 */
import { mock } from 'node:test';
import { completionCoreExports } from './completionCoreDoubles.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as publicationPolicy from '../../packages/core/src/publication/index.js';
import { requireAuthorizedPublicationMetadata } from '../../packages/core/src/admission/authorizedPublicationMetadata.js';

export const commitChanges = mock.fn(async () => null);
export const pushBranch = mock.fn(async () => undefined);
export const safeUpdateLabels = mock.fn(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
export const generateCompletionComment = mock.fn(async () => 'Generated failure details.');
export const createPullRequest = mock.fn(async () => ({ success: true, pr: null, updatedLabels: [] }));
export const checkpointRecord = (failureClassification: string) => ({
    status: 'preserved', failureClassification, publication: 'none', baseSha: 'e'.repeat(40),
    featureBranch: 'task/signed-timeout', ref: 'refs/propr/checkpoints/task/signed-timeout/task-44', sha: 'c'.repeat(40),
    changedPaths: ['src/partial.ts'], outOfScopePaths: [],
});
export const preserveExecutionCheckpoint = mock.fn(async (options: { failureClassification: string }) => checkpointRecord(options.failureClassification));
export const verifyStoryPublication = mock.fn(async () => []);
/** Task state for a stopped admitted execution; records what had already happened when the terminal entry was written. */
export function stoppedStateManager(failWrite?: Error) {
    const observedAtWrite: Array<{ checkpointsPushed: number; labelUpdates: number }> = [];
    const markTaskFailed = mock.fn(async (_taskId: string, _error: Error, _metadata: Record<string, any>) => {
        observedAtWrite.push({ checkpointsPushed: preserveExecutionCheckpoint.mock.callCount(), labelUpdates: safeUpdateLabels.mock.callCount() });
        if (failWrite) throw failWrite;
        return {};
    });
    return { markTaskFailed, markTaskCompleted: mock.fn(async () => ({})), getTaskState: mock.fn(async () => ({ state: 'claude_execution' })), observedAtWrite };
}
const resolveAgentTerminationReason = mock.fn((result: { terminationReason?: 'timeout' | 'max_turns' }) => result.terminationReason);

// Retained-worktree registrations land in an isolated directory, never the worker default.
export const retentionStoreDir = await mkdtemp(join(tmpdir(), 'propr-retention-store-'));
process.env.CHECKPOINT_RETENTION_DIR = retentionStoreDir;
export const resolveRepositoryGitDir = mock.fn(async () => '/tmp/repo/.git');

await mock.module('timers/promises', {
    namedExports: { setTimeout: mock.fn(async () => undefined) },
});

await mock.module('@propr/core', {
    namedExports: {
        ...(await import('../../packages/core/src/agents/executionFailure.js')),
        ...completionCoreExports, ...publicationPolicy, requireAuthorizedPublicationMetadata,
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges,
        loadRepositoryVisualPreviewSettings: mock.fn(async () => ({ enabled: false, types: ['image'] })),
        prepareVisualPreviewEvidence: mock.fn(async () => ({ evidence: { assets: [], toolSuggestions: [] } })),
        pushBranch,
        verifyStoryPublication,
        preserveExecutionCheckpoint,
        resolveRepositoryGitDir,
        getWorktreesBasePath: () => '/tmp/worktrees',
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        TaskStates: { CANCELLED: 'cancelled' },
        ErrorCategories: { CLAUDE_EXECUTION: 'claude_execution' },
        describeAgentTermination: mock.fn(() => 'Agent stopped.'),
        resolveAgentTerminationReason,
        getAuthenticatedOctokit: mock.fn(),
        linkPRToPlanIssue: mock.fn(),
        safeUpdateLabels,
        generateCompletionComment,
        redactSecrets: (value: string) => value.replace('secret-token', '[REDACTED]'),
        validatePRCreation: mock.fn(),
        // The completion durability barrier reads the task history back after an ambiguous write.
        db: () => ({ where: () => ({ first: async () => undefined }) }),
    },
});

await mock.module('../../src/jobs/issueJobHelpers.js', {
    namedExports: {
        createPullRequest,
        ensureEpicBaseBranchExists: mock.fn(async () => undefined),
    },
});

await mock.module('../../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: {
        handleCreatedPlanIssuePR: mock.fn(async () => undefined),
        handleNoCodeChanges: mock.fn(async () => ({ success: true, pr: null, updatedLabels: ['AI-done'] })),
    },
});

export const { performPostProcessing } = await import('../../src/jobs/issueJobPostProcessing.js');

export const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
} as never;

export function failedAgentResult() {
    return {
        success: false,
        executionTime: 10,
        output: null,
        logs: '',
        modifiedFiles: [],
        commitMessage: null,
        summary: null,
        error: 'Docker rejected secret-token before the agent started',
    };
}
export function stoppedExecutionOptions(overrides: Record<string, unknown>) {
    return {
        execution: { baseSha: 'e'.repeat(40), featureBranch: 'task/signed-timeout', targetBranch: 'stage', allowedPaths: ['src/partial.ts'] },
        octokit: { request: mock.fn(async () => ({ data: {} })) },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 44 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'task/signed-timeout' },
        currentIssueData: { data: { title: 'Partial timeout', labels: [{ name: 'AI' }] } },
        claudeResult: { ...failedAgentResult(), terminationReason: 'timeout', error: 'timed out' },
        modelName: 'codex-test', repoValidation: { isValid: true, repoData: { defaultBranch: 'stage' } },
        repoUrl: 'https://github.com/owner/repo.git', githubToken: { token: 'github-token' }, PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', jobId: 'job-44', correlatedLogger: logger, taskId: 'task-44',
        ...overrides,
    } as never;
}

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end coverage for the retention decision made when a checkpoint push fails
// (issueJobUnpublishableFailure.ts:handleStoppedAdmittedExecution) or succeeds. Uses the
// REAL cleanupWorktree implementation against a real git repo + worktree so the assertion
// is on actual filesystem/git state, not a restated pure function.
const runFile = promisify(execFile);

const { cleanupWorktree } = await import('../packages/core/src/git/worktreeOperations.js');
// Retained-worktree registrations live in an isolated directory, never the worker default.
const retentionStoreDir = await mkdtemp(join(tmpdir(), 'propr-retention-store-'));
process.env.CHECKPOINT_RETENTION_DIR = retentionStoreDir;
// af896baa and a7804233 added transitive core imports; preserve their real implementations.
const core = await import('@propr/core');
const publicationPolicy = await import('../packages/core/src/publication/index.js');
const { requireAuthorizedPublicationMetadata } = await import('../packages/core/src/admission/authorizedPublicationMetadata.js');

await mock.module('@propr/core', {
    namedExports: {
        ...core,
        ...publicationPolicy,
        requireAuthorizedPublicationMetadata,
        cleanupWorktree,
        getWorktreesBasePath: () => tmpdir(),
        resolveRepositoryGitDir: mock.fn(async () => '/tmp/repo/.git'),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges: mock.fn(async () => null),
        loadRepositoryVisualPreviewSettings: mock.fn(async () => ({ enabled: false, types: ['image'] })),
        prepareVisualPreviewEvidence: mock.fn(async () => ({ evidence: { assets: [], toolSuggestions: [] } })),
        pushBranch: mock.fn(async () => undefined),
        verifyStoryPublication: mock.fn(async () => []),
        preserveExecutionCheckpoint: mock.fn(),
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        TaskStates: { CANCELLED: 'cancelled' },
        ErrorCategories: { CLAUDE_EXECUTION: 'claude_execution' },
        describeAgentTermination: mock.fn(() => 'Agent stopped.'),
        resolveAgentTerminationReason: mock.fn(() => undefined),
        getAuthenticatedOctokit: mock.fn(),
        linkPRToPlanIssue: mock.fn(),
        safeUpdateLabels: mock.fn(async () => ({ success: true, removed: [], added: [], errors: [] })),
        generateCompletionComment: mock.fn(async () => ''),
        redactSecrets: (value: string) => value,
        validatePRCreation: mock.fn(),
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: {
        createPullRequest: mock.fn(),
        ensureEpicBaseBranchExists: mock.fn(async () => undefined),
    },
});

await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: {
        handleCreatedPlanIssuePR: mock.fn(async () => undefined),
        handleNoCodeChanges: mock.fn(async () => ({ success: true, pr: null, updatedLabels: [] })),
    },
});

const { cleanupWorktreeIfExists } = await import('../src/jobs/issueJobPostProcessing.js');

const logger = { debug: mock.fn(), info: mock.fn(), warn: mock.fn(), error: mock.fn() } as never;

async function makeRepoWithWorktree() {
    const base = await mkdtemp(join(tmpdir(), 'propr-retention-'));
    const repoPath = join(base, 'repo');
    const worktreePath = join(base, 'worktree');
    await runFile('git', ['init', '-q', repoPath]);
    await runFile('git', ['-C', repoPath, 'config', 'user.email', 'a@b.c']);
    await runFile('git', ['-C', repoPath, 'config', 'user.name', 'Test']);
    await runFile('git', ['-C', repoPath, 'commit', '--allow-empty', '-q', '-m', 'init']);
    await runFile('git', ['-C', repoPath, 'branch', 'task-branch']);
    await runFile('git', ['-C', repoPath, 'worktree', 'add', worktreePath, 'task-branch']);
    return { base, repoPath, worktreePath };
}

function checkpoint(status: 'failed' | 'preserved') {
    return {
        status, failureClassification: 'agent_error' as const, publication: 'none' as const,
        baseSha: 'e'.repeat(40), featureBranch: 'task-branch', changedPaths: [], outOfScopePaths: [],
        ...(status === 'preserved' ? { ref: 'refs/propr/checkpoints/task-branch/t1', sha: 'c'.repeat(40) } : { error: 'push failed: remote rejected' }),
    };
}

test('a failed checkpoint push retains the worktree and its local commit for recovery', async () => {
    const { base, repoPath, worktreePath } = await makeRepoWithWorktree();
    try {
        await cleanupWorktreeIfExists({
            worktreeInfo: { worktreePath, branchName: 'task-branch' } as never,
            localRepoPath: repoPath,
            claudeResult: { success: false } as never,
            postProcessingResult: {
                success: false, pr: null, updatedLabels: [],
                executionCheckpoint: checkpoint('failed'),
                retainedWorktreePath: worktreePath,
            } as never,
            jobId: 'job-1',
            issueRef: { repoOwner: 'o', repoName: 'r', number: 1 } as never,
            correlatedLogger: logger,
        });

        // The worktree directory is still there, still a valid worktree, and the local
        // branch/commit are unchanged: nothing was deleted.
        await access(worktreePath);
        const { stdout: worktreeList } = await runFile('git', ['-C', repoPath, 'worktree', 'list']);
        assert.match(worktreeList, new RegExp(worktreePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        const { stdout: branchSha } = await runFile('git', ['-C', repoPath, 'rev-parse', '--verify', 'task-branch']);
        assert.match(branchSha.trim(), /^[0-9a-f]{40}$/);
    } finally {
        await runFile('git', ['-C', repoPath, 'worktree', 'remove', worktreePath, '--force']).catch(() => {});
        await rm(base, { recursive: true, force: true });
    }
});

test('a successful checkpoint still allows normal cleanup to delete the worktree', async () => {
    const { base, repoPath, worktreePath } = await makeRepoWithWorktree();
    try {
        await cleanupWorktreeIfExists({
            worktreeInfo: { worktreePath, branchName: 'task-branch' } as never,
            localRepoPath: repoPath,
            claudeResult: { success: false } as never,
            postProcessingResult: {
                success: false, pr: null, updatedLabels: [],
                executionCheckpoint: checkpoint('preserved'),
            } as never,
            jobId: 'job-2',
            issueRef: { repoOwner: 'o', repoName: 'r', number: 2 } as never,
            correlatedLogger: logger,
        });

        await assert.rejects(access(worktreePath));
    } finally {
        await rm(base, { recursive: true, force: true });
    }
});

test('a worktree registered for checkpoint retention is kept even when no post-processing result reached cleanup', async () => {
    const { base, repoPath, worktreePath } = await makeRepoWithWorktree();
    const { saveRetainedCheckpoint, removeRetainedCheckpoint } = await import('../src/jobs/checkpointRetentionStore.js');
    await saveRetainedCheckpoint({ taskId: 't3', worktreePath, branchName: 'task-branch', gitDir: join(repoPath, '.git'),
        retainedAt: new Date().toISOString(), publishAttempts: 0 });
    try {
        await cleanupWorktreeIfExists({
            worktreeInfo: { worktreePath, branchName: 'task-branch' } as never,
            localRepoPath: repoPath,
            claudeResult: { success: false } as never,
            // An error thrown after the checkpoint attempt leaves no post-processing result.
            postProcessingResult: null,
            jobId: 'job-3',
            issueRef: { repoOwner: 'o', repoName: 'r', number: 3 } as never,
            correlatedLogger: logger,
        });
        await access(worktreePath);
    } finally {
        await removeRetainedCheckpoint(worktreePath);
        await runFile('git', ['-C', repoPath, 'worktree', 'remove', worktreePath, '--force']).catch(() => {});
        await rm(base, { recursive: true, force: true });
    }
});

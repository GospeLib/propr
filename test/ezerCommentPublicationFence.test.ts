import * as cancellation from '../packages/core/src/admission/executionAdmissionCancellation.js';
import assert from 'node:assert/strict';
import { completionCoreExports } from './helpers/completionCoreDoubles.js';
import { mock, test } from 'node:test';
import * as visualPreview from '../packages/core/src/services/visualPreviewService.js';

const commitChanges = mock.fn(async () => ({
    commitHash: 'a'.repeat(40),
    commitMessage: 'partial correction',
    filesChanged: ['docs/spikes/ezer-artifact.md'],
}));
const pushBranch = mock.fn(async () => ({ rebased: false }));
const buildCompletionComment = mock.fn(async () => 'completion');
const markReviewFindingsProcessed = mock.fn(async () => undefined);
const updateTaskState = mock.fn(async () => undefined);
const patchComment = mock.fn(async () => ({ data: { html_url: 'https://example.test/comment/1', body: 'completion' } }));

await mock.module('@propr/core', {
    namedExports: { ...cancellation, ...publicationPolicy, ...visualPreview, ...completionCoreExports,
        loadRepositoryVisualPreviewSettings: async () => ({ enabled: false, types: [] }),
        prepareVisualPreviewEvidence: async () => ({ evidence: { assets: [], toolSuggestions: [] } }),
        cleanupPreparedVisualPreviewEvidence: async () => undefined,
        commitChanges,
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        db: mock.fn(() => ({ where: mock.fn(() => ({ update: mock.fn(async () => undefined), first: mock.fn(async () => undefined) })) })),
        getRepoUrl: mock.fn(() => 'https://example.test/owner/repo.git'),
        getAuthenticatedOctokit: mock.fn(),
        pushBranch,
        resolveAgentTerminationReason: (result: { terminationReason?: string }) => result.terminationReason,
        TaskStates: { COMPLETED: 'completed' },
        ErrorCategories: { POST_PROCESSING: 'post_processing' },
        redactSecrets: (value: string) => value,
    },
});

await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment },
});
await mock.module('../src/github/visualPreviewAttachments.js', {
    namedExports: { isVisualPreviewUploadAuthenticationError: () => false,
        publishPullRequestCommentVisualPreviews: async () => { throw new Error('unexpected preview upload'); } },
});

await mock.module('../src/jobs/prCommentJobUtils.js', {
    namedExports: { buildCommitMessage: mock.fn(() => 'partial correction') },
});

await mock.module('../src/jobs/reviewCommentGatherer.js', {
    namedExports: { markReviewFindingsProcessed },
});

await mock.module('../src/jobs/ultrafixJobHelpers.js', {
    namedExports: { resolveUltrafixHistoryMeta: mock.fn(async () => ({})) },
});

const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');

const baseState = {
    octokit: {
        auth: mock.fn(async () => ({ token: 'test-token' })),
        request: patchComment,
    },
    worktreeInfo: { worktreePath: '/tmp/ezer-comment-worktree', branchName: 'task/ezer-comment' },
    authorsText: '@owner',
    unprocessedComments: [{ id: 17, body: '/ezer correct the artifact', author: 'owner', type: 'issue' as const }],
    startingWorkComment: { data: { id: 19, html_url: 'https://example.test/comment/19' } },
};

function resetPublicationCalls(): void {
    commitChanges.mock.resetCalls();
    pushBranch.mock.resetCalls();
    buildCompletionComment.mock.resetCalls();
    markReviewFindingsProcessed.mock.resetCalls();
    updateTaskState.mock.resetCalls();
    patchComment.mock.resetCalls();
}

async function expectAdmittedCorrectionRefusal(claudeResult: Record<string, unknown>): Promise<void> {
    resetPublicationCalls();
    await assert.rejects(() => handlePostExecution({
        state: { ...baseState, claudeResult },
        job: { data: { commandMode: 'default' } },
        taskId: 'task-ezer-comment',
        stateManager: { updateTaskState },
        context: {
            pullRequestNumber: 41,
            repoOwner: 'owner',
            repoName: 'repo',
            correlatedLogger: { info: mock.fn(), warn: mock.fn() },
        },
        unprocessedReviewComments: [],
        llm: 'claude-test',
        redisClient: {},
        prProcessingLockKey: 'lock-key',
        prProcessingLockToken: 'lock-token',
        ezerAdmissionVerified: true,
    } as never, 'https://example.test/tasks/task-ezer-comment'), /ezer-comment-refused:incomplete-execution/);

    assert.equal(commitChanges.mock.callCount(), 0);
    assert.equal(pushBranch.mock.callCount(), 0);
    assert.equal(buildCompletionComment.mock.callCount(), 0);
    assert.equal(patchComment.mock.callCount(), 0);
    assert.equal(markReviewFindingsProcessed.mock.callCount(), 0);
    assert.equal(updateTaskState.mock.callCount(), 0);
}

test('an interrupted Ezer-admitted correction cannot publish partial changes or a completion', async () => {
    await expectAdmittedCorrectionRefusal({
        success: false,
        terminationReason: 'timeout',
        error: 'execution deadline exceeded',
        modifiedFiles: ['docs/spikes/ezer-artifact.md'],
    });
});

test('incomplete metadata fails closed even when an admitted correction reports success', async () => {
    await expectAdmittedCorrectionRefusal({
        success: true,
        terminationReason: 'max_turns',
        modifiedFiles: ['docs/spikes/ezer-artifact.md'],
    });
});

test('legacy unsigned follow-up semantics still publish explicitly partial work', async () => {
    resetPublicationCalls();
    const result = await handlePostExecution({
        state: {
            ...baseState,
            claudeResult: {
                success: false,
                terminationReason: 'timeout',
                error: 'legacy execution timeout',
                modifiedFiles: ['docs/spikes/ezer-artifact.md'],
            },
        },
        job: { data: { commandMode: 'default' } },
        taskId: 'task-legacy-comment',
        stateManager: { updateTaskState },
        context: {
            pullRequestNumber: 41,
            repoOwner: 'owner',
            repoName: 'repo',
            correlatedLogger: { info: mock.fn(), warn: mock.fn() },
        },
        unprocessedReviewComments: [],
        llm: 'claude-test',
        redisClient: {},
        prProcessingLockKey: 'lock-key',
        prProcessingLockToken: 'lock-token',
        ezerAdmissionVerified: false,
    } as never, 'https://example.test/tasks/task-legacy-comment');

    assert.equal(result.partial, true);
    assert.equal(commitChanges.mock.callCount(), 1);
    assert.equal(pushBranch.mock.callCount(), 1);
    assert.equal(buildCompletionComment.mock.callCount(), 1);
    assert.equal(patchComment.mock.callCount(), 1);
    assert.equal(updateTaskState.mock.callCount(), 1);
});
import * as publicationPolicy from '../packages/core/src/publication/index.js';

for (const cancelAt of ['before-commit', 'before-push', 'after-push'] as const) test(`actual publication ${cancelAt} honours tombstone without a result comment`, async () => {
    resetPublicationCalls();
    let cancelled = cancelAt === 'before-commit';
    commitChanges.mock.mockImplementation(async () => {
        if (cancelAt === 'before-push') cancelled = true;
        return { commitHash: 'a'.repeat(40), commitMessage: 'change', filesChanged: ['file.ts'] };
    });
    pushBranch.mock.mockImplementation(async () => {
        if (cancelAt === 'after-push') cancelled = true;
        return { rebased: false };
    });
    const state = { ...baseState, claudeResult: { success: true } };
    await assert.rejects(() => handlePostExecution({
        state, job: { id: 'admitted', data: { executionAdmissionReceipt: { admissionId: 'admission' } } },
        taskId: 'admitted', stateManager: { updateTaskState },
        context: { repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 41, correlatedLogger: { info: mock.fn(), warn: mock.fn() } },
        unprocessedReviewComments: [], redisClient: { get: async () => cancelled ? 'tombstone' : null },
        prProcessingLockKey: 'lock', prProcessingLockToken: 'token', ezerAdmissionVerified: true,
    } as never, 'https://example.test/task'), (error: unknown) => {
        assert.ok(error instanceof cancellation.AdmissionCancelledError);
        assert.equal(error.pushedHead, cancelAt === 'after-push' ? 'a'.repeat(40) : undefined);
        return true;
    });
    assert.equal(commitChanges.mock.callCount(), cancelAt === 'before-commit' ? 0 : 1);
    assert.equal(pushBranch.mock.callCount(), cancelAt === 'after-push' ? 1 : 0);
    assert.equal(patchComment.mock.callCount(), 0);
});

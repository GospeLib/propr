import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const createWorktreeForIssue = mock.fn(async () => ({ worktreePath: '/tmp/x', branchName: 'task/x' }));
const pushBranch = mock.fn(async () => ({ rebased: false }));

await mock.module('@propr/core', {
    namedExports: {
        createWorktreeForIssue,
        pushBranch,
        TaskStates: { CANCELLED: 'cancelled' },
        updateFileChangesFromWorktree: mock.fn(async () => []),
        verifyStoryPublication: mock.fn(async () => []),
    },
});
await mock.module('../src/jobs/issueJob/github.js', {
    namedExports: {
        fetchIssueComments: mock.fn(async () => { throw new Error('ISSUE_COMMENTS_UNREADABLE: HTTP 502'); }),
    },
});
await mock.module('../src/jobs/storyPublicationPolicy.js', { namedExports: { requireStoryPublicationPolicy: mock.fn(async () => undefined) } });
await mock.module('../src/jobs/recordedExecutionCheckpoint.js', { namedExports: { requireIssueRecordedCheckpoint: mock.fn(async () => undefined) } });
await mock.module('../src/jobs/issueJob/agent.js', { namedExports: { executeAgentAndRecordMetrics: mock.fn(async () => ({})) } });
await mock.module('../src/jobs/issueJobPostProcessing.js', { namedExports: { performPostProcessing: mock.fn(async () => ({})) } });

const { executeWorktreeOperations } = await import('../src/jobs/issueJob/worktree.js');

test('an unreadable comment list is refused before any worktree, notice or pushed branch exists', async () => {
    const octokitRequest = mock.fn(async () => ({ data: [] }));
    await assert.rejects(() => executeWorktreeOperations({
        job: { updateProgress: mock.fn(async () => undefined) },
        context: {
            issueRef: { repoOwner: 'owner', repoName: 'repo', number: 41, baseBranch: 'stage' },
            agentAlias: 'claude', modelName: 'claude-test', taskId: 'task-id',
            correlatedLogger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
            stateManager: { getTaskState: mock.fn(async () => null) },
            AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', PR_LABEL: 'propr',
        },
        octokit: { request: octokitRequest },
        currentIssueData: { data: { title: 'Story', labels: [] } },
        repoValidation: { isValid: true, repoData: { defaultBranch: 'stage' } },
        githubToken: { token: 'test-token' },
        repoUrl: 'https://example.test/owner/repo.git',
        localRepoPath: '/tmp/repo',
    } as never), /ISSUE_COMMENTS_UNREADABLE/);
    assert.equal(createWorktreeForIssue.mock.callCount(), 0, 'no worktree for a refused issue');
    assert.equal(pushBranch.mock.callCount(), 0, 'no branch a retry would trip over');
    assert.equal(octokitRequest.mock.callCount(), 0, 'no start notice posted');
});

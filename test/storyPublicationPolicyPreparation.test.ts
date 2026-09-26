import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

const executeAgentAndRecordMetrics = mock.fn(async () => ({ success: true, modifiedFiles: [] }));
const performPostProcessing = mock.fn(async () => ({ commitResult: null, postProcessingResult: null }));
const verifyStoryPublication = mock.fn(async () => []);
const pushBranch = mock.fn(async () => ({ rebased: false }));

await mock.module('@propr/core', {
    namedExports: {
        ...publicationPolicy,
        ...(await import('../packages/core/src/admission/executionRecoveryContext.js')),
        createWorktreeForIssue: mock.fn(async (_repo: string, _issue: unknown, options: { execution?: unknown }) => {
            assert.ok(options.execution, 'the exact signed execution must create the worktree');
            return { worktreePath: policyWorktree, branchName: 'task/signed-story' };
        }),
        pushBranch,
        TaskStates: { CANCELLED: 'cancelled' },
        updateFileChangesFromWorktree: mock.fn(async () => []),
        verifyStoryPublication,
    },
});

await mock.module('../src/jobs/issueJob/github.js', {
    namedExports: { fetchIssueComments: mock.fn(async () => []) },
});

await mock.module('../src/jobs/issueJob/agent.js', {
    namedExports: { executeAgentAndRecordMetrics },
});

await mock.module('../src/jobs/issueJobPostProcessing.js', {
    namedExports: { performPostProcessing },
});

const policyWorktree = await mkdtemp(join(tmpdir(), 'propr-pre-agent-policy-'));
await mkdir(join(policyWorktree, 'checks'), { recursive: true });
await mkdir(join(policyWorktree, '.github'), { recursive: true });
await writeFile(join(policyWorktree, 'checks/spec-link.sh'), 'repository task-link gate\n');
await writeFile(join(policyWorktree, '.github/PULL_REQUEST_TEMPLATE.md'), 'Commits carry a Task: <story>-<task> trailer.\n');

const { executeWorktreeOperations } = await import('../src/jobs/issueJob/worktree.js');

async function expectPreAgentPolicyRefusal(storyId: string, expectedError: RegExp): Promise<void> {
    executeAgentAndRecordMetrics.mock.resetCalls();
    performPostProcessing.mock.resetCalls();
    pushBranch.mock.resetCalls();
    verifyStoryPublication.mock.resetCalls();
    const octokitRequest = mock.fn(async () => ({ data: [] }));

    await assert.rejects(() => executeWorktreeOperations({
        job: { updateProgress: mock.fn(async () => undefined) },
        context: {
            issueRef: {
                repoOwner: 'owner', repoName: 'repo', number: 41, baseBranch: 'stage',
                executionAdmissionReceipt: {
                    admissionId: 'admission', operationId: 'operation', receiptKey: 'receipt',
                    storyId,
                },
            },
            storyExecution: {
                baseSha: 'a'.repeat(40), featureBranch: 'task/signed-story',
                targetBranch: 'stage', allowedPaths: ['src/complete.ts'],
            },
            agentAlias: 'claude', modelName: 'claude-test', taskId: 'task-id',
            correlatedLogger: { info: mock.fn(), warn: mock.fn() },
            stateManager: { getTaskState: mock.fn(async () => null) },
            AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', PR_LABEL: 'propr',
        },
        octokit: { request: octokitRequest },
        currentIssueData: { data: { title: 'Signed story', labels: [] } },
        repoValidation: { isValid: true, repoData: { defaultBranch: 'stage' } },
        githubToken: { token: 'test-token' },
        repoUrl: 'https://example.test/owner/repo.git',
        localRepoPath: '/tmp/exact-base-repo',
    } as never), expectedError);

    assert.equal(verifyStoryPublication.mock.callCount(), 1, 'exact base and signed scope must be checked first');
    assert.equal(executeAgentAndRecordMetrics.mock.callCount(), 0, 'the worker receipt and model boundary must not be reached');
    assert.equal(performPostProcessing.mock.callCount(), 0);
    assert.equal(pushBranch.mock.callCount(), 0);
    assert.equal(octokitRequest.mock.callCount(), 1, 'only the pre-existing-PR query may run before policy refusal');
}

test('missing signed story spec link refuses exact-base preparation before agent or publication', async () => {
    await expectPreAgentPolicyRefusal('EP-publication-policy-S01-T02', /STORY_PUBLICATION_SPEC_LINK_REQUIRED/);
});

test('story-only authority cannot reach the agent when exact-base policy requires a signed task', async () => {
    await expectPreAgentPolicyRefusal('EP-publication-policy-S01', /STORY_PUBLICATION_TASK_ID_REQUIRED/);
});
import * as publicationPolicy from '../packages/core/src/publication/index.js';

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { commitChanges, pushBranch, preserveExecutionCheckpoint, checkpointRecord,
    stoppedExecutionOptions, stoppedStateManager } from './helpers/issueJobPostProcessingHarness.js';

let finished = false;
let stopped = false;
await mock.module('../src/jobs/issueJob/agent.js', { namedExports: {
    executeAgentAndRecordMetrics: async () => {
        finished = true; // The installation token used for setup expires during the agent run.
        return { success: !stopped, modifiedFiles: ['src/partial.ts'],
            ...(stopped ? { terminationReason: 'timeout', error: 'deadline' } : {}) };
    },
} });
await mock.module('../src/jobs/issueJob/github.js', { namedExports: { fetchIssueComments: async () => [] } });
await mock.module('../src/jobs/recordedExecutionCheckpoint.js', { namedExports: { requireIssueRecordedCheckpoint: async () => undefined } });
const { executeWorktreeOperations } = await import('../src/jobs/issueJob/worktree.js');

for (const timeout of [false, true]) test(`issue worker refreshes token for ${timeout ? 'timeout checkpoint' : 'successful branch'} publication`, async () => {
    finished = false; stopped = timeout;
    const tokens: string[] = [];
    const auth = mock.fn(async () => ({ token: finished ? 'fresh' : 'expired' }));
    const authenticate = async (options: any) => {
        const token = options.tokenRefreshFn ? await options.tokenRefreshFn() : options.authToken;
        assert.equal(token, finished ? 'fresh' : 'expired', 'Git rejects the expired setup token after execution');
        tokens.push(token);
    };
    pushBranch.mock.mockImplementation(async (...args: any[]) => { await authenticate(args[2]); });
    preserveExecutionCheckpoint.mock.mockImplementation(async (options: any) => {
        await authenticate(options);
        return checkpointRecord(options.failureClassification);
    });
    commitChanges.mock.mockImplementation(async () => ({ commitHash: 'c'.repeat(40), filesChanged: ['src/partial.ts'] }) as never);
    const options = stoppedExecutionOptions({}) as any;
    options.issueRef.executionAdmissionReceipt = { storyId: 'EP-fresh-token-S01' };
    const stateManager = stoppedStateManager();
    const result = await executeWorktreeOperations({
        job: { updateProgress: async () => undefined },
        context: { ...options, stateManager, storyExecution: timeout ? options.execution : undefined },
        octokit: { auth, request: async () => ({ data: [] }) },
        currentIssueData: options.currentIssueData, repoValidation: options.repoValidation,
        githubToken: await auth(), repoUrl: options.repoUrl, localRepoPath: '/tmp/repo',
    } as never);
    assert.deepEqual(tokens, ['expired', 'fresh']);
    assert.equal(result.claudeResult.success, !timeout);
    if (timeout) assert.equal(result.postProcessingResult?.executionCheckpoint?.status, 'preserved');
    else assert.equal(result.commitResult?.commitHash, 'c'.repeat(40));
});

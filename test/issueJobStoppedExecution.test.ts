import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import {
    commitChanges, pushBranch, safeUpdateLabels, generateCompletionComment, createPullRequest, checkpointRecord, preserveExecutionCheckpoint, verifyStoryPublication, stoppedStateManager, retentionStoreDir, performPostProcessing, logger, failedAgentResult, stoppedExecutionOptions,
} from './helpers/issueJobPostProcessingHarness.js';

for (const [terminationReason, error] of [
    ['timeout', 'Agent execution timed out after the signed deadline'],
    ['max_turns', 'The agent reached the maximum turn limit'],
    [undefined, 'Agent process exited with code 1'],
] as const) test(`a signed story stopped by ${terminationReason ?? 'an agent error'} checkpoints partial work and never publishes it`, async () => {
    commitChanges.mock.resetCalls();
    preserveExecutionCheckpoint.mock.resetCalls();
    verifyStoryPublication.mock.resetCalls();
    commitChanges.mock.mockImplementation(async () => ({
        commitHash: 'd'.repeat(40),
        commitMessage: 'raw model prose',
        filesChanged: ['src/partial.ts'],
    }));
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
    generateCompletionComment.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    const request = mock.fn(async () => ({ data: {} }));
    const stateManager = stoppedStateManager();

    const result = await performPostProcessing({
        execution: {
            baseSha: 'e'.repeat(40),
            featureBranch: 'task/signed-timeout',
            targetBranch: 'stage',
            allowedPaths: ['src/partial.ts'],
        },
        octokit: { request },
        issueRef: {
            repoOwner: 'owner',
            repoName: 'repo',
            number: 44,
            executionAdmissionReceipt: {
                admissionId: 'admission-timeout',
                operationId: 'operation-timeout',
                receiptKey: 'receipt-timeout',
                storyId: 'EP-publication-policy-S01-T02',
            },
        },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'task/signed-timeout' },
        currentIssueData: { data: { title: 'Partial timeout', labels: [{ name: 'AI' }] } },
        claudeResult: {
            ...failedAgentResult(),
            ...(terminationReason ? { terminationReason } : {}),
            error,
        },
        taskId: 'task-44',
        stateManager,
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'stage' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-44',
        correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls.length, 0);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
    assert.equal(result.commitResult, null);
    assert.equal(result.postProcessingResult?.success, false);
    assert.equal(verifyStoryPublication.mock.calls.length, 0);
    assert.equal(preserveExecutionCheckpoint.mock.calls.length, 1);
    const checkpointOptions = preserveExecutionCheckpoint.mock.calls[0].arguments[0] as Record<string, unknown>;
    assert.equal(checkpointOptions.taskId, 'task-44');
    assert.equal(checkpointOptions.worktreePath, '/tmp/worktree');
    assert.equal(checkpointOptions.failureClassification, terminationReason ?? 'agent_error');
    assert.deepEqual(result.postProcessingResult?.executionCheckpoint, checkpointRecord(terminationReason ?? 'agent_error'));
    // The failed terminal record naming the checkpoint is durable before any later step (labels, cleanup) runs.
    assert.equal(result.postProcessingResult?.terminalStateRecorded, true);
    assert.equal(stateManager.markTaskFailed.mock.callCount(), 1);
    assert.deepEqual(stateManager.observedAtWrite, [{ checkpointsPushed: 1, labelUpdates: 0 }]);
    const [taskId, , metadata] = stateManager.markTaskFailed.mock.calls[0].arguments;
    assert.equal(taskId, 'task-44');
    assert.equal(metadata.requireDurableHistory, true);
    assert.deepEqual(metadata.historyMetadata.executionCheckpoint, checkpointRecord(terminationReason ?? 'agent_error'));
    assert.equal(metadata.historyMetadata.agentOutcome.failureClassification, terminationReason ?? 'agent_error');
    assert.deepEqual(metadata.prResult.executionCheckpoint, checkpointRecord(terminationReason ?? 'agent_error'));
    assert.equal(stateManager.markTaskCompleted.mock.callCount(), 0);
});

test('failure injected after the checkpoint push still leaves a durable terminal record naming it', async () => {
    preserveExecutionCheckpoint.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    // Crash at the boundary between checkpoint preservation and cleanup: the label step dies.
    safeUpdateLabels.mock.mockImplementation(async () => { throw new Error('worker crashed before cleanup'); });
    const stateManager = stoppedStateManager();
    await assert.rejects(performPostProcessing(stoppedExecutionOptions({ stateManager })), /worker crashed before cleanup/);
    assert.equal(stateManager.markTaskFailed.mock.callCount(), 1);
    assert.deepEqual(stateManager.observedAtWrite, [{ checkpointsPushed: 1, labelUpdates: 0 }]);
    const [, , metadata] = stateManager.markTaskFailed.mock.calls[0].arguments;
    assert.equal(metadata.requireDurableHistory, true);
    assert.deepEqual(metadata.historyMetadata.executionCheckpoint, checkpointRecord('timeout'));
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
});

test('a terminal record that cannot be made durable fails loudly and still carries the checkpoint', async () => {
    preserveExecutionCheckpoint.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    const stateManager = stoppedStateManager(new Error('Durable database history entry required'));
    await assert.rejects(performPostProcessing(stoppedExecutionOptions({ stateManager })), (error: Error & { executionCheckpoint?: unknown }) => {
        assert.match(error.message, /Durable database history entry required/);
        assert.deepEqual(error.executionCheckpoint, checkpointRecord('timeout'));
        return true;
    });
    assert.equal(safeUpdateLabels.mock.callCount(), 0);
});

test('a failed checkpoint push registers the retained worktree with the checkpoint-retention reconciler', async () => {
    preserveExecutionCheckpoint.mock.resetCalls();
    preserveExecutionCheckpoint.mock.mockImplementationOnce(async () => ({ ...checkpointRecord('timeout'), status: 'failed',
        localRef: 'refs/propr/local-checkpoints/task/signed-timeout/task-44', error: 'push rejected' }));
    const { listRetainedCheckpoints } = await import('../src/jobs/checkpointRetentionStore.js');
    const result = await performPostProcessing(stoppedExecutionOptions({ stateManager: stoppedStateManager() }));
    assert.equal(result.postProcessingResult?.retainedWorktreePath, '/tmp/worktree');
    const { entries } = await listRetainedCheckpoints(retentionStoreDir);
    assert.equal(entries.length, 1);
    assert.deepEqual({ ...entries[0], retainedAt: undefined }, { taskId: 'task-44', worktreePath: '/tmp/worktree',
        branchName: 'task/signed-timeout', gitDir: '/tmp/repo/.git', retainedAt: undefined, publishAttempts: 0 });
});

test('an admitted execution without a task record never pushes an unrecorded checkpoint', async () => {
    preserveExecutionCheckpoint.mock.resetCalls();
    await assert.rejects(performPostProcessing(stoppedExecutionOptions({ stateManager: undefined })), /STORY_EXECUTION_TERMINAL_STATE_UNAVAILABLE/);
    assert.equal(preserveExecutionCheckpoint.mock.callCount(), 0);
});

test('a checkpoint preserved before a later failure-handling error still reaches the task record', async () => {
    preserveExecutionCheckpoint.mock.resetCalls();
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: false, removed: [], added: [], errors: ['label API down'] }));
    const stateManager = stoppedStateManager();
    await assert.rejects(performPostProcessing({ stateManager,
        execution: { baseSha: 'e'.repeat(40), featureBranch: 'task/signed-timeout', targetBranch: 'stage', allowedPaths: ['src/partial.ts'] },
        octokit: { request: mock.fn(async () => ({ data: {} })) },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 44 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'task/signed-timeout' },
        currentIssueData: { data: { title: 'Partial timeout', labels: [{ name: 'AI' }] } },
        claudeResult: { ...failedAgentResult(), terminationReason: 'timeout', error: 'timed out' },
        modelName: 'codex-test', repoValidation: { isValid: true, repoData: { defaultBranch: 'stage' } },
        repoUrl: 'https://github.com/owner/repo.git', githubToken: { token: 'github-token' }, PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done', jobId: 'job-44', correlatedLogger: logger, taskId: 'task-44',
    } as never), (error: Error & { executionCheckpoint?: unknown }) => {
        assert.match(error.message, /processing label/);
        assert.deepEqual(error.executionCheckpoint, checkpointRecord('timeout'));
        return true;
    });
    assert.equal(stateManager.markTaskFailed.mock.callCount(), 1);
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
});

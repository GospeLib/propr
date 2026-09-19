import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const commitChanges = mock.fn(async () => null);
const pushBranch = mock.fn(async () => undefined);
const safeUpdateLabels = mock.fn(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
const generateCompletionComment = mock.fn(async () => 'Generated failure details.');
const createPullRequest = mock.fn(async () => ({ success: true, pr: null, updatedLabels: [] }));
const checkpointRecord = (failureClassification: string) => ({
    status: 'preserved', failureClassification, publication: 'none', baseSha: 'e'.repeat(40),
    featureBranch: 'task/signed-timeout', ref: 'refs/propr/checkpoints/task/signed-timeout/task-44', sha: 'c'.repeat(40),
    changedPaths: ['src/partial.ts'], outOfScopePaths: [],
});
const preserveExecutionCheckpoint = mock.fn(async (options: { failureClassification: string }) => checkpointRecord(options.failureClassification));
const verifyStoryPublication = mock.fn(async () => []);
/** Task state for a stopped admitted execution; records what had already happened when the terminal entry was written. */
function stoppedStateManager(failWrite?: Error) {
    const observedAtWrite: Array<{ checkpointsPushed: number; labelUpdates: number }> = [];
    const markTaskFailed = mock.fn(async (_taskId: string, _error: Error, _metadata: Record<string, any>) => {
        observedAtWrite.push({ checkpointsPushed: preserveExecutionCheckpoint.mock.callCount(), labelUpdates: safeUpdateLabels.mock.callCount() });
        if (failWrite) throw failWrite;
        return {};
    });
    return { markTaskFailed, markTaskCompleted: mock.fn(async () => ({})), getTaskState: mock.fn(async () => ({ state: 'claude_execution' })), observedAtWrite };
}
const resolveAgentTerminationReason = mock.fn((result: { terminationReason?: 'timeout' | 'max_turns' }) => result.terminationReason);

await mock.module('timers/promises', {
    namedExports: { setTimeout: mock.fn(async () => undefined) },
});

await mock.module('@propr/core', {
    namedExports: { ...publicationPolicy, requireAuthorizedPublicationMetadata,
        cleanupWorktree: mock.fn(async () => undefined),
        cleanupPreparedVisualPreviewEvidence: mock.fn(async () => undefined),
        commitChanges,
        loadRepositoryVisualPreviewSettings: mock.fn(async () => ({ enabled: false, types: ['image'] })),
        prepareVisualPreviewEvidence: mock.fn(async () => ({ evidence: { assets: [], toolSuggestions: [] } })),
        pushBranch,
        verifyStoryPublication,
        preserveExecutionCheckpoint,
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
    },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: {
        createPullRequest,
        ensureEpicBaseBranchExists: mock.fn(async () => undefined),
    },
});

await mock.module('../src/jobs/issueJobPostProcessingHelpers.js', {
    namedExports: {
        handleCreatedPlanIssuePR: mock.fn(async () => undefined),
        handleNoCodeChanges: mock.fn(async () => ({ success: true, pr: null, updatedLabels: ['AI-done'] })),
    },
});

const { performPostProcessing } = await import('../src/jobs/issueJobPostProcessing.js');

const logger = {
    debug: mock.fn(),
    info: mock.fn(),
    warn: mock.fn(),
    error: mock.fn(),
} as never;

function failedAgentResult() {
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

test('an agent failure without publishable work remains retryable and never creates an empty PR', async () => {
    commitChanges.mock.resetCalls();
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
    generateCompletionComment.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    const request = mock.fn(async () => ({ data: {} }));

    const result = await performPostProcessing({
        octokit: { request },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 42 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'propr/42-fix' },
        currentIssueData: { data: { title: 'Fix startup', labels: [{ name: 'AI' }] } },
        claudeResult: failedAgentResult(),
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-42',
        correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls.length, 0);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[2], []);
    assert.deepEqual(result, {
        commitResult: null,
        postProcessingResult: {
            success: false,
            pr: null,
            updatedLabels: [],
            error: 'Docker rejected secret-token before the agent started',
        },
    });

    assert.equal(request.mock.calls.length, 1);
    const comment = request.mock.calls[0].arguments[1].body as string;
    assert.match(comment, /failed before producing publishable work/i);
    assert.match(comment, /\[REDACTED\]/);
    assert.doesNotMatch(comment, /Post-processing encountered an error/);
    assert.doesNotMatch(comment, /AI-done/);
    assert.deepEqual(generateCompletionComment.mock.calls[0].arguments[2], { publishedAs: 'issue_comment' });
});

test('an unsuccessful processing-label removal is retried by failure post-processing', async () => {
    commitChanges.mock.resetCalls();
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    generateCompletionComment.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    let labelUpdateAttempt = 0;
    safeUpdateLabels.mock.mockImplementation(async () => {
        labelUpdateAttempt += 1;
        return labelUpdateAttempt === 1
            ? { success: false, removed: [], added: [], errors: ["Failed to remove 'AI-processing'"] }
            : { success: true, removed: ['AI-processing'], added: [], errors: [] };
    });
    const request = mock.fn(async () => ({ data: {} }));

    const result = await performPostProcessing({
        octokit: { request },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 42 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'propr/42-fix' },
        currentIssueData: { data: { title: 'Fix startup', labels: [{ name: 'AI' }] } },
        claudeResult: failedAgentResult(),
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-42',
        correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls.length, 0);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
    assert.equal(safeUpdateLabels.mock.calls.length, 2);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[2], []);
    assert.deepEqual(safeUpdateLabels.mock.calls[1].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[1].arguments[2], []);
    assert.equal(result.postProcessingResult?.success, false);
    assert.match(result.postProcessingResult?.error || '', /Failed to remove the processing label/);
    assert.equal(request.mock.calls.length, 1);
    assert.match(request.mock.calls[0].arguments[1].body as string, /Post-processing Error/);
});

test('an interrupted execution without a commit remains retryable and never creates an empty PR', async () => {
    commitChanges.mock.resetCalls();
    commitChanges.mock.mockImplementation(async () => null);
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: [], errors: [] }));
    generateCompletionComment.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    const request = mock.fn(async () => ({ data: {} }));
    const claudeResult = {
        ...failedAgentResult(),
        terminationReason: 'timeout' as const,
        error: 'Agent execution timed out after 1800000ms',
    };

    const result = await performPostProcessing({
        octokit: { request },
        issueRef: { repoOwner: 'owner', repoName: 'repo', number: 43 },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: 'propr/43-fix' },
        currentIssueData: { data: { title: 'Partial timeout', labels: [{ name: 'AI' }] } },
        claudeResult,
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'main' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr',
        AI_PROCESSING_TAG: 'AI-processing',
        AI_DONE_TAG: 'AI-done',
        jobId: 'job-43',
        correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls.length, 1);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[1], ['AI-processing']);
    assert.deepEqual(safeUpdateLabels.mock.calls[0].arguments[2], []);
    assert.equal(result.commitResult, null);
    assert.equal(result.postProcessingResult?.success, false);
    assert.deepEqual(result.postProcessingResult?.updatedLabels, []);
    assert.equal(request.mock.calls.length, 1);
    assert.match(request.mock.calls[0].arguments[1].body as string, /failed before producing publishable work/i);
    assert.doesNotMatch(request.mock.calls[0].arguments[1].body as string, /AI-done/);
});

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

function stoppedExecutionOptions(overrides: Record<string, unknown>) {
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

test('a successful signed story publishes deterministic gate-ready metadata instead of model prose', async () => {
    const commitHash = 'f'.repeat(40);
    const storyId = 'EP-publication-policy-S01-T02';
    const execution = {
        baseSha: 'e'.repeat(40),
        featureBranch: 'task/signed-success',
        targetBranch: 'stage',
        allowedPaths: ['src/complete.ts'],
    };
    commitChanges.mock.resetCalls();
    commitChanges.mock.mockImplementation(async () => ({
        commitHash,
        commitMessage: `fix(ai): Implement ${storyId}\n\nTask: ${storyId}`,
        filesChanged: ['src/complete.ts'],
    }));
    pushBranch.mock.resetCalls();
    safeUpdateLabels.mock.resetCalls();
    safeUpdateLabels.mock.mockImplementation(async () => ({ success: true, removed: ['AI-processing'], added: ['AI-done'], errors: [] }));
    createPullRequest.mock.resetCalls();
    createPullRequest.mock.mockImplementation(async () => ({
        success: true,
        pr: { number: 73, url: 'https://github.com/owner/repo/pull/73', title: `fix(ai): Implement ${storyId}` },
        updatedLabels: [],
    }));
    const request = mock.fn(async (endpoint: string) => endpoint.includes('/pulls/{pull_number}')
        ? { data: {
            head: { sha: commitHash, ref: execution.featureBranch, repo: { full_name: 'owner/repo' } },
            base: { ref: execution.targetBranch, repo: { full_name: 'owner/repo' } },
            merged: false,
            state: 'open',
        } }
        : { data: {} });
    const modelCommitMessage = 'Implementation complete. All story checks that can run in this sandbox pass.';

    await performPostProcessing({
        execution,
        octokit: { request },
        issueRef: {
            repoOwner: 'owner', repoName: 'repo', number: 45,
            executionAdmissionReceipt: {
                admissionId: 'admission-success', operationId: 'operation-success',
                receiptKey: 'receipt-success', storyId,
            },
        },
        worktreeInfo: { worktreePath: '/tmp/worktree', branchName: execution.featureBranch },
        currentIssueData: { data: { title: 'Unchecked issue prose.', labels: [{ name: 'AI' }] } },
        claudeResult: {
            success: true, executionTime: 10, output: null, logs: '', modifiedFiles: ['src/complete.ts'],
            commitMessage: modelCommitMessage, summary: modelCommitMessage,
        },
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'stage' } },
        repoUrl: 'https://github.com/owner/repo.git',
        githubToken: { token: 'github-token' },
        PR_LABEL: 'propr', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done',
        jobId: 'job-45', correlatedLogger: logger,
    });

    assert.equal(commitChanges.mock.calls[0].arguments[1], `fix(ai): Implement ${storyId}\n\nTask: ${storyId}`);
    const publicationMetadata = createPullRequest.mock.calls[0].arguments[3].publicationMetadata;
    assert.equal(publicationMetadata.prTitle, `fix(ai): Implement ${storyId}`);
    assert.match(publicationMetadata.prBody, /## Summary/);
    assert.match(publicationMetadata.prBody, /## Impact & Risk/);
    assert.match(publicationMetadata.prBody, /## Checklist/);
    assert.doesNotMatch(publicationMetadata.prBody, /All story checks/);
});

async function taskLinkPolicyWorktree(includeSpecLink: boolean): Promise<string> {
    const worktreePath = await mkdtemp(join(tmpdir(), 'propr-publication-policy-'));
    await mkdir(join(worktreePath, 'checks'), { recursive: true });
    await mkdir(join(worktreePath, '.github'), { recursive: true });
    await writeFile(join(worktreePath, 'checks/spec-link.sh'), 'repository task-link gate\n');
    await writeFile(join(worktreePath, '.github/PULL_REQUEST_TEMPLATE.md'), 'Commits carry a Task: <story>-<task> trailer.\n');
    if (includeSpecLink) {
        await mkdir(join(worktreePath, 'specs/EP-publication-policy-S01'), { recursive: true });
        await writeFile(join(worktreePath, 'specs/EP-publication-policy-S01/link.md'), 'canonical story link\n');
    }
    return worktreePath;
}

async function expectSignedPolicyRefusal(storyId: string, worktreePath: string, expectedError: RegExp): Promise<void> {
    commitChanges.mock.resetCalls();
    pushBranch.mock.resetCalls();
    createPullRequest.mock.resetCalls();
    const execution = {
        baseSha: 'e'.repeat(40), featureBranch: 'task/policy-refusal',
        targetBranch: 'stage', allowedPaths: ['src/complete.ts'],
    };
    await assert.rejects(() => performPostProcessing({
        execution,
        octokit: { request: mock.fn(async () => ({ data: {} })) },
        issueRef: {
            repoOwner: 'owner', repoName: 'repo', number: 46,
            executionAdmissionReceipt: {
                admissionId: 'admission-policy', operationId: 'operation-policy',
                receiptKey: 'receipt-policy', storyId,
            },
        },
        worktreeInfo: { worktreePath, branchName: execution.featureBranch },
        currentIssueData: { data: { title: 'Policy-bound story', labels: [{ name: 'AI' }] } },
        claudeResult: { success: true, modifiedFiles: ['src/complete.ts'] },
        modelName: 'codex-test',
        repoValidation: { isValid: true, repoData: { defaultBranch: 'stage' } },
        repoUrl: 'https://github.com/owner/repo.git', githubToken: { token: 'github-token' },
        PR_LABEL: 'propr', AI_PROCESSING_TAG: 'AI-processing', AI_DONE_TAG: 'AI-done',
        jobId: 'job-46', correlatedLogger: logger,
    }), expectedError);
    assert.equal(commitChanges.mock.calls.length, 0);
    assert.equal(pushBranch.mock.calls.length, 0);
    assert.equal(createPullRequest.mock.calls.length, 0);
}

test('a repository task-link policy refuses story-only signed authority instead of inventing a task', async () => {
    await expectSignedPolicyRefusal(
        'EP-publication-policy-S01',
        await taskLinkPolicyWorktree(true),
        /STORY_PUBLICATION_TASK_ID_REQUIRED/,
    );
});

test('a repository task-link policy refuses a task whose story spec link is absent', async () => {
    await expectSignedPolicyRefusal(
        'EP-publication-policy-S01-T02',
        await taskLinkPolicyWorktree(false),
        /STORY_PUBLICATION_SPEC_LINK_REQUIRED/,
    );
});
import * as publicationPolicy from '../packages/core/src/publication/index.js';
import { requireAuthorizedPublicationMetadata } from '../packages/core/src/admission/authorizedPublicationMetadata.js';

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
const resolveAgentTerminationReason = mock.fn((result: { terminationReason?: 'timeout' | 'max_turns' }) => result.terminationReason);

await mock.module('timers/promises', {
    namedExports: { setTimeout: mock.fn(async () => undefined) },
});

await mock.module('@propr/core', {
    namedExports: { ...publicationPolicy,
        cleanupWorktree: mock.fn(async () => undefined),
        commitChanges,
        pushBranch,
        verifyStoryPublication: mock.fn(async () => []),
        AI_COMMIT_AUTHOR: { name: 'ProPR AI', email: 'ai@propr.dev' },
        TaskStates: { CANCELLED: 'cancelled' },
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

test('a timed-out signed story execution never commits or publishes partial work', async () => {
    commitChanges.mock.resetCalls();
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
            terminationReason: 'timeout',
            error: 'Agent execution timed out after the signed deadline',
        },
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

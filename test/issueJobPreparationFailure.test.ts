import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const noOp = () => undefined;
const log = { debug: noOp, info: noOp, warn: noOp, error: noOp };
const infrastructureFailure = new Error('ENOSPC: exact worktree preparation failed');
const consumed = mock.fn(async () => true);
const inspected = mock.fn(async () => true);
const context = { jobId: 'job', taskId: 'task', agentAlias: 'default', modelName: 'claude-test', correlationId: 'correlation',
  correlatedLogger: log, issueRef: { repoOwner: 'owner', repoName: 'repo', number: 1,
    executionAdmissionReceipt: { admissionId: 'admission', operationId: 'operation', receiptKey: 'receipt' },
    issuePayload: { title: 'story', labels: [] }, repoPayload: { defaultBranch: 'stage' } },
  stateManager: { getTaskCancellation: async () => undefined, createTaskState: noOp, updateTaskState: noOp } };
await mock.module('@propr/core', { namedExports: { logger: log, TaskStates: { PROCESSING: 'processing', FAILED: 'failed' },
  ensureRepoCloned: async () => '/unused', getRepoUrl: () => 'https://example.invalid/repo', safeAddLabel: noOp,
  safeRemoveLabel: noOp, ensureGitRepository: noOp, UsageLimitError: class extends Error {},
  validateRepositoryInfo: noOp, addModelSpecificDelay: noOp, withRetry: noOp, retryConfigs: {}, updatePlanIssueTaskId: noOp } });
await mock.module('../src/jobs/ezerExecutionAdmission.js', { namedExports: {
  verifyConfiguredEzerAdmission: consumed, inspectConfiguredEzerAdmission: inspected } });
await mock.module('../src/jobs/issueJobDispatcher.js', { namedExports: { handleDispatch: noOp } });
await mock.module('../src/jobs/issueJobHelpers.js', { namedExports: { handleUsageLimitError: noOp,
  handleGenericError: noOp, updateTaskTitleInStorage: noOp, buildFinalResult: noOp } });
await mock.module('../src/jobs/issueJobPostProcessing.js', { namedExports: { performFinalValidation: noOp } });
await mock.module('../src/jobs/issueJob/index.js', { namedExports: { initializeJobContext: async () => context,
  getAuthenticatedClient: async () => ({ auth: async () => ({ token: 'test-only-token' }) }),
  checkLabelConditions: () => ({ skip: false }), ensureProcessingLabel: noOp,
  executeWorktreeOperations: async () => { throw infrastructureFailure; }, markTaskComplete: noOp } });
const { processGitHubIssueJob } = await import('../src/jobs/processGitHubIssueJob.js');

test('infrastructure failure before agent startup leaves receipt unspent and suppresses automatic redelivery', async () => {
  const discard = mock.fn();
  await assert.rejects(processGitHubIssueJob({ id: 'job', data: { isChildJob: true }, discard, updateProgress: noOp } as never),
    error => error === infrastructureFailure);
  assert.equal(consumed.mock.callCount(), 0, 'preparation must not consume the worker execution receipt');
  assert.equal(inspected.mock.callCount(), 1, 'the exact receipt must still authorize preparation');
  assert.equal(discard.mock.callCount(), 1, 'protected execution must not silently consume queue retry attempts');
});

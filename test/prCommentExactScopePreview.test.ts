import * as cancellation from '../packages/core/src/admission/executionAdmissionCancellation.js';
import assert from 'node:assert/strict';
import { completionCoreExports, completionDatabase } from './helpers/completionCoreDoubles.js';
import { mock, test } from 'node:test';
import { buildVisualPreviewPrompt } from '../packages/core/src/services/visualPreviewService.js';

const noop = () => undefined;
const EMPTY_VISUAL_PREVIEW_EVIDENCE = { assets: [], toolSuggestions: [] };
const log = { debug: noop, info: noop, warn: noop, error: noop };
const head = 'a'.repeat(40);
const outputPath = 'docs/spikes/report.md';
const correction = { itemId: 'investigation', outputPath, priorRevision: head,
  deadline: new Date(Date.now() + 60_000).toISOString() };
let admitted = true;
let sourceStep = false;
let tombstone = false;
let cancelOnPush = false;
let lastExecution: unknown;
const terminalMetadata: unknown[] = [];
const continuation = mock.fn();
const autoMerge = mock.fn();
const reviewProcessing = mock.fn(async () => ({ status: "complete" }));
/** Terminal writes this suite observes, so "nothing was settled" is asserted, not assumed. */
const taskStateWrites: string[] = [];
/** Reproduces a database that refuses the completed history row. */
let refuseCompletedHistoryWrite = false;
const stateManager = {
  getTaskState: async () => lastExecution ? { state: 'claude_execution', claudeResult: lastExecution } : null, createTaskState: noop, updateHistoryMetadata: noop,
  updateTaskState: async (_taskId: string, state: string, metadata?: { claudeResult?: unknown }) => {
    if (metadata?.claudeResult) lastExecution = metadata.claudeResult;
    terminalMetadata.push(metadata);
    taskStateWrites.push(state);
    if (refuseCompletedHistoryWrite && state === 'completed') throw new Error('database refused the completed history row');
  },
};
const request = async (route: string) => ({ data: route.startsWith('GET')
  ? { head: { ref: 'feature', sha: head }, body: '', labels: [{ name: 'propr' }], user: { login: 'owner' }, title: 'Change' }
  : { id: 1, html_url: 'https://example.test/comment/1', body: 'completed' } });
const octokit = { request, auth: async () => ({ token: 'fixture' }) };
const previewSettings = { enabled: true, types: ['image'] };
const preparePreview = mock.fn(async () => ({ evidence: EMPTY_VISUAL_PREVIEW_EVIDENCE }));
const agent = mock.fn(async (_options: { prompt: string }) => { throw new Error('fixture-agent-boundary'); });
await mock.module('ioredis', { namedExports: { Redis: class { async get() { return tombstone ? "cancelled" : null; } } } });
await mock.module('node:child_process', { namedExports: { execFileSync: () => head } });
await mock.module('@propr/core', { namedExports: {
        ...completionCoreExports, ...cancellation,
  logger: { ...log, withCorrelation: () => log }, TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed', CANCELLED: 'cancelled', CLAUDE_EXECUTION: 'claude_execution' },
  // The completed-publication durability barrier categorises its own bookkeeping failure, and
  // the terminal agentOutcome it records redacts the agent's final output.
  ErrorCategories: { POST_PROCESSING: 'post_processing' }, redactSecrets: (value: string) => value,
  findRunningDockerContainerForTask: async () => undefined, inspectLegacyDockerContainerLivenessForTask: async () => 'not_found',
  getAuthenticatedOctokit: async () => octokit, getStateManager: () => stateManager,
  retryConfigs: {}, withRetry: async (call: () => unknown) => call(), hashTaskAttemptToken: (value: string) => value,
  runWithExecutionAbortSignal: async (_signal: unknown, call: () => unknown) => call(),
  ensureRepoCloned: async () => '/fixture', createWorktreeFromExistingBranch: async () => ({ worktreePath: '/fixture', branchName: 'feature' }),
  getRepoUrl: () => 'https://example.test/repo.git', ensureGitRepository: noop, createLogFiles: noop,
  UsageLimitError: class extends Error {}, recordLLMMetrics: noop, issueQueue: {}, loadPrimaryProcessingLabels: async () => ['propr'],
  loadRepositoryVisualPreviewSettings: async () => previewSettings, buildVisualPreviewPrompt,
  generateCorrelationId: noop, handleError: noop, cleanupWorktree: noop, formatResetTime: noop,
  getDefaultModel: () => 'fixture', resolveModelAlias: (value: string) => value, getPendingPrCommentsKey: noop,
  describeAgentTermination: noop, resolveAgentTerminationReason: () => undefined,
  commitChanges: async () => ({ commitHash: head, filesChanged: [outputPath] }), pushBranch: async () => { if (cancelOnPush) tombstone = true; return { rebased: false }; },
  AI_COMMIT_AUTHOR: { name: 'Fixture', email: 'fixture@example.test' },
  db: () => ({ where: () => ({ update: async () => undefined }) }),
  cleanupPreparedVisualPreviewEvidence: noop, prepareVisualPreviewEvidence: preparePreview,
  appendVisualPreviewSection: (body: string) => body, renderVisualPreviewSection: () => '',
  renderVisualPreviewUploadFailureSection: () => '', VISUAL_PREVIEW_SLOT: 'preview', EMPTY_VISUAL_PREVIEW_EVIDENCE,
} });
await mock.module('../src/jobs/ezerCommentAdmission.js', { namedExports: {
  verifyAdmittedPRComment: async (_data: unknown, _redis: unknown, receive: (value: unknown) => void) => {
    if (admitted && !sourceStep) receive(correction); return admitted;
  },
} });
await mock.module('../src/jobs/ezerAdmittedWorkerEnvironment.js', { namedExports: { buildAdmittedWorkerEnvironment: () => ({}) } });
await mock.module('../src/jobs/prCommentJobHelpers.js', { namedExports: {
  validateAndFilterComments: async (comments: unknown) => comments, filterUnprocessedComments: (comments: unknown) => comments,
  fetchLinkedIssueContext: async () => ({ context: 'Plan issue', linkedIssueNumber: 2, linkedIssueLabels: sourceStep ? [{ name: 'auto-merge' }] : [] }), buildCommentHistory: () => '',
  updateTaskTitleForPR: noop, resolvePrReasoningLevelOverride: noop,
} });
await mock.module('../src/jobs/issueJobHelpers.js', { namedExports: { localizeContentImages: async (value: string) => value } });
await mock.module('../src/jobs/prCommentAgentUtils.js', { namedExports: {
  generateSummaryTitle: async () => 'Change', resolveAndExecuteAgent: agent, resolvePRCommentModelName: async () => 'fixture',
} });
await mock.module('../src/jobs/prPendingComments.js', { namedExports: {
  pickUpPendingCommentsWithClaim: async (comments: unknown) => ({ commentsToProcess: comments, pickedUpComments: [] }), applyPendingCommentCommandContext: noop,
} });
await mock.module('../src/jobs/prCommentReviewJob.js', { namedExports: { executeReviewProcessing: reviewProcessing } });
await mock.module('../src/jobs/reviewCommentFormatter.js', { namedExports: { isReviewComment: () => false } });
await mock.module('../src/jobs/reviewFindingSelector.js', { namedExports: {
  hasAuthorizedFixFeedback: () => true, prepareFixReviewFeedback: async () => ({ isFixMode: false, selectedReviewComments: [] }),
} });
await mock.module('../src/jobs/ultrafixOrchestrationService.js', { namedExports: { retainOriginalScope: noop } });
await mock.module('../src/jobs/ultrafixJobHelpers.js', { namedExports: {
  handleUltrafixContinuation: continuation, markSelectedUltrafixFindings: noop, restorePendingCommentsIfUltrafixJobSuperseded: async () => false,
  resolveUltrafixHistoryMeta: async () => ({}),
} });
await mock.module('../src/jobs/ultrafixReviewExecutionGate.js', { namedExports: { shouldDeferUltrafixReview: async () => false } });
await mock.module('../src/jobs/prCommentNoAuthorizedFindings.js', { namedExports: { handleNoAuthorizedFindings: noop } });
await mock.module('../src/jobs/prProcessingLock.js', { namedExports: {
  acquirePRProcessingLock: async () => true, ensurePRProcessingLockToken: async () => 'attempt',
  releasePRProcessingLock: noop, startPRProcessingLockHeartbeat: () => noop,
} });
await mock.module('../src/jobs/prCommentMetrics.js', { namedExports: { buildMetricsSection: () => '' } });
await mock.module('../src/jobs/prCompletionComment.js', { namedExports: { buildCompletionComment: async () => 'completed' } });
await mock.module('../src/github/visualPreviewAttachments.js', { namedExports: {
  isVisualPreviewUploadAuthenticationError: () => false, publishPullRequestCommentVisualPreviews: noop,
} });
const utils = await import('../src/jobs/prCommentJobUtils.js');
await mock.module('../src/jobs/prCommentJobUtils.js', { namedExports: {
  ...utils, handleJobError: noop, cleanupJob: noop, fetchAllComments: async () => [],
} });
await mock.module('../src/jobs/reviewCommentGatherer.js', { namedExports: { markReviewFindingsProcessed: noop } });
const { processPullRequestCommentJob } = await import('../src/jobs/processPullRequestCommentJob.js');
const { handlePostExecution } = await import('../src/jobs/prCommentPostExecution.js');
const { isCompletionDurabilityUnverifiable } = await import('../src/jobs/completionDurabilityOutcome.js');

for (const exactScope of [true, false]) test(`actual PR-comment prompt preserves ${exactScope ? 'exact correction scope' : 'ordinary previews'}`, async () => {
  admitted = exactScope;
  await assert.rejects(processPullRequestCommentJob({ id: 'fixture', data: {
    repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 1, commentId: 1, commentBody: 'Correct report', commentAuthor: 'owner',
    executionAdmissionReceipt: exactScope ? {} : undefined, executionAdmissionComment: { headSha: head },
  }, updateData: noop } as never), /fixture-agent-boundary/);
  const prompt = agent.mock.calls.at(-1)!.arguments[0].prompt;
  if (exactScope) { assert.match(prompt, /Modify only docs\/spikes\/report.md/); assert.doesNotMatch(prompt, /\.propr\/previews\//); }
  else assert.match(prompt, /\.propr\/previews\//);
});

for (const exactScope of [true, false]) test(`actual PR-comment publication ${exactScope ? 'does not mutate validated scope' : 'retains preview preparation'}`, async () => {
  preparePreview.mock.resetCalls();
  await handlePostExecution({ state: {
    artifactCorrection: exactScope ? correction : undefined, octokit, worktreeInfo: { worktreePath: '/fixture', branchName: 'feature' },
    claudeResult: { success: true }, authorsText: '@owner', unprocessedComments: [], startingWorkComment: { data: { id: 1 } },
  }, job: { data: {} }, taskId: 'fixture', stateManager,
  context: { repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 1, correlatedLogger: log },
  unprocessedReviewComments: [], redisClient: {}, prProcessingLockKey: 'lock', prProcessingLockToken: 'attempt',
  ezerAdmissionVerified: exactScope,
  } as never, 'https://example.test/task');
  assert.equal(preparePreview.mock.callCount(), exactScope ? 0 : 1);
});

/**
 * End to end on the PR-comment path: the real post-execution publishes through the real barrier,
 * the completed write fails, the read-back cannot be performed — and the job's own outer failure
 * handler must decline to settle. Testing the barrier alone is what let this through last time:
 * the barrier refused to guess, and the caller wrote `failed` anyway.
 */
test('a PR-comment completion whose durability is unverifiable settles nothing terminal', async () => {
  refuseCompletedHistoryWrite = true;
  // ...and the read-back that would establish whether it committed cannot be performed either.
  completionDatabase.reset();
  completionDatabase.failReadBack = true;
  taskStateWrites.length = 0;
  const job = { id: 'fixture-job', data: {} };
  const error = await handlePostExecution({ state: {
    octokit, worktreeInfo: { worktreePath: '/fixture', branchName: 'feature' },
    claudeResult: { success: true }, authorsText: '@owner', unprocessedComments: [], startingWorkComment: { data: { id: 1 } },
  }, job, taskId: 'fixture', stateManager,
  context: { repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 1, correlatedLogger: log },
  unprocessedReviewComments: [], redisClient: {}, prProcessingLockKey: 'lock', prProcessingLockToken: 'attempt',
  } as never, 'https://example.test/task').then(() => undefined, (thrown: unknown) => thrown);

  assert.ok(isCompletionDurabilityUnverifiable(error), 'the barrier refuses to guess');
  // The processor's own generic failure handler, not a stub: it must re-throw rather than settle.
  await assert.rejects(() => utils.handleJobError(error as Error, job as never, {
    pullRequestNumber: 1, repoOwner: 'owner', repoName: 'repo', authorsText: '@owner', unprocessedComments: [],
    octokit, startingWorkComment: { data: { id: 1 } }, claudeResult: { success: true },
    correlationId: 'fixture', correlatedLogger: log, stateManager, taskId: 'fixture',
  } as never), /COMPLETION_DURABILITY_UNVERIFIABLE/);

  assert.deepEqual(taskStateWrites.filter(state => ['failed', 'cancelled'].includes(state)), [],
    'no failed or cancelled record may follow a completion that might have committed');
  assert.ok(taskStateWrites.filter(state => state === 'completed').length > 0,
    'the only terminal writes attempted are the completed ones the barrier retried, and none of them landed');
  refuseCompletedHistoryWrite = false;
});


test('Ezer Ultrafix step on an auto-merge plan PR executes without entering local continuation or auto-merge', async () => {
  admitted = true; sourceStep = true; completionDatabase.reset();
  continuation.mock.resetCalls(); autoMerge.mock.resetCalls();
  // If continuation is entered this fixture would enable auto-merge, as a linked plan allows it.
  continuation.mock.mockImplementation(() => autoMerge());
  agent.mock.mockImplementation(async () => ({ claudeResult: { success: true, modifiedFiles: ['src/file.ts'] }, agentType: 'claude' }) as never);
  const result = await processPullRequestCommentJob({ id: 'ultrafix-ezer-loop-1', data: {
    repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 1, commentId: 1, commentBody: 'Fix', commentAuthor: 'owner',
    executionAdmissionReceipt: { admissionId: 'step-1' }, executionAdmissionComment: { headSha: head },
    executionAdmissionStep: { loopId: 'loop', ordinal: 1 }, commandMode: 'default',
    commandInstructions: 'This is ultrafix step 1: make the failing required checks pass. Check: required unit tests',
  }, updateData: noop } as never);
  assert.match(agent.mock.calls.at(-1)!.arguments[0].prompt, /ultrafix step 1.*Check: required unit tests/);
  assert.equal(result.status, 'complete'); assert.equal(continuation.mock.callCount(), 0); assert.equal(autoMerge.mock.callCount(), 0);
  sourceStep = false;
});

test('owner-review branches to read-only review processing before the write-capable agent', async () => {
  admitted = true; sourceStep = true; agent.mock.resetCalls(); reviewProcessing.mock.resetCalls();
  await processPullRequestCommentJob({ id: 'review-source', data: {
    repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 1, commentId: 1, commentBody: 'Review', commentAuthor: 'owner',
    executionAdmissionReceipt: { admissionId: 'review-source' }, commandMode: 'owner-review',
  }, updateData: noop } as never);
  assert.equal(reviewProcessing.mock.callCount(), 1); assert.equal(agent.mock.callCount(), 0);
  sourceStep = false;
});

for (const afterPush of [false, true]) test(`comment processor settles cancellation ${afterPush ? 'after push' : 'before push'} in task history`, async () => {
  admitted = true; sourceStep = true; completionDatabase.reset(); tombstone = false; cancelOnPush = afterPush;
  lastExecution = undefined; terminalMetadata.length = 0;
  agent.mock.mockImplementation(async () => {
    if (!afterPush) tombstone = true;
    return { claudeResult: { success: true, modifiedFiles: ['src/file.ts'] }, agentType: 'claude' } as never;
  });
  const result = await processPullRequestCommentJob({ id: `cancel-comment-${afterPush}`, data: {
    repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 1, commentId: 1, commentBody: 'Fix', commentAuthor: 'owner',
    executionAdmissionReceipt: { admissionId: 'cancel-comment' }, executionAdmissionComment: { headSha: head }, commandMode: 'default',
  }, updateData: noop } as never);
  assert.equal(result.status, afterPush ? 'published-before-cancel' : 'cancelled');
  const final = terminalMetadata.at(-1) as { historyMetadata: { settlement: string; pushedHead?: string } };
  assert.equal(final.historyMetadata.settlement, result.status);
  if (afterPush) { assert.equal(result.pushedHead, head); assert.equal(final.historyMetadata.pushedHead, head); }
  sourceStep = false; tombstone = false; cancelOnPush = false; lastExecution = undefined;
});

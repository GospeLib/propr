import assert from 'node:assert/strict';
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
const stateManager = { createTaskState: noop, updateTaskState: noop, updateHistoryMetadata: noop };
const request = async (route: string) => ({ data: route.startsWith('GET')
  ? { head: { ref: 'feature', sha: head }, body: '', labels: [{ name: 'propr' }], user: { login: 'owner' }, title: 'Change' }
  : { id: 1, html_url: 'https://example.test/comment/1', body: 'completed' } });
const octokit = { request, auth: async () => ({ token: 'fixture' }) };
const previewSettings = { enabled: true, types: ['image'] };
const preparePreview = mock.fn(async () => ({ evidence: EMPTY_VISUAL_PREVIEW_EVIDENCE }));
const agent = mock.fn(async (_options: { prompt: string }) => { throw new Error('fixture-agent-boundary'); });
await mock.module('ioredis', { namedExports: { Redis: class {} } });
await mock.module('node:child_process', { namedExports: { execFileSync: () => head } });
await mock.module('@propr/core', { namedExports: {
  logger: { ...log, withCorrelation: () => log }, TaskStates: { PROCESSING: 'processing', COMPLETED: 'completed' },
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
  commitChanges: async () => ({ commitHash: head, filesChanged: [outputPath] }), pushBranch: async () => ({ rebased: false }),
  AI_COMMIT_AUTHOR: { name: 'Fixture', email: 'fixture@example.test' },
  db: () => ({ where: () => ({ update: async () => undefined }) }),
  cleanupPreparedVisualPreviewEvidence: noop, prepareVisualPreviewEvidence: preparePreview,
  appendVisualPreviewSection: (body: string) => body, renderVisualPreviewSection: () => '',
  renderVisualPreviewUploadFailureSection: () => '', VISUAL_PREVIEW_SLOT: 'preview', EMPTY_VISUAL_PREVIEW_EVIDENCE,
} });
await mock.module('../src/jobs/ezerCommentAdmission.js', { namedExports: {
  verifyAdmittedPRComment: async (_data: unknown, _redis: unknown, receive: (value: unknown) => void) => {
    if (admitted) receive(correction); return admitted;
  },
} });
await mock.module('../src/jobs/ezerAdmittedWorkerEnvironment.js', { namedExports: { buildAdmittedWorkerEnvironment: () => ({}) } });
await mock.module('../src/jobs/prCommentJobHelpers.js', { namedExports: {
  validateAndFilterComments: async (comments: unknown) => comments, filterUnprocessedComments: (comments: unknown) => comments,
  fetchLinkedIssueContext: async () => ({ context: '', linkedIssueLabels: [] }), buildCommentHistory: () => '',
  updateTaskTitleForPR: noop, resolvePrReasoningLevelOverride: noop,
} });
await mock.module('../src/jobs/issueJobHelpers.js', { namedExports: { localizeContentImages: async (value: string) => value } });
await mock.module('../src/jobs/prCommentAgentUtils.js', { namedExports: {
  generateSummaryTitle: async () => 'Change', resolveAndExecuteAgent: agent, resolvePRCommentModelName: async () => 'fixture',
} });
await mock.module('../src/jobs/prPendingComments.js', { namedExports: {
  pickUpPendingCommentsWithClaim: async (comments: unknown) => ({ commentsToProcess: comments, pickedUpComments: [] }), applyPendingCommentCommandContext: noop,
} });
await mock.module('../src/jobs/prCommentReviewJob.js', { namedExports: { executeReviewProcessing: noop } });
await mock.module('../src/jobs/reviewCommentFormatter.js', { namedExports: { isReviewComment: () => false } });
await mock.module('../src/jobs/reviewFindingSelector.js', { namedExports: {
  hasAuthorizedFixFeedback: () => true, prepareFixReviewFeedback: async () => ({ isFixMode: false, selectedReviewComments: [] }),
} });
await mock.module('../src/jobs/ultrafixOrchestrationService.js', { namedExports: { retainOriginalScope: noop } });
await mock.module('../src/jobs/ultrafixJobHelpers.js', { namedExports: {
  handleUltrafixContinuation: noop, markSelectedUltrafixFindings: noop, restorePendingCommentsIfUltrafixJobSuperseded: async () => false,
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

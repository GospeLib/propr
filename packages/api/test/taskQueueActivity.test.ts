import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

await mock.module('../routes/ezerCommentFollowup.js', {
  namedExports: { enqueueAdmittedComment: mock.fn() },
});

await mock.module('../ezerInternalAuth.js', {
  namedExports: { EZER_INTERNAL_SECRET_HEADER: 'x-ezer-secret', verifyEzerInternalRequest: mock.fn() },
});

await mock.module('@propr/core', {
  namedExports: {
    issueQueue: { add: mock.fn() },
    COMMENT_BATCH_DELAY_MS: 1,
    getAuthenticatedOctokit: mock.fn(),
    generateCorrelationId: mock.fn(() => 'correlation'),
    logger: { info: mock.fn(), error: mock.fn() },
  },
});

await mock.module('../routes/taskHelpers.js', {
  namedExports: {
    getTasksFromDb: mock.fn(async () => ({ tasks: [], total: 0 })),
    taskFollowupPullRequest: mock.fn(),
  },
});

await mock.module('../routes/revertHelpers.js', {
  namedExports: {
    validateRevertRequestBody: mock.fn(),
    formatCommit: mock.fn(),
    validateRevertPreviewParams: mock.fn(),
    checkRevertAuthorization: mock.fn(),
    checkRevertPreviewAuthorization: mock.fn(),
    lookupPr: mock.fn(),
    buildRevertJobData: mock.fn(),
    verifyCommitBelongsToPr: mock.fn(),
    resolveRepoAndCheckAccess: mock.fn(),
  },
});

const { createTaskRoutes } = await import('../routes/taskRoutes.js');

function responseRecorder() {
  const record: { status?: number; body?: unknown } = {};
  return {
    record,
    response: {
      status(code: number) { record.status = code; return this; },
      json(body: unknown) { record.body = body; return this; },
    },
  };
}

const scopedRequest = {
  query: { repository: 'GospeLib/main', issueNumber: '41' },
};

test('scoped queue activity reports target and global live-job counts from one observation', async () => {
  const jobs = [
    { data: { repoOwner: 'GospeLib', repoName: 'main', number: 41 } },
    { data: { repoOwner: 'GospeLib', repoName: 'main', number: 42 } },
    { data: { repoOwner: 'integry', repoName: 'propr', prNumber: 7 } },
  ];
  const taskQueue = { getJobs: mock.fn(async () => jobs) };
  const { record, response } = responseRecorder();
  const routes = createTaskRoutes({ db: {}, taskQueue } as never);

  await routes.getTasks(scopedRequest as never, response as never);

  const queueActivity = (record.body as { queueActivity: Record<string, unknown> }).queueActivity;
  assert.equal(queueActivity.liveJobs, 1);
  assert.equal(queueActivity.globalLiveJobs, jobs.length);
  assert.equal(queueActivity.repository, 'GospeLib/main');
  assert.equal(queueActivity.issueNumber, 41);
  assert.equal(typeof queueActivity.observedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(String(queueActivity.observedAt))), false);
  assert.equal(taskQueue.getJobs.mock.callCount(), 1, 'both counts must use the same queue snapshot');
});

test('scoped authoritative activity fails closed when the queue is unavailable', async () => {
  const { record, response } = responseRecorder();
  const routes = createTaskRoutes({ db: {} } as never);

  await routes.getTasks(scopedRequest as never, response as never);

  assert.equal(record.status, 500);
  assert.deepEqual(record.body, { error: 'Internal server error' });
});

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mock, test } from 'node:test';

const SIGNING_SECRET = 'intake-policy-test-secret-at-least-32-bytes';
const BASE_SHA = 'a'.repeat(40);
const POLICY_PATHS = ['checks/spec-link.sh', '.github/PULL_REQUEST_TEMPLATE.md'];
let atomicConsumeCalls = 0;
let queuedJobs = 0;
const repositoryReads: Array<{ path: string; ref: string }> = [];

const claims = {
  version: 1,
  admissionId: 'admission-policy-refusal',
  operationId: 'operation-policy-refusal',
  storyId: 'EP-publication-policy-S01',
  featureThread: 'EP-publication-policy',
  epicId: 'EP-publication-policy',
  repository: 'GospeLib/main',
  target: 'stage',
  scope: ['src/complete.ts'],
  authorityRevision: BASE_SHA,
  authorityDigest: `sha256:${'b'.repeat(64)}`,
  issueNumber: 77,
  issuedAt: new Date(Date.now() - 1_000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  storyExecution: {
    baseSha: BASE_SHA,
    featureBranch: 'task/publication-policy',
    targetBranch: 'stage',
    allowedPaths: ['src/complete.ts'],
  },
};
function signClaims(value: typeof claims): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encoded}.${createHmac('sha256', SIGNING_SECRET).update(encoded).digest('base64url')}`;
}
let pendingToken = signClaims(claims);
const issue = {
  id: 1,
  number: claims.issueNumber,
  repoOwner: 'GospeLib',
  repoName: 'main',
  labels: ['ezer-approved'],
  triggeredBy: 'owner',
};
const log = { info() {}, warn() {}, debug() {}, error() {} };

mock.module('../src/utils/logger.js', {
  defaultExport: { withCorrelation: () => log },
  namedExports: { generateCorrelationId: () => 'policy-correlation' },
});
mock.module('../src/utils/errorHandler.js', { namedExports: { handleError() {} } });
mock.module('../src/utils/retryHandler.js', {
  namedExports: { withRetry: async (fn: () => Promise<unknown>) => fn(), retryConfigs: { redis: {}, githubApi: {} } },
});
mock.module('../src/queue/taskQueue.js', {
  namedExports: {
    getIssueQueue: async () => ({
      getActive: async () => [],
      getWaiting: async () => [],
      add: async () => { queuedJobs++; },
    }),
  },
});
mock.module('../src/daemon/configLoader.js', {
  namedExports: {
    getPrimaryProcessingLabels: () => ['ezer-approved'],
    loadPrimaryProcessingLabelsFromConfig: async () => {},
  },
});
mock.module('../src/utils/userWhitelist.js', { namedExports: { getGithubUserWhitelist: () => [] } });
mock.module('../src/daemon/issueTriggerAuthorization.js', {
  namedExports: { isAuthorizedIssueTriggerActor: () => true },
});
mock.module('../src/auth/githubAuth.js', {
  namedExports: {
    getAuthenticatedOctokit: async () => ({
      request: async (route: string, input: { path?: string; ref?: string; commit_sha?: string }) => {
        if (route.includes('/git/commits/')) return { data: { sha: input.commit_sha } };
        assert.equal(input.ref, BASE_SHA, 'every policy file must be read from the exact signed base');
        assert.ok(input.path);
        repositoryReads.push({ path: input.path, ref: input.ref });
        if (input.path === POLICY_PATHS[0]) {
          return { data: { type: 'file', encoding: 'base64', content: Buffer.from('task-link gate').toString('base64') } };
        }
        if (input.path === POLICY_PATHS[1]) {
          return { data: { type: 'file', encoding: 'base64', content: Buffer.from('Task: <story>-<task>').toString('base64') } };
        }
        if (input.path?.startsWith('specs/')) {
          return { data: { type: 'file', encoding: 'base64', content: Buffer.from('canonical spec link').toString('base64') } };
        }
        throw Object.assign(new Error('not found'), { status: 404 });
      },
    }),
  },
});

const { processDetectedIssue } = await import('../src/daemon/issueDetection.js');

test('exact-base task-link refusal preserves admission and never queues story work', async () => {
  process.env.EZER_ADMISSION_HMAC_SECRET = SIGNING_SECRET;
  process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES = claims.repository;
  atomicConsumeCalls = 0;
  queuedJobs = 0;
  repositoryReads.length = 0;
  pendingToken = signClaims(claims);
  const redis = {
    set: async () => 'OK',
    get: async (key: string) => key.includes('pending') ? pendingToken : null,
    eval: async () => { atomicConsumeCalls++; return 1; },
    lpush: async () => 1,
    ltrim: async () => 'OK',
  };

  const result = await processDetectedIssue(issue as never, 'policy-correlation', redis as never);

  assert.deepEqual(result, { status: 'blocked', reason: 'ezer_admission_refused' });
  assert.deepEqual(repositoryReads, POLICY_PATHS.map(path => ({ path, ref: BASE_SHA })));
  assert.equal(atomicConsumeCalls, 0, 'policy refusal must not consume admission or issue receipt');
  assert.equal(queuedJobs, 0, 'policy refusal must not consume queue/model failure budget');
});

test('task-level authority with its exact-base spec link consumes once and queues once', async () => {
  const taskClaims = {
    ...claims,
    admissionId: 'admission-policy-success',
    storyId: 'EP-publication-policy-S01-T02',
  };
  atomicConsumeCalls = 0;
  queuedJobs = 0;
  repositoryReads.length = 0;
  pendingToken = signClaims(taskClaims);
  const redis = {
    set: async () => 'OK',
    get: async (key: string) => key.includes('pending') ? pendingToken : null,
    eval: async () => { atomicConsumeCalls++; return 1; },
    lpush: async () => 1,
    ltrim: async () => 'OK',
  };

  const result = await processDetectedIssue(issue as never, 'policy-correlation', redis as never);

  assert.equal(result.status, 'accepted');
  assert.deepEqual(repositoryReads, [
    ...POLICY_PATHS.map(path => ({ path, ref: BASE_SHA })),
    { path: 'specs/EP-publication-policy-S01/link.md', ref: BASE_SHA },
  ]);
  assert.equal(atomicConsumeCalls, 1);
  assert.equal(queuedJobs, 1);
});

test('real daemon intake refuses v2 without claim and retries the pending admission when Ezer returns', async t => {
  const env = { url: process.env.EZER_ADMISSION_CLAIM_URL, secret: process.env.EZER_INTERNAL_API_SECRET };
  t.after(() => {
    if (env.url === undefined) delete process.env.EZER_ADMISSION_CLAIM_URL; else process.env.EZER_ADMISSION_CLAIM_URL = env.url;
    if (env.secret === undefined) delete process.env.EZER_INTERNAL_API_SECRET; else process.env.EZER_INTERNAL_API_SECRET = env.secret;
  });
  process.env.EZER_ADMISSION_CLAIM_URL = 'http://ezer.test/internal/admission-claims';
  process.env.EZER_INTERNAL_API_SECRET = SIGNING_SECRET;
  const taskClaims = { ...claims, version: 2, generation: 1, storyId: 'EP-publication-policy-S01-T02' };
  pendingToken = signClaims(taskClaims);
  atomicConsumeCalls = 0; queuedJobs = 0;
  const redis = {
    set: async () => 'OK', get: async (key: string) => key.includes('pending') ? pendingToken : null,
    eval: async () => { atomicConsumeCalls++; return 1; }, lpush: async () => 1, ltrim: async () => 'OK',
  };
  let mode: 'unavailable' | 'refused' | 'stale' | 'success' = 'unavailable';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: { body: string }) => {
    if (mode === 'unavailable') throw Error('ECONNREFUSED');
    const request = JSON.parse(options.body);
    return new Response(JSON.stringify({ ...request, claimed: mode !== 'refused', claimId: 'claim',
      currentGeneration: mode === 'stale' ? 2 : 1, cancelled: false }), { status: 200 });
  });
  for (const failure of ['unavailable', 'refused', 'stale'] as const) {
    mode = failure;
    assert.deepEqual(await processDetectedIssue(issue as never, 'v2-correlation', redis as never),
      { status: 'blocked', reason: 'ezer_admission_refused' });
    assert.equal(atomicConsumeCalls, 0);
    assert.equal(queuedJobs, 0);
  }
  mode = 'success';
  assert.equal((await processDetectedIssue(issue as never, 'v2-correlation', redis as never)).status, 'accepted');
  assert.equal(atomicConsumeCalls, 1);
  assert.equal(queuedJobs, 1);
});

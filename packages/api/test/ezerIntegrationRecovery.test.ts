import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

const OPERATION = '00000000-0000-4000-8000-000000000001';
const HEX_DIGEST = 'a'.repeat(64);
const stored = new Map<string, string>();
let authenticated = true;
let unavailable = false;
let calls = 0;
let appearAfterObservation = false;
const disconnect = mock.fn();
interface Projection {
  error?: string;
  operationId?: string;
  executionDigest?: string;
  dispatchState?: { jobAbsent: boolean; admissionConsumed: boolean; workerReceiptPresent: boolean };
}
class TestRedis {
  async get(key: string) {
    if (unavailable) throw Error('test observation unavailable');
    return stored.get(key) ?? null;
  }
  disconnect = disconnect;
}
await mock.module('ioredis', { defaultExport: { Redis: TestRedis }, namedExports: { Redis: TestRedis } });
const { readExecutionAdmissionConsumption } = await import('../../core/src/admission/ezerExecutionAdmission.js');
await mock.module('@propr/core', {
  namedExports: {
    issueQueue: { getJob: async () => { calls++; return appearAfterObservation && calls > 1 ? { id: 'retained-job' } : undefined; } },
    requireIntegrationPayload: mock.fn(), consumeExecutionAdmission: mock.fn(),
    pendingExecutionAdmissionKey: mock.fn(), validateCurrentIntegration: mock.fn(),
    createRedisAdmissionStore: (redis: TestRedis) => redis,
    readExecutionAdmissionConsumption,
  },
});
await mock.module('../ezerInternalAuth.js', { namedExports: { verifyEzerInternalRequest: () => authenticated } });
const { getEzerIntegration } = await import('../routes/ezerIntegration.js');
afterEach(() => { stored.clear(); authenticated = true; unavailable = false; calls = 0; appearAfterObservation = false; disconnect.mock.resetCalls(); });
async function observe(operationId: unknown = OPERATION, legacy = false) {
  const result: { status?: number; body?: Projection } = {};
  const response = { status(code: number) { result.status = code; return this; }, json(body: Projection) { result.body = body; return this; } };
  await getEzerIntegration({ params: { digest: HEX_DIGEST }, query: legacy ? {} : { operationId } } as never, response as never);
  return result;
}
test('authentic metadata-only no-job projection binds exact operation/digest and both consumption keys', async () => {
  const result = await observe();
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, {
    error: 'INTEGRATION_TASK_NOT_FOUND', operationId: OPERATION, executionDigest: `sha256:${HEX_DIGEST}`,
    dispatchState: { jobAbsent: true, admissionConsumed: false, workerReceiptPresent: false },
  });
  assert.equal(calls, 2);
  assert.equal(disconnect.mock.callCount(), 1);
});
for (const [prefix, field] of [
  ['ezer:execution-admission:consumed:', 'admissionConsumed'],
  ['ezer:execution-admission:receipt:', 'workerReceiptPresent'],
] as const) test(`retains ${field} evidence without exposing stored credential bytes`, async () => {
  const credential = 'never-return-test-credential';
  stored.set(`${prefix}${OPERATION}`, credential);
  const result = await observe();
  assert.equal(result.body?.dispatchState?.[field], true);
  assert.equal(JSON.stringify(result.body).includes(credential), false);
});
test('unknown Redis state cannot claim absence', async () => {
  unavailable = true;
  const result = await observe();
  assert.equal(result.status, 503);
  assert.equal(result.body?.dispatchState, undefined);
});
test('a job appearing during observation cannot claim no execution', async () => {
  appearAfterObservation = true;
  const result = await observe();
  assert.equal(result.status, 409);
  assert.equal(result.body?.dispatchState, undefined);
});
test('unverified principal cannot read admission state', async () => {
  authenticated = false;
  const result = await observe();
  assert.equal(result.status, 403);
  assert.equal(calls, 0);
});
test('unbound legacy projection remains unchanged and malformed binding is refused', async () => {
  assert.deepEqual(await observe(undefined, true), { status: 404, body: { error: 'INTEGRATION_TASK_NOT_FOUND' } });
  assert.equal((await observe('unknown')).status, 400);
  assert.equal((await observe([OPERATION])).status, 400);
});

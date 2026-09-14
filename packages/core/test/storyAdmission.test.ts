import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { consumeExecutionAdmission, verifyWorkerAdmissionReceipt } from '../src/admission/ezerExecutionAdmission.js';
import { requireStoryExecutionContract } from '../src/admission/storyExecutionContract.js';

const SECRET = 'story-authority-test-secret-at-least-32-bytes';
const SHA = 'a'.repeat(40);
const EXECUTION = { baseSha: SHA, featureBranch: 'task/approved-story', targetBranch: 'stage', allowedPaths: ['docs/approved.md'] };
const EXPECTED = { repository: 'GospeLib/main', issueNumber: 9001, target: 'stage' };
function fixture(overrides: Record<string, unknown> = {}) {
  const values = new Map<string, string>();
  const claims = { version: 1, admissionId: 'admission', operationId: 'operation', storyId: 'EP-story-S01',
    featureThread: 'EP-story', epicId: 'EP-story', ...EXPECTED, scope: EXECUTION.allowedPaths,
    authorityRevision: SHA, authorityDigest: `sha256:${'b'.repeat(64)}`, storyExecution: EXECUTION,
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...overrides };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${encoded}.${createHmac('sha256', SECRET).update(encoded).digest('base64url')}`;
  const store = { get: async (key: string) => values.get(key) ?? null,
    take: async (key: string) => { const value = values.get(key) ?? null; values.delete(key); return value; },
    consumeAndIssue: async (key: string, receipt: string, value: string) => {
      if (values.has(key)) return false; values.set(key, value); values.set(receipt, value); return true;
    } };
  return { token, store };
}
test('ordinary worker receives only the exact signed stored contract, once', async () => {
  const f = fixture();
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  let binding: unknown;
  await verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED,
    requireStoryExecution: true, onStoryExecution: value => { binding = value; } });
  assert.deepEqual(binding, EXECUTION);
  await assert.rejects(verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED,
    requireStoryExecution: true }), /missing-worker-receipt/);
});
test('legacy ordinary receipt cannot start a protected story worker', async () => {
  const f = fixture({ storyExecution: undefined });
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  await assert.rejects(verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED,
    requireStoryExecution: true }), /story-execution-contract-required/);
});
for (const overrides of [{ scope: ['docs/unapproved.md'] }, { target: 'task/other' }])
  test(`refuses signed contract/claim disagreement ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(overrides);
    await assert.rejects(consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED }));
  });
for (const changed of [{ baseSha: 'stage' }, { featureBranch: 'stage' }, { allowedPaths: ['../outside'] },
  { allowedPaths: ['docs/**'] }, { allowedPaths: [] }, { targetBranch: 'master' }, { extra: true }])
  test(`refuses incomplete or widened story contract ${JSON.stringify(changed)}`, () => {
    assert.throws(() => requireStoryExecutionContract({ ...EXECUTION, ...changed }), /CONTRACT_INVALID/);
  });

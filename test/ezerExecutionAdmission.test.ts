import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeExecutionAdmission,
  requiresEzerExecutionAdmission,
  verifyWorkerAdmissionReceipt,
  type AdmissionStore,
  type ExecutionAdmissionClaims,
} from '../packages/core/src/admission/ezerExecutionAdmission.js';

const SIGNING_SECRET = 'test-only-ezer-admission-secret-with-32-bytes';
const NOW_MS = Date.parse('2026-09-06T20:00:00.000Z');

function claims(overrides: Partial<ExecutionAdmissionClaims> = {}): ExecutionAdmissionClaims {
  return {
    version: 1,
    admissionId: 'adm-2260-1',
    operationId: 'op-2260-1',
    storyId: 'EP-ezer-runtime-cutover-S01',
    featureThread: 'EP-ezer-runtime-cutover',
    epicId: 'EP-ezer-runtime-cutover',
    repository: 'GospeLib/main',
    target: 'stage',
    scope: ['services/ezer/src/operations/gateway.ts', 'services/ezer/src/batch/effects.ts', 'services/ezer/tests/serve-composition.test.ts'],
    authorityRevision: 'b3c07fe',
    authorityDigest: 'sha256:accepted-yadflow-ledger',
    issueNumber: 2260,
    issuedAt: new Date(NOW_MS - 1_000).toISOString(),
    expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    ...overrides,
  };
}

function sign(payload: ExecutionAdmissionClaims, secret = SIGNING_SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function store(): AdmissionStore {
  const values = new Map<string, string>();
  return {
    async consumeAndIssue(consumedKey, receiptKey, value) {
      if (values.has(consumedKey)) return false;
      values.set(consumedKey, value);
      values.set(receiptKey, value);
      return true;
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async take(key) {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
  };
}

describe('Ezer execution admission', () => {
  test('requires admission for a protected repository even when a direct job lies about its label', () => {
    assert.equal(requiresEzerExecutionAdmission({
      repository: 'GospeLib/main',
      triggeringLabel: 'AI',
      requiredLabel: 'propr-admitted',
      protectedRepositories: 'GospeLib/main,GospeLib/product-hub',
    }), true);
  });

  test('preserves unrelated repositories and processing labels', () => {
    assert.equal(requiresEzerExecutionAdmission({
      repository: 'integry/propr',
      triggeringLabel: 'AI',
      requiredLabel: 'propr-admitted',
      protectedRepositories: 'GospeLib/main,GospeLib/product-hub',
    }), false);
  });
  test('consumes a current signed admission and issues a worker-bound receipt', async () => {
    const sharedStore = store();
    const result = await consumeExecutionAdmission({
      token: sign(claims()),
      signingSecret: SIGNING_SECRET,
      expected: { repository: 'GospeLib/main', issueNumber: 2260 },
      store: sharedStore,
      nowMs: NOW_MS,
    });

    assert.equal(result.claims.operationId, 'op-2260-1');
    assert.equal(result.receipt.admissionId, 'adm-2260-1');
    await assert.doesNotReject(() => verifyWorkerAdmissionReceipt({
      receipt: result.receipt,
      expected: { repository: 'GospeLib/main', issueNumber: 2260, target: 'stage' },
      store: sharedStore,
    }));
    await assert.rejects(() => verifyWorkerAdmissionReceipt({
      receipt: result.receipt,
      expected: { repository: 'GospeLib/main', issueNumber: 2260, target: 'stage' },
      store: sharedStore,
    }), /missing-worker-receipt/);
  });

  test('refuses a replay of the same single-use admission', async () => {
    const sharedStore = store();
    const input = {
      token: sign(claims()), signingSecret: SIGNING_SECRET,
      expected: { repository: 'GospeLib/main', issueNumber: 2260 },
      store: sharedStore, nowMs: NOW_MS,
    };
    await consumeExecutionAdmission(input);
    await assert.rejects(() => consumeExecutionAdmission(input), /replayed-admission/);
  });

  for (const [name, mutation] of [
    ['bad-signature', () => sign(claims(), 'wrong-secret-with-at-least-thirty-two-bytes')],
    ['expired', () => sign(claims({ expiresAt: new Date(NOW_MS - 1).toISOString() }))],
    ['wrong-repository', () => sign(claims({ repository: 'attacker/repo' }))],
    ['wrong-issue', () => sign(claims({ issueNumber: 2259 }))],
    ['ambiguous-scope', () => sign(claims({ scope: [] }))],
  ] as const) {
    test(`refuses ${name}`, async () => {
      await assert.rejects(() => consumeExecutionAdmission({
        token: mutation(), signingSecret: SIGNING_SECRET,
        expected: { repository: 'GospeLib/main', issueNumber: 2260 },
        store: store(), nowMs: NOW_MS,
      }), new RegExp(name));
    });
  }

  test('refuses a fabricated worker receipt', async () => {
    await assert.rejects(() => verifyWorkerAdmissionReceipt({
      receipt: { admissionId: 'adm-2260-1', operationId: 'op-2260-1', receiptKey: 'fabricated' },
      expected: { repository: 'GospeLib/main', issueNumber: 2260, target: 'stage' },
      store: store(),
    }), /missing-worker-receipt/);
  });

  test('refuses a worker targeting a branch other than the signed target', async () => {
    const sharedStore = store();
    const result = await consumeExecutionAdmission({
      token: sign(claims()), signingSecret: SIGNING_SECRET,
      expected: { repository: 'GospeLib/main', issueNumber: 2260 },
      store: sharedStore, nowMs: NOW_MS,
    });
    await assert.rejects(() => verifyWorkerAdmissionReceipt({
      receipt: result.receipt,
      expected: { repository: 'GospeLib/main', issueNumber: 2260, target: 'master' },
      store: sharedStore,
    }), /wrong-target/);
  });
});

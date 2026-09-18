import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { consumeExecutionAdmission, verifyWorkerAdmissionReceipt } from '../src/admission/ezerExecutionAdmission.js';
import { requireStoryExecutionContract } from '../src/admission/storyExecutionContract.js';
import * as admission from '../src/admission/ezerExecutionAdmission.js';

const SECRET = 'story-authority-test-secret-at-least-32-bytes';
const SHA = 'a'.repeat(40);
const EXECUTION = { baseSha: SHA, featureBranch: 'task/approved-story', targetBranch: 'stage', allowedPaths: ['docs/approved.md'] };
const EXPECTED = { repository: 'GospeLib/main', issueNumber: 9001, target: 'stage' };
const DELEGATION = { grantId: 'exact-grant', delegatePrincipalId: 'bootstrap-agent',
  delegateSessionId: 'delegated-session', approvalPrincipalId: 'owner' };
test('preserves exact authorized conventional publication metadata across signed admission and worker receipt', async () => {
  const taskId = 'EP-story-S01-T01';
  const artifacts = ['tasks.md', 'link.md'].map(name => {
    const content = `# ${name}\n\n${taskId}\n`;
    return { path: `specs/EP-story-S01/${name}`, content, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
  });
  const text = { commitMessage: `docs(ezer): publish replacement fixture\n\nTask: ${taskId}\n`,
    prTitle: 'docs(ezer): publish replacement fixture',
    prBody: `## Summary\n\nPublish fixture.\n\n## Story / task\n\n- Story / task: \`${taskId}\`\n- Spec: \`specs/EP-story-S01/\`\n\n## Impact & Risk\n\n- **Domains / repos touched:** docs\n- **Contract surface touched:** no\n- **Risk level:** low\n- **Rollback plan:** close PR\n\n## Testing\n\nRun checks.\n\n## Checklist\n\n- [ ] Checks pass\n` };
  const digest = `sha256:${createHash('sha256').update(JSON.stringify({ taskId,
    artifacts: artifacts.map(({path, digest}) => ({path, digest})).sort((a,b) => a.path.localeCompare(b.path)), ...text })).digest('hex')}`;
  const storyExecution = { ...EXECUTION, taskAssignment: { taskId, artifacts }, publicationMetadata: { ...text, digest } };
  assert.deepEqual(requireStoryExecutionContract(storyExecution), storyExecution);
  const f = fixture({ storyExecution });
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  let binding: unknown;
  await verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED, onStoryExecution: value => { binding = value; } });
  assert.deepEqual(binding, storyExecution);
  for (const field of ['commitMessage', 'prTitle', 'prBody'] as const) {
    assert.throws(() => requireStoryExecutionContract({ ...storyExecution,
      publicationMetadata: { ...storyExecution.publicationMetadata, [field]: `${text[field]}tampered` } }), /PUBLICATION_METADATA/);
  }
  assert.throws(() => requireStoryExecutionContract({ ...storyExecution, taskAssignment: undefined }), /PUBLICATION_METADATA/);
});
test('canonical task metadata is preserved as exact signed execution authority', () => {
  const taskAssignment = { taskId: 'EP-story-S01-T01', artifacts: [
    { path: 'specs/EP-story-S01/tasks.md', content: '# Tasks\n\n## T01: Complete docs\n', digest: 'sha256:1' },
    { path: 'specs/EP-story-S01/link.md', content: '# Link\n', digest: 'sha256:2' },
  ] };
  assert.throws(() => requireStoryExecutionContract({ ...EXECUTION, taskAssignment }), /TASK_ASSIGNMENT_DIGEST/);
});
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
test('signed delegated identity survives admission and cannot be substituted on a worker receipt', async () => {
  const f = fixture({ delegatedAuthority: DELEGATION });
  const result = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  assert.deepEqual((result.claims as any).delegatedAuthority, DELEGATION);
  assert.deepEqual((result.receipt as any).delegatedAuthority, DELEGATION);
  assert.deepEqual(JSON.parse((await f.store.get(result.receipt.receiptKey))!).delegatedAuthority, DELEGATION);
  await assert.rejects(admission.inspectWorkerAdmissionReceipt({ receipt: { ...result.receipt,
    delegatedAuthority: { ...DELEGATION, delegatePrincipalId: 'owner' } } as any, store: f.store, expected: EXPECTED }), /delegation-receipt-changed/);
  assert.notEqual(await f.store.get(result.receipt.receiptKey), null);
  await admission.inspectWorkerAdmissionReceipt({ receipt: result.receipt, store: f.store, expected: EXPECTED });
});
test('preparation validates the signed contract without spending its single execution receipt', async () => {
  const f = fixture();
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  let binding: unknown;
  await admission.inspectWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED,
    requireStoryExecution: true, onStoryExecution: value => { binding = value; } });
  assert.deepEqual(binding, EXECUTION);
  assert.notEqual(await f.store.get(receipt.receiptKey), null, 'setup failure must leave execution authority unspent');
  await verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED, requireStoryExecution: true });
  await assert.rejects(admission.inspectWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED }), /missing-worker-receipt/);
});
test('a changed receipt fails inspection without consuming another execution authority', async () => {
  const f = fixture();
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  await assert.rejects(admission.inspectWorkerAdmissionReceipt({ receipt, store: f.store,
    expected: { ...EXPECTED, target: 'different-branch' } }), /wrong-target/);
  assert.notEqual(await f.store.get(receipt.receiptKey), null);
});
test('ordinary execution deadline is carried from signed admission expiry', async () => {
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const f = fixture({ expiresAt: deadline });
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  let observed: string | undefined;
  await admission.inspectWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED,
    onExecutionDeadline: value => { observed = value; } });
  assert.equal(observed, deadline);
});
test('expired preparation authority cannot reach execution and is never renewed', async () => {
  const issuedAtMs = Date.now() - 120_000;
  const f = fixture({ issuedAt: new Date(issuedAtMs).toISOString(), expiresAt: new Date(issuedAtMs + 60_000).toISOString() });
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED, nowMs: issuedAtMs });
  await assert.rejects(admission.inspectWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED }), /deadline-exceeded/);
  await assert.rejects(verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED }), /deadline-exceeded/);
});
test('concurrent execution claims following preparation allow exactly one execution', async () => {
  const f = fixture();
  const { receipt } = await consumeExecutionAdmission({ ...f, signingSecret: SECRET, expected: EXPECTED });
  await admission.inspectWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED });
  const attempts = await Promise.allSettled([
    verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED }),
    verifyWorkerAdmissionReceipt({ receipt, store: f.store, expected: EXPECTED }),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
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

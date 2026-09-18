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
    assert.equal(result.receipt.storyId, 'EP-ezer-runtime-cutover-S01');
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

  test('refuses a receipt whose signed story identity was changed before worker use', async () => {
    const sharedStore = store();
    const result = await consumeExecutionAdmission({
      token: sign(claims()),
      signingSecret: SIGNING_SECRET,
      expected: { repository: 'GospeLib/main', issueNumber: 2260 },
      store: sharedStore,
      nowMs: NOW_MS,
    });
    await assert.rejects(() => verifyWorkerAdmissionReceipt({
      receipt: { ...result.receipt, storyId: 'EP-changed-S01' },
      expected: { repository: 'GospeLib/main', issueNumber: 2260, target: 'stage' },
      store: sharedStore,
    }), /mismatched-worker-receipt/);
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

  test('runs an awaited policy against verified claims before atomic admission consumption', async () => {
    const sharedStore = store();
    let consumeCalls = 0;
    const originalConsume = sharedStore.consumeAndIssue;
    sharedStore.consumeAndIssue = async (...args) => {
      consumeCalls++;
      return originalConsume(...args);
    };
    const execution = {
      baseSha: 'a'.repeat(40),
      featureBranch: 'task/signed-story',
      targetBranch: 'stage',
      allowedPaths: ['src/complete.ts'],
    };
    let observedClaims: ExecutionAdmissionClaims | undefined;

    await assert.rejects(() => consumeExecutionAdmission({
      token: sign(claims({
        storyId: 'EP-publication-policy-S01-T02',
        target: execution.targetBranch,
        scope: execution.allowedPaths,
        storyExecution: execution,
      })),
      signingSecret: SIGNING_SECRET,
      expected: { repository: 'GospeLib/main', issueNumber: 2260 },
      store: sharedStore,
      nowMs: NOW_MS,
      preConsumePolicy: async verifiedClaims => {
        observedClaims = verifiedClaims;
        throw new Error('STORY_PUBLICATION_SPEC_LINK_REQUIRED');
      },
    }), /STORY_PUBLICATION_SPEC_LINK_REQUIRED/);

    assert.equal(observedClaims?.repository, 'GospeLib/main');
    assert.equal(observedClaims?.storyExecution?.baseSha, execution.baseSha);
    assert.equal(consumeCalls, 0, 'policy refusal must preserve the single-use admission');
  });

  test('does not expose unsigned claims to policy and revalidates expiry after asynchronous policy work', async t => {
    let policyCalls = 0;
    let consumeCalls = 0;
    const rejectingStore = store();
    rejectingStore.consumeAndIssue = async () => {
      consumeCalls++;
      return true;
    };
    await assert.rejects(() => consumeExecutionAdmission({
      token: sign(claims(), 'wrong-secret-with-at-least-thirty-two-bytes'),
      signingSecret: SIGNING_SECRET,
      expected: { repository: 'GospeLib/main', issueNumber: 2260 },
      store: rejectingStore,
      nowMs: NOW_MS,
      preConsumePolicy: async () => { policyCalls++; },
    }), /bad-signature/);
    assert.equal(policyCalls, 0);

    let currentTimeMs = NOW_MS;
    t.mock.method(Date, 'now', () => currentTimeMs);
    await assert.rejects(() => consumeExecutionAdmission({
      token: sign(claims()),
      signingSecret: SIGNING_SECRET,
      expected: { repository: 'GospeLib/main', issueNumber: 2260 },
      store: rejectingStore,
      preConsumePolicy: async () => {
        policyCalls++;
        currentTimeMs = NOW_MS + 60_001;
      },
    }), /expired/);
    assert.equal(policyCalls, 1);
    assert.equal(consumeCalls, 0, 'expired admission must not be consumed after asynchronous preflight');
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

test('comment admission refuses a different exact instruction before consuming its receipt', async () => {
  const sharedStore = store();
  const comment = { commentId: 123, bodyDigest: 'sha256:original', headSha: 'head-a', headBranch: 'feature-a' };
  await assert.rejects(() => consumeExecutionAdmission({
    token: sign({ ...claims(), comment } as ExecutionAdmissionClaims),
    signingSecret: SIGNING_SECRET,
    expected: { repository: 'GospeLib/main', issueNumber: 2260, comment: { ...comment, bodyDigest: 'sha256:changed' } },
    store: sharedStore,
    nowMs: NOW_MS,
  }), /wrong-comment/);
});

test('comment receipt retains exact PR head and is single use at the worker', async () => {
  const sharedStore = store();
  const comment = { commentId: 123, bodyDigest: 'sha256:original', headSha: 'head-a', headBranch: 'feature-a' };
  const result = await consumeExecutionAdmission({ token: sign(claims({ comment })), signingSecret: SIGNING_SECRET,
    expected: { repository: 'GospeLib/main', issueNumber: 2260, comment }, store: sharedStore, nowMs: NOW_MS });
  const expected = { repository: 'GospeLib/main', issueNumber: 2260, target: 'stage', comment };
  await verifyWorkerAdmissionReceipt({ receipt: result.receipt, expected, store: sharedStore });
  await assert.rejects(() => verifyWorkerAdmissionReceipt({ receipt: result.receipt, expected, store: sharedStore }), /missing-worker-receipt/);
});

describe('typed investigation admission', () => {
  const itemId='4b822e57-8eec-40d1-ad03-3a9553e58908';
  const outputPath=`docs/research/ezer-${itemId}.md`;
  function typedClaims(): ExecutionAdmissionClaims {
    const now=Date.now();
    return claims({storyId:`typed-work:${itemId}`,scope:[outputPath],issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),
      typedWork:{provider:'codex',model:'gpt-5.6-sol',kind:'research',itemId,deadline:new Date(now+120000).toISOString(),outputPath,outputKind:'research-report'}});
  }
  test('carries the verified type and deadline through the single-use worker receipt', async()=>{
    const admissionStore=store();const payload=typedClaims();
    const admitted=await consumeExecutionAdmission({token:sign(payload),signingSecret:SIGNING_SECRET,expected:{repository:payload.repository,issueNumber:payload.issueNumber},store:admissionStore});
    const verified=await verifyWorkerAdmissionReceipt({receipt:admitted.receipt,expected:{repository:payload.repository,issueNumber:payload.issueNumber,target:'stage'},store:admissionStore});
    assert.deepEqual(verified,payload.typedWork);
    await assert.rejects(()=>verifyWorkerAdmissionReceipt({receipt:admitted.receipt,expected:{repository:payload.repository,issueNumber:payload.issueNumber,target:'stage'},store:admissionStore}),/missing-worker-receipt/);
  });
  test('refuses typed work masquerading as an implementation story or broadening its scope', async()=>{
    for(const mutation of [{storyId:'approved-story'},{scope:['src/main.ts']},{comment:{commentId:1,bodyDigest:'digest',headSha:'head',headBranch:'branch'}}]){
      const payload={...typedClaims(),...mutation};
      await assert.rejects(()=>consumeExecutionAdmission({token:sign(payload),signingSecret:SIGNING_SECRET,expected:{repository:payload.repository,issueNumber:payload.issueNumber},store:store()}),/typed-authority-mismatch/);
    }
  });
  test('refuses wrong output kinds and admissions lasting beyond the recorded deadline',async()=>{
    const payload=typedClaims();payload.typedWork!.outputKind='implementation';
    await assert.rejects(()=>consumeExecutionAdmission({token:sign(payload),signingSecret:SIGNING_SECRET,expected:{repository:payload.repository,issueNumber:payload.issueNumber},store:store()}),/INVALID_TYPED_ADMISSION/);
    const expired=typedClaims();expired.typedWork!.deadline=expired.issuedAt;
    await assert.rejects(()=>consumeExecutionAdmission({token:sign(expired),signingSecret:SIGNING_SECRET,expected:{repository:expired.repository,issueNumber:expired.issueNumber},store:store()}),/typed-authority-mismatch/);
  });
});


test('typed artifact correction is a separate exact comment admission with one-use receipt', async()=>{
  const itemId='4b192513-5153-45af-9629-7aa4e486d65a';
  const deadline=new Date(Date.now()+60_000).toISOString();
  const correction={itemId,outputPath:`docs/spikes/ezer-${itemId}.md`,priorRevision:'a'.repeat(40),priorDigest:`sha256:${'b'.repeat(64)}`,deadline};
  const comment={commentId:2331,bodyDigest:'sha256:comment',headSha:correction.priorRevision,headBranch:'typed-artifact'};
  const value=claims({storyId:`typed-output:${itemId}`,scope:[correction.outputPath],comment,artifactCorrection:correction,issuedAt:new Date().toISOString(),expiresAt:deadline});
  const shared=store();const admitted=await consumeExecutionAdmission({token:sign(value),signingSecret:SIGNING_SECRET,expected:{repository:value.repository,issueNumber:value.issueNumber,comment},store:shared});
  let received:any;
  await verifyWorkerAdmissionReceipt({receipt:admitted.receipt,expected:{repository:value.repository,issueNumber:value.issueNumber,target:'stage',comment},store:shared,onArtifactCorrection:c=>{received=c;}});
  assert.deepEqual(received,correction);
  await assert.rejects(()=>verifyWorkerAdmissionReceipt({receipt:admitted.receipt,expected:{repository:value.repository,issueNumber:value.issueNumber,target:'stage',comment},store:shared}),/missing-worker-receipt/);
  for(const change of [{storyId:'approved-implementation'},{scope:['services/unsafe.ts']},{comment:{...comment,headSha:'c'.repeat(40)}},{artifactCorrection:{...correction,outputPath:'docs/spikes/other.md'}},
    {typedWork:{kind:'spike',itemId,outputKind:'registry-open-question',outputPath:correction.outputPath,deadline}}] as any[]){
    await assert.rejects(()=>consumeExecutionAdmission({token:sign({...value,...change}),signingSecret:SIGNING_SECRET,expected:{repository:value.repository,issueNumber:value.issueNumber,comment:change.comment??comment},store:store()}));
  }
});

const SELECTED_ROUTE={selectionId:'route-event',routeId:'local:gpt-5.6-sol',agentId:'agent-1',agentAlias:'local',provider:'codex',model:'gpt-5.6-sol',attemptOrdinal:2};
test('retains the exact signed route and rejects changed worker models and forged receipt hints',async()=>{
 for(const mode of ['exact','model','hint'] as const){
  const memory=store(),admitted=await consumeExecutionAdmission({token:sign(claims({route:SELECTED_ROUTE})),signingSecret:SIGNING_SECRET,expected:{repository:'GospeLib/main',issueNumber:2260},store:memory,nowMs:NOW_MS});
  assert.deepEqual(admitted.receipt.route,SELECTED_ROUTE);
  const check=()=>verifyWorkerAdmissionReceipt({receipt:mode==='hint'?{...admitted.receipt,route:{...SELECTED_ROUTE,selectionId:'forged'}}:admitted.receipt,expected:{repository:'GospeLib/main',issueNumber:2260,target:'stage'},expectedRoute:{...SELECTED_ROUTE,model:mode==='model'?'other':SELECTED_ROUTE.model},store:memory});
  if(mode==='exact')await check();else await assert.rejects(check,/selected-route/);
 }
});

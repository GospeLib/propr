/**
 * Cross-repository contract: ProPR accepts exactly the admission Ezer signs for a delegated
 * recovery of a story's second repository lane (`<story>-T02`), and refuses every widening of it.
 *
 * test/fixtures/ezer-lane-admission.json is committed byte-for-byte in Ezer
 * (services/ezer/tests/fixtures/propr-lane-admission.json), whose test produces that token from
 * Ezer's real StartUnit. Both tests pin the file's SHA-256.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeExecutionAdmission,
  verifyWorkerAdmissionReceipt,
  type AdmissionStore,
} from '../packages/core/src/admission/ezerExecutionAdmission.js';
import type { StoryExecutionContract } from '../packages/core/src/admission/storyExecutionContract.js';
import { requireIssueRecordedCheckpoint } from '../src/jobs/recordedExecutionCheckpoint.js';

const FIXTURE_BYTES = readFileSync(new URL('./fixtures/ezer-lane-admission.json', import.meta.url));
const FIXTURE_SHA256 = '3f39a508ec3bc37cd4d61e782c2091ae2595db2b99aa64764dbdf57b0a1a2aef';
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString('utf8')) as { hmacSecret: string; token: string };
const CLAIMS = JSON.parse(Buffer.from(FIXTURE.token.split('.')[0] ?? '', 'base64url').toString('utf8'));
const STORY = 'EP-binding-fixture-S02';
const LANE = `${STORY}-T02`;
const REPOSITORY = 'GospeLib/propr';
const ISSUE = 21;
const NOW_MS = Date.parse(CLAIMS.issuedAt);
const EXPECTED = { repository: REPOSITORY, issueNumber: ISSUE };

function store(): AdmissionStore {
  const values = new Map<string, string>();
  return {
    async consumeAndIssue(consumedKey, receiptKey, value) {
      if (values.has(consumedKey)) return false;
      values.set(consumedKey, value);
      values.set(receiptKey, value);
      return true;
    },
    async get(key) { return values.get(key) ?? null; },
    async take(key) { const value = values.get(key) ?? null; values.delete(key); return value; },
  };
}

function sign(claims: unknown): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${createHmac('sha256', FIXTURE.hmacSecret).update(encoded).digest('base64url')}`;
}

function consume(token: string, nowMs = NOW_MS, memory = store()) {
  return consumeExecutionAdmission({ token, signingSecret: FIXTURE.hmacSecret, expected: EXPECTED, store: memory, nowMs });
}

/** The fixture claims with one change, re-signed with the fixture secret. */
function mutated(change: (claims: any) => void): string {
  const claims = structuredClone(CLAIMS);
  change(claims);
  return sign(claims);
}

describe('Ezer lane admission contract', () => {
  test('pins the shared fixture bytes', () => {
    assert.equal(createHash('sha256').update(FIXTURE_BYTES).digest('hex'), FIXTURE_SHA256);
    assert.equal(CLAIMS.storyId, STORY);
    assert.equal(CLAIMS.unitId, LANE);
    assert.equal(CLAIMS.attemptOrdinal, CLAIMS.delegatedAuthority.scope.attemptOrdinal);
  });

  test('accepts Ezer’s exact signed lane recovery and carries the lane checkpoint to the worker', async () => {
    const memory = store();
    const admitted = await consume(FIXTURE.token, NOW_MS, memory);
    assert.equal(admitted.claims.unitId, LANE);
    assert.equal(admitted.receipt.storyId, STORY);
    assert.deepEqual(admitted.receipt.delegatedAuthority?.scope?.storyId, LANE);
    let execution: StoryExecutionContract | undefined;
    await verifyWorkerAdmissionReceipt({ receipt: admitted.receipt, expected: { ...EXPECTED, target: 'main' },
      store: memory, onStoryExecution: value => { execution = value; } });
    assert.equal(execution?.taskAssignment?.taskId, LANE);
    assert.deepEqual(execution?.recovery?.checkpoint, CLAIMS.storyExecution.recovery.checkpoint);
  });

  const refusals: Array<[string, (claims: any) => void, RegExp]> = [
    ['a grant widened to the story', claims => { claims.delegatedAuthority.scope.storyId = STORY; }, /delegation-scope-mismatch/],
    ['a lane acting as its story', claims => { delete claims.unitId; }, /delegation-scope-mismatch/],
    ['a grant for another issue', claims => { claims.delegatedAuthority.scope.issueNumber = ISSUE + 1; }, /delegation-scope-mismatch/],
    ['a grant for other paths', claims => { claims.delegatedAuthority.scope.allowedPaths = ['packages/api/server.ts']; }, /delegation-scope-mismatch/],
    ['another lane of the story', claims => { claims.unitId = `${STORY}-T03`; claims.delegatedAuthority.scope.storyId = `${STORY}-T03`; }, /unit-task-mismatch/],
    ['a unit outside the story', claims => { claims.unitId = 'EP-other-S01-T02'; }, /invalid-admission-unit/],
    ['a checkpoint of another task', claims => { claims.storyExecution.recovery.checkpoint.ref = `refs/propr/checkpoints/feat/${LANE}/task-other`; }, /checkpoint-source-task-mismatch/],
    ['an unbounded delegated start', claims => { delete claims.startBy; }, /delegation-start-unbounded/],
    ['a start after the grant', claims => { claims.startBy = claims.expiresAt; }, /delegation-start-unbounded/],
  ];
  for (const [name, change, reason] of refusals)
    test(`refuses ${name}`, async () => { await assert.rejects(() => consume(mutated(change)), reason); });

  // Every security-defining field of a delegated lane admission, deleted one at a time.
  const DELEGATION_FIELDS = ['grantIssuedAt', 'grantExpiresAt', 'scope'];
  const SCOPE_FIELDS = ['epicId', 'storyId', 'repository', 'issueNumber', 'attemptOrdinal', 'targetBranch', 'allowedPaths'];
  const deletions: Array<[string, (claims: any) => void]> = [
    ...DELEGATION_FIELDS.map((field): [string, (claims: any) => void] => [`delegatedAuthority.${field}`, claims => { delete claims.delegatedAuthority[field]; }]),
    ...SCOPE_FIELDS.map((field): [string, (claims: any) => void] => [`delegatedAuthority.scope.${field}`, claims => { delete claims.delegatedAuthority.scope[field]; }]),
    ['startBy', claims => { delete claims.startBy; }],
    ['the signed executing attempt', claims => { delete claims.attemptOrdinal; }],
    ['the story execution', claims => { delete claims.storyExecution; }],
  ];
  for (const [field, change] of deletions)
    test(`refuses a delegated lane admission without ${field}`, async () => {
      await assert.rejects(() => consume(mutated(change)), /ezer-execution-admission-refused|STORY_EXECUTION/);
    });

  test('refuses a legacy identity-only delegation', async () => {
    await assert.rejects(() => consume(mutated(claims => {
      const { grantId, delegatePrincipalId, delegateSessionId, approvalPrincipalId } = claims.delegatedAuthority;
      claims.delegatedAuthority = { grantId, delegatePrincipalId, delegateSessionId, approvalPrincipalId };
    })), /invalid-delegation-grant-window/);
  });

  const OTHER_ATTEMPT = 999;
  const attemptMismatches: Array<[string, (claims: any) => void, RegExp]> = [
    ['a grant for another attempt', claims => { claims.delegatedAuthority.scope.attemptOrdinal = OTHER_ATTEMPT; }, /delegation-attempt-mismatch/],
    ['an executing attempt the grant does not name', claims => { claims.attemptOrdinal = OTHER_ATTEMPT; }, /delegation-attempt-mismatch/],
    ['a selected route for another attempt', claims => { claims.route = { selectionId: 's', routeId: 'claude:opus', agentId: 'a',
      agentAlias: 'claude', provider: 'anthropic', model: 'opus', attemptOrdinal: OTHER_ATTEMPT }; }, /route-attempt-mismatch/],
  ];
  for (const [name, change, reason] of attemptMismatches)
    test(`refuses ${name}`, async () => { await assert.rejects(() => consume(mutated(change)), reason); });

  test('accepts a selected route for the executing attempt', async () => {
    await assert.doesNotReject(() => consume(mutated(claims => { claims.route = { selectionId: 's', routeId: 'claude:opus', agentId: 'a',
      agentAlias: 'claude', provider: 'anthropic', model: 'opus', attemptOrdinal: claims.attemptOrdinal }; })));
  });

  test('refuses consumption once the grant has expired', async () => {
    const afterGrant = Date.parse(CLAIMS.delegatedAuthority.grantExpiresAt) + 1;
    await assert.rejects(() => consume(mutated(claims => { claims.startBy = claims.expiresAt; claims.delegatedAuthority.grantExpiresAt = new Date(afterGrant - 1).toISOString(); }), afterGrant), /expired/);
  });

  test('a stop control binds the lane unit, never its story', async () => {
    const stop = (unitId: string) => mutated(claims => {
      delete claims.storyExecution; delete claims.delegatedAuthority; delete claims.startBy;
      claims.control = { kind: 'stop', taskId: 'task', executionAdmissionId: 'a', executionOperationId: 'o', containerId: 'c',
        unitId, ownerAccountId: '7', commentId: 9, bodyDigest: 'sha256:d' };
    });
    await assert.doesNotReject(() => consumeExecutionAdmission({ token: stop(LANE), signingSecret: FIXTURE.hmacSecret, store: store(), nowMs: NOW_MS,
      expected: { ...EXPECTED, control: JSON.parse(Buffer.from(stop(LANE).split('.')[0] ?? '', 'base64url').toString()).control } }));
    await assert.rejects(() => consumeExecutionAdmission({ token: stop(STORY), signingSecret: FIXTURE.hmacSecret, store: store(), nowMs: NOW_MS,
      expected: { ...EXPECTED, control: JSON.parse(Buffer.from(stop(STORY).split('.')[0] ?? '', 'base64url').toString()).control } }), /stop-authority-mismatch/);
  });
});

describe('recorded checkpoint of the executing issue', () => {
  const execution = CLAIMS.storyExecution as StoryExecutionContract;
  const checkpoint = execution.recovery?.checkpoint;
  const recorded = (issue = { repoOwner: 'GospeLib', repoName: 'propr', number: ISSUE }, overrides: Record<string, unknown> = {}) => ({
    getTaskState: async (taskId: string) => taskId !== execution.recovery?.sourceTaskId ? null : {
      issueRef: issue,
      history: [{ state: 'failed', metadata: { executionCheckpoint: { status: 'preserved', publication: 'none',
        baseSha: execution.baseSha, featureBranch: `feat/${LANE}`, ...checkpoint, changedPaths: [], outOfScopePaths: [], ...overrides } } }],
    } as never,
  });
  const issueRef = { repoOwner: 'GospeLib', repoName: 'propr', number: ISSUE };

  test('resumes only the checkpoint ProPR recorded for this issue’s source task', async () => {
    await assert.doesNotReject(() => requireIssueRecordedCheckpoint(recorded(), issueRef, execution));
    for (const state of [recorded({ ...issueRef, number: 20 }), recorded({ ...issueRef, repoName: 'main' }),
      recorded(undefined, { sha: '8'.repeat(40) }), recorded(undefined, { status: 'failed' }), recorded(undefined, { baseSha: '1'.repeat(40) })])
      await assert.rejects(() => requireIssueRecordedCheckpoint(state, issueRef, execution), /STORY_EXECUTION_CHECKPOINT_NOT_RECORDED_FOR_ISSUE/);
  });
});

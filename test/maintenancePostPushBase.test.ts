import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let pr: Record<string, unknown> = {};
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({
    request: async () => ({ data: structuredClone(pr) }),
}) } });
const { readLiveMaintenance } = await import('../packages/core/src/admission/admittedMaintenance.js');

const admittedBase = 'a'.repeat(40);
const admittedHead = 'b'.repeat(40);
const pushed = 'c'.repeat(40);
const binding = { kind: 'bring-up-to-date', issuer: 'ezer', requestId: 'r', deliveryEventId: 'd', priorTaskId: 't',
    headSha: admittedHead, headBranch: 'feature', baseSha: admittedBase } as never;
const livePr = (headSha: string, baseSha: string) => ({
    number: 7, state: 'open', draft: false, mergeable: false, mergeable_state: 'dirty',
    head: { sha: headSha, ref: 'feature', repo: { full_name: 'o/r' } },
    base: { sha: baseSha, ref: 'stage', repo: { full_name: 'o/r' } },
});

test('after its own push, the PR base GitHub re-pointed at the merged base is accepted', async () => {
    pr = livePr(pushed, 'd'.repeat(40));
    await readLiveMaintenance('o/r', 7, 'stage', binding, pushed);
});

test('before publication a moved base is still refused, and so is a foreign head after publication', async () => {
    pr = livePr(admittedHead, 'd'.repeat(40));
    await assert.rejects(readLiveMaintenance('o/r', 7, 'stage', binding), /maintenance-pr-changed/);
    pr = livePr('e'.repeat(40), 'd'.repeat(40));
    await assert.rejects(readLiveMaintenance('o/r', 7, 'stage', binding, pushed), /maintenance-pr-changed/);
});

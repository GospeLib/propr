import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import * as admission from '../packages/core/src/admission/ezerExecutionAdmission.js';
import * as cancellation from '../packages/core/src/admission/executionAdmissionCancellation.js';
import * as bindings from '../packages/core/src/admission/admissionBindings.js';

const connection = { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '6379') };
const redis = new Redis(connection);
const queue = new Queue('maintenance-tests', { connection });
const secret = 'maintenance-secret-at-least-32-bytes';
process.env.EZER_ADMISSION_HMAC_SECRET = secret;
let pr: any, prior: any, history: any[], checks = 0;
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => ({
    request: async (route: string) => ({ data: route.endsWith('/pulls/{pull_number}') ? structuredClone(pr) : { total_count: checks } }),
}) } });
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: { issueQueue: queue } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: (table: string) => ({ where: () => ({
    first: async () => prior, orderBy: async () => table === 'task_history' ? history : [],
}) }) } });
const maintenance = await import('../packages/core/src/admission/admittedMaintenance.js');
await mock.module('@propr/core', { namedExports: { ...admission, ...cancellation, ...bindings, ...maintenance } });
const { verifyAdmittedSourceJob, requireSourcePublication } = await import('../src/jobs/ezerSourceAdmission.js');
const request = { repository: 'owner/repo', prNumber: 7, priorTaskId: 'prior', admissionId: 'maint-1', requestId: 'request' };
const binding = { issuer: 'ezer', kind: 'bring-up-to-date', priorTaskId: 'prior', requestId: 'request',
    deliveryEventId: 'delivery-event', headSha: 'a'.repeat(40), headBranch: 'feature', baseSha: 'b'.repeat(40) };
beforeEach(async () => {
    await redis.flushdb(); checks = 0;
    pr = { number: 7, state: 'open', mergeable: false, mergeable_state: 'dirty',
        head: { sha: binding.headSha, ref: 'feature', repo: { full_name: 'owner/repo' } },
        base: { sha: binding.baseSha, ref: 'stage', repo: { full_name: 'owner/repo' } } };
    prior = { repository: 'owner/repo', pr_number: 7, commit_hash: binding.headSha,
        initial_job_data: JSON.stringify({ executionAdmissionReceipt: { admissionId: 'delivery', operationId: 'delivery-op', storyId: 'story' } }) };
    history = [{ state: 'completed', metadata: JSON.stringify({ admissionId: 'delivery', operationId: 'delivery-op' }) }];
});
after(async () => { await queue.close(); redis.disconnect(); });
async function pending(overrides: Record<string, unknown> = {}) {
    const claims = { version: 1, admissionId: 'maint-1', operationId: 'maintenance:event', storyId: 'story', epicId: 'epic',
        featureThread: 'feature', repository: 'owner/repo', issueNumber: 7, target: 'stage', scope: ['src/'],
        authorityRevision: 'r', authorityDigest: 'd', issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(), maintenance: binding, ...overrides };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    await redis.set(admission.pendingExecutionAdmissionKey('owner/repo', 7), token);
    return claims;
}
test('signed maintenance enqueues one existing merge job and concurrent replay returns the same job', async () => {
    await pending();
    const results = await Promise.all([maintenance.enqueueAdmittedMaintenance(request), maintenance.enqueueAdmittedMaintenance(request)]);
    assert.deepEqual(results, [{ jobId: 'merge-ezer-maint-1' }, { jobId: 'merge-ezer-maint-1' }]);
    const jobs = await queue.getJobs(['waiting']); assert.equal(jobs.length, 1);
    const job = jobs[0]; assert.equal(job.name, 'processMergeConflict'); assert.equal(job.opts.attempts, 1);
    assert.deepEqual(job.data.executionAdmissionReceipt.maintenance, binding);
    await verifyAdmittedSourceJob(job.data, redis);
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /missing-worker-receipt/);
    await requireSourcePublication(job.data, redis);
    pr.head.sha = 'c'.repeat(40); pr.mergeable = true; pr.mergeable_state = 'clean';
    await requireSourcePublication(job.data, redis, pr.head.sha);
    assert.deepEqual(await maintenance.enqueueAdmittedMaintenance(request), results[0]);
});
for (const field of ['source', 'comment', 'step', 'control', 'storyExecution', 'typedWork', 'artifactCorrection', 'route', 'delegatedAuthority']) {
    test(`rejects maintenance mixed with ${field}`, async () => {
        await pending({ [field]: {} });
        await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /maintenance-authority-mismatch/);
        assert.equal(await queue.count(), 0);
    });
}
for (const change of [{ unexpected: true }, { issuer: 'owner' }, { kind: 'fix' }, { headSha: 'short' }, { baseSha: 'short' },
    { requestId: '' }, { deliveryEventId: '' }, { priorTaskId: '' }, { headBranch: '' }]) {
    test(`rejects malformed binding ${JSON.stringify(change)}`, async () => {
        await pending({ maintenance: { ...binding, ...change } });
        await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /invalid-maintenance/);
        assert.equal(await queue.count(), 0);
    });
}
for (const change of [{ priorTaskId: 'other' }, { requestId: 'other' }, { admissionId: 'other' }]) {
    test(`rejects route binding ${JSON.stringify(change)}`, async () => {
        await pending(); await assert.rejects(() => maintenance.enqueueAdmittedMaintenance({ ...request, ...change }), /maintenance-request-mismatch/);
    });
}
for (const change of [{ repository: 'other/repo' }, { issueNumber: 8 }, { target: 'main' }, { scope: [] },
    { expiresAt: new Date(0).toISOString() }, { version: 3 }]) {
    test(`rejects common claim ${JSON.stringify(change)}`, async () => {
        await pending(change); await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request));
        assert.equal(await queue.count(), 0);
    });
}
test('rejects forged HMAC', async () => {
    await pending(); const key = admission.pendingExecutionAdmissionKey('owner/repo', 7);
    await redis.set(key, (await redis.get(key))!.split('.')[0] + '.forged');
    await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /bad-signature/);
});
for (const mutate of [() => { pr.head.sha = 'c'.repeat(40); }, () => { pr.head.ref = 'other'; },
    () => { pr.base.sha = 'c'.repeat(40); }, () => { pr.base.ref = 'main'; }, () => { pr.state = 'closed'; },
    () => { pr.head.repo.full_name = 'fork/repo'; }, () => { pr.base.repo.full_name = 'other/repo'; },
    () => { pr.mergeable = true; pr.mergeable_state = 'clean'; }]) {
    test(`PR fence at enqueue, start and push: ${mutate}`, async () => {
        await pending(); const saved = structuredClone(pr); mutate();
        await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request));
        pr = saved; await maintenance.enqueueAdmittedMaintenance(request);
        const job = (await queue.getJob('merge-ezer-maint-1'))!; mutate();
        await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis));
        await assert.rejects(() => requireSourcePublication(job.data, redis));
    });
}
test('behind requires absence of checks and workflows', async () => {
    await pending(); pr.mergeable = true; pr.mergeable_state = 'behind'; checks = 1;
    await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /maintenance-checks-running/);
    checks = 0; assert.deepEqual(await maintenance.enqueueAdmittedMaintenance(request), { jobId: 'merge-ezer-maint-1' });
});
for (const mutate of [() => { prior.repository = 'other/repo'; }, () => { prior.pr_number = 8; },
    () => { prior.commit_hash = 'c'.repeat(40); }, () => { prior.initial_job_data = '{}'; },
    () => { history = [{ state: 'cancelled' }]; }, () => { history[0].metadata = '{}'; }]) {
    test(`requires Ezer delivery: ${mutate}`, async () => {
        await pending(); mutate(); await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /maintenance-prior/);
    });
}
test('cancellation fences enqueue, worker start, publication and replay', async () => {
    await pending(); const key = cancellation.cancelledExecutionAdmissionKey('maint-1');
    await redis.set(key, 'cancelled'); await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /cancelled/);
    await redis.del(key); await maintenance.enqueueAdmittedMaintenance(request);
    const job = (await queue.getJob('merge-ezer-maint-1'))!;
    await redis.set(key, 'cancelled');
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /cancelled/);
    await assert.rejects(() => requireSourcePublication(job.data, redis, 'c'.repeat(40)), error => error instanceof cancellation.AdmissionCancelledError && error.pushedHead === 'c'.repeat(40));
    await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /cancelled/);
});
test('competing owner jobs and pause fence maintenance', async () => {
    await pending(); await queue.add('processPullRequestComment', { repoOwner: 'owner', repoName: 'repo', pullRequestNumber: 7 });
    await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /competing-job/);
    await queue.drain(); await queue.pause();
    await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /queue-paused/);
    await queue.resume(); await maintenance.enqueueAdmittedMaintenance(request);
    const job = (await queue.getJob('merge-ezer-maint-1'))!;
    await redis.set('lock:pr:owner:repo:7', 'owner-job');
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /competing-job/);
    await redis.del('lock:pr:owner:repo:7'); await redis.set('worker:abort:merge-ezer-maint-1', 'owner-stop');
    await assert.rejects(() => requireSourcePublication(job.data, redis), /owner-abort/);
});
test('worker refuses altered queue scope, deadline or binding', async () => {
    await pending(); await maintenance.enqueueAdmittedMaintenance(request);
    const job = (await queue.getJob('merge-ezer-maint-1'))!;
    for (const patch of [{ scope: ['*'] }, { executionDeadline: new Date(Date.now() + 900000).toISOString() }, { maintenance: { ...binding, baseSha: 'c'.repeat(40) } }]) {
        const data = structuredClone(job.data); Object.assign(data.executionAdmissionReceipt, patch);
        await assert.rejects(() => verifyAdmittedSourceJob(data, redis));
    }
});

test('expired consumed maintenance cannot execute, publish or replay', async () => {
    await pending(); await maintenance.enqueueAdmittedMaintenance(request);
    const job = (await queue.getJob('merge-ezer-maint-1'))!;
    const key = 'ezer:execution-admission:consumed:maint-1';
    const stored = JSON.parse((await redis.get(key))!); stored.executionDeadline = new Date(0).toISOString();
    await redis.set(key, JSON.stringify(stored));
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /maintenance-worker-binding-changed/);
    await assert.rejects(() => requireSourcePublication(job.data, redis), /maintenance-worker-binding-changed/);
    await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /maintenance-replay-mismatch/);
});
test('replayed route and request must remain exact', async () => {
    await pending(); await maintenance.enqueueAdmittedMaintenance(request);
    for (const patch of [{ priorTaskId: 'other' }, { requestId: 'other' }, { prNumber: 8 }, { repository: 'other/repo' }])
        await assert.rejects(() => maintenance.enqueueAdmittedMaintenance({ ...request, ...patch }), /maintenance-replay-mismatch/);
    assert.equal(await queue.count(), 1);
});

test('enqueue failure recovers the original unspent receipt without consuming twice', async () => {
    await pending();
    const failing = mock.method(queue, 'add', async () => { throw new Error('queue unavailable'); });
    await assert.rejects(() => maintenance.enqueueAdmittedMaintenance(request), /queue unavailable/);
    const receiptKey = 'ezer:execution-admission:receipt:maint-1';
    const receipt = await redis.get(receiptKey); assert.ok(receipt);
    failing.mock.restore();
    assert.deepEqual(await maintenance.enqueueAdmittedMaintenance(request), { jobId: 'merge-ezer-maint-1' });
    assert.equal(await redis.get(receiptKey), receipt); assert.equal(await queue.count(), 1);
});

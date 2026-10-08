import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import * as admission from '../packages/core/src/admission/ezerExecutionAdmission.js';
import * as cancellation from '../packages/core/src/admission/executionAdmissionCancellation.js';
import type { SourceAdmissionBinding } from '../packages/core/src/admission/admissionBindings.js';

const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '16439') });
const queue = new Queue('typed-source-tests', { connection: { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '16439') } });
const secret = 'typed-source-test-secret-32-bytes-minimum';
process.env.EZER_ADMISSION_HMAC_SECRET = secret;
process.env.EZER_ADMISSION_CLAIM_SECRET = secret;
process.env.EZER_OWNER_GITHUB_USER_ID = '42';
let pr: any, message: any;
let requests: string[] = [];
let claimActions: string[] = [];
const fence = mock.fn(async () => ({ workEpoch: 1, hadAutomaticWork: false }));
const octokit = { request: async (route: string, params: { ref?: string }) => {
    requests.push(route);
    if (route.endsWith('/check-runs')) {
        assert.equal(params.ref, 'a'.repeat(40));
        return { data: { total_count: 2, check_runs: [
            { name: 'required unit tests', status: 'completed', conclusion: 'failure', output: { title: 'Unit test failure', summary: 'Expected 2, received 1' } },
            { name: 'passing lint', status: 'completed', conclusion: 'success', output: {} },
        ] } };
    }
    if (route.endsWith('/status')) {
        assert.equal(params.ref, 'a'.repeat(40));
        return { data: { state: 'failure', total_count: 2, statuses: [
            { context: 'external build', state: 'error', description: 'Build failed to compile' },
            { context: 'passing status', state: 'success' },
        ] } };
    }
    if (route.endsWith('/pulls/{pull_number}')) return { data: structuredClone(pr) };
    if (!message) throw new Error('404 deleted');
    return { data: structuredClone(message) };
} };
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => octokit } });
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: { issueQueue: queue, getIssueQueue: () => queue } });
await mock.module('../packages/core/src/webhook/commentEventHandler.js', { namedExports: { fenceAdmittedManualCommand: fence } });
await mock.module('../packages/core/src/config/modelAliases.js', { namedExports: {
    resolveModelAlias: (model: string) => model === 'opus' ? 'claude-opus-5' : model,
    resolveLlmLabel: async (model: string) => { if (model !== 'claude-opus-5') throw new Error('unknown-model'); return { agentAlias: 'claude', model }; },
} });
await mock.module('../packages/core/src/daemon/configLoader.js', { namedExports: {
    getBotUsername: () => 'propr', isAutoCiFollowupEnabledForRepository: () => false,
} });
const sourceApi = await import('../packages/core/src/admission/admittedSource.js');
await mock.module('@propr/core', { namedExports: { ...admission, ...cancellation, ...sourceApi } });
const { verifyAdmittedSourceJob, requireSourcePublication } = await import('../src/jobs/ezerSourceAdmission.js');
const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(req.headers['x-ezer-admission-signature'], `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
    const value = JSON.parse(body);
    claimActions.push(value.action);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...value, claimId: 'claim', claimed: true, currentGeneration: value.generation, cancelled: false }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.EZER_ADMISSION_CLAIM_URL = `http://127.0.0.1:${(server.address() as any).port}`;
after(async () => { await queue.close(); redis.disconnect(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(async () => {
    await redis.flushdb(); requests = []; claimActions = []; fence.mock.resetCalls();
    pr = { state: 'open', head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'owner/repo' } },
        base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'owner/repo' } }, labels: [{ name: 'auto-merge' }] };
    message = { id: 9, user: { id: 42, login: 'owner' }, body: 'fix this', updated_at: '2026-09-29T10:00:00Z',
        submitted_at: '2026-09-29T10:00:00Z', created_at: '2026-09-29T10:00:00Z', state: 'COMMENTED',
        issue_url: 'https://api.github.com/repos/owner/repo/issues/7', pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/7',
        path: 'src/file.ts', line: 8, diff_hunk: '@@ -1 +1 @@\n-old\n+new' };
});
function source(overrides: Partial<SourceAdmissionBinding> = {}): SourceAdmissionBinding {
    return { kind: 'issue_comment', id: 9, authorId: 42, generation: 1,
        bodyDigest: `sha256:${createHash('sha256').update(message.body).digest('hex')}`, revisionAt: message.updated_at,
        headSha: pr.head.sha, headBranch: pr.head.ref, mode: 'fix', ...overrides };
}
async function pending(overrides: Record<string, unknown> = {}) {
    const claims = { version: 1, admissionId: 'typed-1', operationId: 'op-1', storyId: 'story', epicId: 'epic',
        featureThread: 'feature', repository: 'owner/repo', issueNumber: 7, target: 'main', scope: ['src/'],
        authorityRevision: 'r1', authorityDigest: 'd1', issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(), source: source(), ...overrides };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    await redis.set(admission.pendingExecutionAdmissionKey('owner/repo', 7), token);
    return { claims, token };
}
function enqueue(ref: Record<string, unknown> = {}) {
    return sourceApi.enqueueAdmittedSource({ repository: 'owner/repo', prNumber: 7, admissionId: 'typed-1', source: { kind: 'issue_comment', id: 9, ...ref } as any });
}
for (const kind of ['issue_comment', 'review_comment', 'review'] as const) test(`live ${kind} produces a single-use receipt and deterministic fix job`, async () => {
    await pending({ source: source({ kind }) });
    const result = await enqueue({ kind });
    assert.deepEqual(result, { mode: 'fix', jobId: 'pr-comments-batch-ezer-typed-1' });
    assert.deepEqual(await enqueue({ kind }), result);
    const job = (await queue.getJob(result.jobId))!;
    assert.equal(fence.mock.callCount(), 1);
    assert.deepEqual(job.data.executionAdmissionReceipt.source, source({ kind }));
    assert.equal(job.data.commandInstructions, job.data.comments[0].body);
    assert.doesNotMatch(job.data.commandInstructions, /ultrafix step|required unit tests/);
    assert.ok(!requests.some(route => route.endsWith('/check-runs') || route.endsWith('/status')));
    if (kind === 'review_comment') assert.equal(job.data.comments[0].body, 'fix this\n\n--- Review Comment Context ---\nFile: src/file.ts\nLine: 8\nCode context:\n```diff\n@@ -1 +1 @@\n-old\n+new\n```');
    assert.ok(requests.some(route => route.includes(kind === 'issue_comment' ? '/issues/comments/' : kind === 'review_comment' ? '/pulls/comments/' : '/reviews/')));
    await verifyAdmittedSourceJob(job.data, redis);
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /worker-receipt/);
});
for (const [field, value] of Object.entries({ kind: 'review', id: 10, authorId: 99, bodyDigest: `sha256:${'f'.repeat(64)}`,
    revisionAt: '2026-09-29T09:00:00Z', headSha: 'f'.repeat(40), headBranch: 'forged', mode: 'unsafe', model: 'unknown' })) {
    test(`forged ${field} refuses enqueue and preserves pending authority`, async () => {
        await pending({ source: source({ [field]: value }) });
        await assert.rejects(() => enqueue());
        assert.equal(await redis.get('ezer:execution-admission:consumed:typed-1'), null);
        assert.equal(await queue.getJob('pr-comments-batch-ezer-typed-1'), undefined);
    });
}
test('request fields cannot add a mode or model override', async () => {
    await pending();
    await assert.rejects(() => enqueue({ mode: 'review' }), /source-reference/);
    await assert.rejects(() => enqueue({ model: 'claude-opus-5' }), /source-reference/);
});
for (const version of [1, 2]) test(`source and legacy comment are mutually exclusive on admission v${version}`, async () => {
    await pending({ version, generation: 1, comment: { commentId: 9, bodyDigest: source().bodyDigest, headSha: pr.head.sha, headBranch: 'feature' } });
    await assert.rejects(() => enqueue(), /source-authority-mismatch/);
});
for (const version of [1, 2]) for (const step of [undefined, { loopId: 'loop1', ordinal: 2 }]) test(`admission v${version} accepts source${step ? ' and step' : ''} through worker consumption`, async () => {
    await pending({ version, ...(version === 2 ? { generation: 1 } : {}), ...(step ? { step } : {}) });
    const job = (await queue.getJob((await enqueue()).jobId))!;
    assert.deepEqual(job.data.executionAdmissionReceipt.source, source());
    assert.deepEqual(job.data.executionAdmissionReceipt.step, step);
    await verifyAdmittedSourceJob(job.data, redis);
    assert.deepEqual(claimActions, version === 2 ? ['claim', 'check'] : []);
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /worker-receipt/);
});
test('owner-review is distinct, read-only command routing with signed requested model', async () => {
    await pending({ source: source({ mode: 'review', model: 'claude-opus-5' }) });
    const result = await enqueue(); const job = (await queue.getJob(result.jobId))!;
    assert.equal(result.mode, 'review'); assert.equal(job.data.commandMode, 'owner-review');
    assert.deepEqual(job.data.requestedModels, ['claude-opus-5']);
    await verifyAdmittedSourceJob(job.data, redis);
});
for (const change of [ { commandMode: 'review' }, { requestedModels: ['forged'] }, { llm: 'forged' },
    { commandInstructions: 'forged' }, { ultrafixMeta: { cycle: 1 } } ]) test(`worker refuses forged execution routing ${JSON.stringify(change)}`, async () => {
    await pending(); const job = (await queue.getJob((await enqueue()).jobId))!;
    await assert.rejects(() => verifyAdmittedSourceJob({ ...job.data, ...change }, redis), /comment-binding-changed/);
});
for (const field of ['kind', 'id', 'authorId', 'generation', 'bodyDigest', 'revisionAt', 'headSha', 'headBranch', 'mode', 'model']) test(`receipt comparison refuses changed ${field}`, async () => {
    await pending(); const job = (await queue.getJob((await enqueue()).jobId))!;
    const forged = { ...job.data.executionAdmissionReceipt.source, [field]: field === 'id' || field === 'authorId' || field === 'generation' ? 88
        : field === 'kind' ? 'review' : field === 'mode' ? 'review' : field === 'headSha' ? 'f'.repeat(40)
        : field === 'bodyDigest' ? `sha256:${'f'.repeat(64)}` : field === 'revisionAt' ? '2026-09-28T00:00:00Z' : 'forged' };
    job.data.executionAdmissionReceipt.source = forged;
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis));
});
test('dismissed review refused before enqueue and after enqueue; deleted or edited sources cannot start', async () => {
    await pending({ source: source({ kind: 'review' }) }); message.state = 'DISMISSED';
    await assert.rejects(() => enqueue({ kind: 'review' }), /scope-changed/);
    message.state = 'COMMENTED'; const job = (await queue.getJob((await enqueue({ kind: 'review' })).jobId))!;
    message.state = 'DISMISSED'; await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /scope-changed/);
    message.state = 'COMMENTED'; message.body = 'changed'; await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /wrong-source/);
    message = null; await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /404/);
});
test('merge queues the conflict resolver with receipt and rechecks its exact head and base', async () => {
    await pending({ source: source({ mode: 'merge' }) }); const result = await enqueue();
    assert.deepEqual(result, { mode: 'merge', jobId: 'merge-ezer-typed-1' });
    const job = (await queue.getJob(result.jobId))!; assert.equal(job.name, 'processMergeConflict');
    await verifyAdmittedSourceJob(job.data, redis);
    assert.equal(fence.mock.callCount(), 0);
});
test('Ultrafix step is a fix with a separate deterministic identity and no local loop metadata', async () => {
    message.body = '/ezer ultrafix';
    await pending({ version: 2, generation: 1, step: { loopId: 'loop1', ordinal: 2 } }); const result = await enqueue();
    assert.deepEqual(result, { mode: 'fix', jobId: 'ultrafix-ezer-loop1-2' });
    const job = (await queue.getJob(result.jobId))!;
    assert.equal(job.data.commandMode, 'default'); assert.equal(job.data.ultrafixMeta, undefined);
    assert.match(job.data.commandInstructions, /ultrafix step 2: make the pull request's failing required checks pass on the current head, without unrelated changes/);
    for (const text of ['required unit tests', 'Conclusion: failure', 'Unit test failure', 'Expected 2, received 1',
        'external build', 'State: error', 'Build failed to compile', source().headSha, "Owner's own words as additional guidance:\n/ezer ultrafix"]) {
        assert.ok(job.data.commandInstructions.includes(text), text);
    }
    assert.doesNotMatch(job.data.commandInstructions, /passing lint|passing status/);
    assert.equal(job.data.comments[0].body, '/ezer ultrafix');
    assert.equal(job.data.executionAdmissionReceipt.source.bodyDigest, source().bodyDigest);
    const instructions = job.data.commandInstructions;
    job.data.commandInstructions = 'untrusted queue instructions';
    await verifyAdmittedSourceJob(job.data, redis);
    assert.equal(job.data.commandInstructions, instructions);
});
test('direct Ultrafix mode and a step attached to review are refused', async () => {
    await pending({ source: source({ mode: 'ultrafix' }) }); await assert.rejects(() => enqueue(), /requires-fix-step/);
    await pending({ source: source({ mode: 'review' }), step: { loopId: 'loop1', ordinal: 1 } }); await assert.rejects(() => enqueue(), /step-authority-mismatch/);
});
const cancelInput = { admissionId: 'typed-1', operationId: 'cancel-op', reason: 'source edited' };
test('cancel before consumption leaves a persistent tombstone and blocks the pending token', async () => {
    await pending(); assert.deepEqual(await cancellation.cancelExecutionAdmission(cancelInput, redis, queue), { state: 'not-started' });
    assert.deepEqual(await cancellation.cancelExecutionAdmission(cancelInput, redis, queue), { state: 'not-started' });
    assert.equal(await redis.ttl(cancellation.cancelledExecutionAdmissionKey('typed-1')), -1);
    await assert.rejects(() => enqueue(), /cancelled/);
});
test('cancel dequeues an indexed Ultrafix job and prevents resurrection', async () => {
    await pending({ step: { loopId: 'loop1', ordinal: 1 } }); const result = await enqueue();
    assert.deepEqual(await cancellation.cancelExecutionAdmission(cancelInput, redis, queue), { state: 'dequeued' });
    assert.equal(await queue.getJob(result.jobId), undefined); await assert.rejects(() => enqueue(), /cancelled/);
});
test('tombstone at worker start and before publication refuses work, including an Ultrafix step', async () => {
    await pending({ step: { loopId: 'loop1', ordinal: 1 } }); const job = (await queue.getJob((await enqueue()).jobId))!;
    await redis.set(cancellation.cancelledExecutionAdmissionKey('typed-1'), 'cancelled');
    await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /cancelled/);
    await assert.rejects(() => requireSourcePublication(job.data, redis), /cancelled/);
    await assert.rejects(() => requireSourcePublication(job.data, redis, 'c'.repeat(40)), (error: any) => error.pushedHead === 'c'.repeat(40));
});
for (const state of ['active', 'completed', 'failed']) test(`cancel ${state} reports requested versus settled truthfully`, async () => {
    const remove = mock.fn(async () => {});
    const fakeQueue = { getJob: async () => ({ id: 'pr-comments-batch-ezer-typed-1', data: { executionAdmissionReceipt: { admissionId: 'typed-1' } }, getState: async () => state, remove }) };
    const result = await cancellation.cancelExecutionAdmission(cancelInput, redis, fakeQueue as any);
    assert.equal(result.state, state === 'active' ? 'abort-requested' : 'already-settled');
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(Boolean(await redis.get('worker:abort:pr-comments-batch-ezer-typed-1')), state === 'active');
    if (state === 'active') assert.ok(await redis.ttl('worker:abort:pr-comments-batch-ezer-typed-1') > 3500 && await redis.ttl('worker:abort:pr-comments-batch-ezer-typed-1') <= 3600);
});

test('atomic receipt issuance refuses a tombstone that races the earlier enqueue check', async () => {
    const store = admission.createRedisAdmissionStore(redis);
    await redis.set(cancellation.cancelledExecutionAdmissionKey('atomic'), 'cancelled');
    assert.equal(await store.consumeAndIssue('ezer:execution-admission:consumed:atomic', 'ezer:execution-admission:receipt:atomic', '{}', 60), false);
    assert.equal(await redis.get('ezer:execution-admission:receipt:atomic'), null);
});
test('cancel racing dequeue with worker activation requests abort instead of confirming cessation', async () => {
    let active = false;
    const job = { id: 'pr-comments-batch-ezer-typed-1', data: { executionAdmissionReceipt: { admissionId: 'typed-1' } },
        getState: async () => active ? 'active' : 'waiting', remove: async () => { active = true; throw new Error('job locked'); } };
    assert.deepEqual(await cancellation.cancelExecutionAdmission(cancelInput, redis, { getJob: async () => job } as any), { state: 'abort-requested' });
    assert.ok(await redis.get('worker:abort:pr-comments-batch-ezer-typed-1'));
});
test('worker checks unchanged digest AND revision, owner identity and head after enqueue', async () => {
    await pending(); const job = (await queue.getJob((await enqueue()).jobId))!;
    message.updated_at = '2026-09-29T10:00:01Z'; await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /revisionAt/);
    message.updated_at = '2026-09-29T10:00:00Z'; message.user.id = 99; await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /scope-changed/);
    message.user.id = 42; pr.head.sha = 'c'.repeat(40); await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis), /headSha/);
});
test("Ezer's review authority admits only ProPR's own unedited review comment, as a fix", async () => {
    process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID = '77';
    try {
        message.user = { id: 77, login: 'propr-dev[bot]' };
        await pending({ source: source({ authorId: 77, authority: 'ezer-review' }) });
        const result = await enqueue();
        assert.deepEqual(result, { mode: 'fix', jobId: 'pr-comments-batch-ezer-typed-1' });
        const job = (await queue.getJob(result.jobId))!;
        assert.equal(job.data.executionAdmissionReceipt.source.authority, 'ezer-review');
        // An edit after it was posted makes it no longer the review Ezer recorded.
        message.updated_at = '2026-09-29T10:00:01Z';
        await assert.rejects(() => verifyAdmittedSourceJob(job.data, redis));
    } finally {
        delete process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID;
    }
});
test('Ezer review authority refuses the owner, other authors, other modes and kinds, and an unset identity', async () => {
    for (const [author, configured, overrides] of [
        [42, '77', {}],
        [77, undefined, {}],
        [77, '77', { mode: 'ultrafix' }],
        [77, '77', { kind: 'review' }],
        [77, '77', { authority: 'someone-else' }],
    ] as const) {
        await redis.flushdb();
        if (configured) process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID = configured;
        else delete process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID;
        message.user = { id: author, login: 'someone' };
        await pending({ source: source({ authorId: author, authority: 'ezer-review', ...(overrides as object) } as never) });
        await assert.rejects(() => enqueue({ kind: (overrides as { kind?: string }).kind ?? 'issue_comment' }));
        assert.equal(await queue.getJob('pr-comments-batch-ezer-typed-1'), undefined);
    }
    delete process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID;
    message.user = { id: 42, login: 'owner' };
});

for (const triggerAuthor of [undefined, '322838413', 'malformed']) {
    test(`typed-source review identity is independent of trigger setting ${triggerAuthor}`, async (t) => {
        const previousTrigger = process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID;
        const previousSource = process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID;
        t.after(() => {
            if (previousTrigger === undefined) delete process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID;
            else process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID = previousTrigger;
            if (previousSource === undefined) delete process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID;
            else process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID = previousSource;
        });
        if (triggerAuthor === undefined) delete process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID;
        else process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID = triggerAuthor;
        process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID = '77';
        message.user = { id: 77, login: 'propr-dev[bot]' };
        await pending({ source: source({ authorId: 77, authority: 'ezer-review' }) });
        const result = await enqueue();
        assert.equal(result.mode, 'fix');
        assert.equal((await queue.getJob(result.jobId))!.data.executionAdmissionReceipt.source.authorId, 77);
        await redis.flushdb();
        message.user = { id: 322838413, login: 'gospelib-ezer[bot]' };
        await pending({ source: source({ authorId: 322838413, authority: 'ezer-review' }) });
        await assert.rejects(() => enqueue(), /source-github-scope-changed/);
        assert.equal(await queue.getJob('pr-comments-batch-ezer-typed-1'), undefined);
        delete process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID;
        await assert.rejects(() => enqueue(), /source-github-scope-changed/);
    });
}

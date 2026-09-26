import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import {
    consumeExecutionAdmission, verifyWorkerAdmissionReceipt, inspectWorkerAdmissionReceipt,
    createRedisAdmissionStore, readExecutionAdmissionConsumption,
    type AdmissionStore,
} from '../src/admission/ezerExecutionAdmission.js';
import {
    admissionTokenDigest, type AdmissionClaimRequest,
    type AdmissionClaimResponse, type AdmissionClaimClient,
} from '../src/admission/ezerAdmissionClaim.js';

const SECRET = 'test-only-admission-v2-secret-at-least-32-bytes';
const LEASE_MS = 60_000;
const EXPECTED = { repository: 'GospeLib/main', issueNumber: 42, target: 'stage' };
const GENERATION = 3;
const VERSION = 2;
const EXECUTION = { baseSha: 'a'.repeat(40), featureBranch: 'task/v2', targetBranch: EXPECTED.target,
    allowedPaths: ['docs/v2.md'] };

function fixture(overrides: Record<string, unknown> = {}) {
    const values = new Map<string, string>();
    const claims = { version: VERSION, generation: GENERATION, admissionId: 'admission-v2', operationId: 'operation-v2',
        storyId: 'EP-v2-S01', epicId: 'EP-v2', featureThread: 'EP-v2', ...EXPECTED,
        scope: EXECUTION.allowedPaths, storyExecution: EXECUTION, authorityRevision: 'revision', authorityDigest: 'digest',
        issuedAt: new Date(Date.now() - LEASE_MS).toISOString(), expiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
        ...overrides };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`;
    const store: AdmissionStore = {
        async get(key) { return values.get(key) ?? null; },
        async take(key) { const value = values.get(key) ?? null; values.delete(key); return value; },
        async consumeAndIssue(key, receipt, value) {
            if (values.has(key)) return false;
            values.set(key, value); values.set(receipt, value); return true;
        },
    };
    return { claims, token, store, values, signingSecret: SECRET, expected: EXPECTED };
}

function journal() {
    let generation = GENERATION;
    let cancelled = false;
    const claims = new Map<string, AdmissionClaimResponse>();
    const requests: AdmissionClaimRequest[] = [];
    const client: AdmissionClaimClient = async request => {
        requests.push(request);
        const prior = claims.get(request.admissionId);
        if (prior && prior.tokenDigest !== request.tokenDigest) throw Error('conflicting-admission');
        if (request.action === 'check' && (!prior || request.claimId !== prior.claimId)) throw Error('unclaimed');
        const { version, admissionId, operationId, repository, epicId, unitId, tokenDigest } = request;
        const response = prior ?? { version, admissionId, operationId, repository, epicId, unitId, tokenDigest,
            generation: request.generation, claimId: 'journal-claim-1', claimed: !cancelled && generation === request.generation,
            currentGeneration: generation, cancelled };
        if (response.claimed) claims.set(admissionId, response);
        return { ...response, currentGeneration: generation, cancelled };
    };
    return { client, requests, claims,
        cancel() { generation++; cancelled = true; },
        retry() { generation++; cancelled = false; },
    };
}

const neverCall: AdmissionClaimClient = async () => { throw Error('v1-called-claim-client'); };

test('v1 stores exactly the original receipt bytes and never calls Ezer at either gate', async () => {
    const f = fixture({ version: 1, generation: undefined });
    const result = await consumeExecutionAdmission({ ...f, claimClient: neverCall });
    assert.equal(result.receipt.version, undefined);
    assert.equal(f.values.get(result.receipt.receiptKey), JSON.stringify({
        admissionId: f.claims.admissionId, operationId: f.claims.operationId, storyId: f.claims.storyId,
        repository: f.claims.repository, issueNumber: f.claims.issueNumber, target: f.claims.target,
        storyExecution: EXECUTION, executionDeadline: f.claims.expiresAt,
    }));
    await verifyWorkerAdmissionReceipt({ ...f, receipt: result.receipt, claimClient: neverCall });
});

test('v2 claims and checks exact identity; single-use receipt permits only one worker', async () => {
    const f = fixture(), j = journal();
    const result = await consumeExecutionAdmission({ ...f, claimClient: j.client });
    await inspectWorkerAdmissionReceipt({ ...f, receipt: result.receipt });
    assert.equal(j.requests.length, 1, 'preparation is not a claim or execution');
    let workers = 0;
    const run = async () => { await verifyWorkerAdmissionReceipt({ ...f, receipt: result.receipt, claimClient: j.client }); workers++; };
    const outcomes = await Promise.allSettled([run(), run()]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(workers, 1);
    assert.equal(j.claims.size, 1);
    assert.equal(j.requests[0].tokenDigest, admissionTokenDigest(f.token));
    assert.equal(j.requests[0].unitId, f.claims.storyId);
    assert.equal(j.requests.at(-1)?.action, 'check');
    await assert.rejects(consumeExecutionAdmission({ ...f, claimClient: j.client }), /replayed-admission/);
});

test('stale or missing generation cannot consume; cancel then retry never revives old admission', async () => {
    const j = journal(); j.cancel(); j.retry();
    const f = fixture();
    await assert.rejects(consumeExecutionAdmission({ ...f, claimClient: j.client }));
    assert.equal(f.values.size, 0);
    for (const generation of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
        await assert.rejects(consumeExecutionAdmission({ ...fixture({ generation }), claimClient: neverCall }), /invalid-unit-generation/);
    }
});

test('claim refusal, malformed response, and Ezer unavailability burn no admission', async () => {
    for (const client of [async () => { throw Error('ECONNREFUSED'); }, async () => null,
        async () => ({ claimed: false }), async () => ({ claimed: true, version: VERSION })]) {
        const f = fixture();
        await assert.rejects(consumeExecutionAdmission({ ...f, claimClient: client as AdmissionClaimClient }));
        assert.equal(f.values.size, 0);
        await consumeExecutionAdmission({ ...f, claimClient: journal().client });
    }
});

test('mismatched claim identities and current generation are refused', async () => {
    for (const change of [{ currentGeneration: GENERATION + 1 }, { cancelled: true },
        { operationId: 'other' }, { tokenDigest: 'other' }, { unitId: 'other' }, { repository: 'other' },
        { generation: GENERATION + 1 }, { claimId: '' }, { cancelled: undefined }]) {
        const f = fixture(), j = journal();
        await assert.rejects(consumeExecutionAdmission({ ...f,
            claimClient: async request => ({ ...await j.client(request), ...change }) as AdmissionClaimResponse }));
        assert.equal(f.values.size, 0);
    }
});

test('failed worker recheck preserves receipt, then retry starts once with the original claim', async () => {
    const f = fixture(), j = journal();
    const { receipt } = await consumeExecutionAdmission({ ...f, claimClient: j.client });
    await assert.rejects(verifyWorkerAdmissionReceipt({ ...f, receipt,
        claimClient: async () => { throw Error('Ezer unreachable'); } }));
    assert.ok(await f.store.get(receipt.receiptKey));
    await verifyWorkerAdmissionReceipt({ ...f, receipt, claimClient: j.client });
    assert.equal(j.claims.size, 1);
    assert.equal(j.requests.at(-1)?.claimId, 'journal-claim-1');
});

test('pause after recorded claim, complete cancel, resume: no worker starts', async () => {
    const f = fixture(), j = journal();
    const recorded = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const consuming = consumeExecutionAdmission({ ...f, claimClient: async request => {
        const response = await j.client(request);
        recorded.resolve();
        await resume.promise;
        return response; // deliberately stale success, as with a delayed HTTP response
    } });
    await recorded.promise;
    j.cancel();
    resume.resolve();
    const { receipt } = await consuming;
    let workers = 0;
    await assert.rejects(async () => {
        await verifyWorkerAdmissionReceipt({ ...f, receipt, claimClient: j.client });
        workers++;
    }, /stale-unit-generation/);
    j.retry();
    await assert.rejects(verifyWorkerAdmissionReceipt({ ...f, receipt, claimClient: j.client }), /stale-unit-generation/);
    assert.equal(workers, 0);
});

test('a queue payload cannot downgrade a v2 receipt to bypass the claim recheck', async () => {
    const f = fixture();
    const { receipt } = await consumeExecutionAdmission({ ...f, claimClient: journal().client });
    delete receipt.version;
    await assert.rejects(verifyWorkerAdmissionReceipt({ ...f, receipt }), /worker-receipt-version-mismatch/);
});

function delegation() {
    return { grantId: 'grant', delegatePrincipalId: 'delegate', delegateSessionId: 'session', approvalPrincipalId: 'owner',
        grantIssuedAt: new Date(Date.now() - LEASE_MS).toISOString(),
        scope: { epicId: 'EP-v2', storyId: 'EP-v2-S01', repository: EXPECTED.repository,
            issueNumber: EXPECTED.issueNumber, attemptOrdinal: 1, targetBranch: EXPECTED.target, allowedPaths: EXECUTION.allowedPaths } };
}
test('only v2 supports durable delegation without grantExpiresAt and startBy; admission lease stays finite', async () => {
    const fields = { delegatedAuthority: delegation(), attemptOrdinal: 1 };
    const f = fixture(fields), j = journal();
    const { receipt } = await consumeExecutionAdmission({ ...f, claimClient: j.client });
    await verifyWorkerAdmissionReceipt({ ...f, receipt, claimClient: j.client });
    await assert.rejects(consumeExecutionAdmission({ ...fixture({ ...fields, version: 1 }), claimClient: neverCall }), /invalid-delegation-grant-window/);
    const expiry = new Date(Date.now() + LEASE_MS).toISOString();
    await assert.rejects(consumeExecutionAdmission({ ...fixture({ ...fields, version: 1,
        delegatedAuthority: { ...delegation(), grantExpiresAt: expiry } }), claimClient: neverCall }), /delegation-start-unbounded/);
    for (const overrides of [{ expiresAt: undefined }, { expiresAt: new Date(Date.now() - 1).toISOString() },
        { startBy: new Date(Date.now() - 1).toISOString() },
        { ...fields, delegatedAuthority: { ...delegation(), grantExpiresAt: new Date(Date.now() - 1).toISOString() } }]) {
        await assert.rejects(consumeExecutionAdmission({ ...fixture(overrides), claimClient: neverCall }), /expired|missing-expires-at/);
    }
});

test('HTTP claim lost response is retry-safe, signed, and fails closed without consuming Redis authority', async t => {
    const priorUrl = process.env.EZER_ADMISSION_CLAIM_URL;
    const priorSecret = process.env.EZER_INTERNAL_API_SECRET;
    const j = journal();
    let loseResponse = true;
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
        if (req.method !== 'POST' || req.headers['x-ezer-admission-signature'] !== signature) {
            res.writeHead(401).end(); return;
        }
        const result = await j.client(JSON.parse(body) as AdmissionClaimRequest);
        if (loseResponse) { loseResponse = false; req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.EZER_ADMISSION_CLAIM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/claims`;
    process.env.EZER_INTERNAL_API_SECRET = SECRET;
    t.after(async () => {
        if (priorUrl === undefined) delete process.env.EZER_ADMISSION_CLAIM_URL; else process.env.EZER_ADMISSION_CLAIM_URL = priorUrl;
        if (priorSecret === undefined) delete process.env.EZER_INTERNAL_API_SECRET; else process.env.EZER_INTERNAL_API_SECRET = priorSecret;
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const f = fixture();
    await assert.rejects(consumeExecutionAdmission(f), /claim-unavailable/);
    assert.equal(f.values.size, 0);
    assert.equal(j.claims.size, 1, 'Ezer journaled the lost response');
    const { receipt } = await consumeExecutionAdmission(f);
    await verifyWorkerAdmissionReceipt({ ...f, receipt });
    assert.equal(j.claims.size, 1);
    assert.equal(j.requests.length, 3);
    assert.deepEqual(j.requests[0], j.requests[1], 'retry repeats the exact claim request');
});

test('real Redis Lua retains single-use consumption and replay rejection under v2', async t => {
    const redis = new Redis({ host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6379),
        retryStrategy: () => null });
    t.after(() => redis.disconnect());
    const f = fixture({ admissionId: `v2-redis-${process.pid}` }), j = journal();
    const store = createRedisAdmissionStore(redis);
    const input = { ...f, store, claimClient: j.client };
    const outcomes = await Promise.allSettled([consumeExecutionAdmission(input), consumeExecutionAdmission(input)]);
    const success = outcomes.find(outcome => outcome.status === 'fulfilled');
    assert.ok(success && success.status === 'fulfilled');
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    assert.deepEqual(await readExecutionAdmissionConsumption(store, f.claims.admissionId),
        { admissionConsumed: true, workerReceiptPresent: true });
    await verifyWorkerAdmissionReceipt({ ...input, receipt: success.value.receipt });
    assert.deepEqual(await readExecutionAdmissionConsumption(store, f.claims.admissionId),
        { admissionConsumed: true, workerReceiptPresent: false });
    await redis.del(success.value.receipt.receiptKey, `ezer:execution-admission:consumed:${f.claims.admissionId}`);
});

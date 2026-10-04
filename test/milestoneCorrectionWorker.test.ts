import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as contract from '../packages/core/src/admission/milestoneCorrection.js';
import { exactSha, milestoneSignature, MILESTONE_SIGNATURE_HEADER } from '../packages/core/src/admission/milestoneMaintenance.js';
import { correctionFixture, SECRET } from './helpers/milestoneCorrectionFixture.js';
import { signedMaintenanceApi, SIGNED_MERGE_SHA } from './helpers/signedMaintenanceApi.js';
import { createMainJobProcessor } from '../src/workerFactory.js';
let repositoryPath = '';
let api: ReturnType<typeof signedMaintenanceApi>;
let paused = false;
let ran = 0;
let callbackMode = 'valid';
const spent = new Set<string>();
await mock.module('@propr/core', { namedExports: {
    ...contract, exactSha, milestoneSignature, MILESTONE_SIGNATURE_HEADER,
    getAuthenticatedOctokit: async () => ({ ...api, auth: async () => ({ token: 'worker-only' }) }),
    ensureRepoCloned: async () => repositoryPath,
    getRepoUrl: () => 'https://example.test/owner/repo',
    logger: { withCorrelation: () => ({}) },
    issueQueue: {
        isPaused: async () => paused,
        client: Promise.resolve({ set: async (key: string, _token: string, mode: string) => {
            assert.equal(mode, 'NX');
            if (spent.has(key)) return null;
            spent.add(key); return 'OK';
        } }),
    },
} });
await mock.module('../src/jobs/mergeConflictAgentRunner.js', { namedExports: {
    runMilestoneConflictAgent: async ({ worktreePath, request, fence }: any) => {
        await fence();
        ran++;
        assert.equal(request.instructions, 'Fix the file');
        await writeFile(join(worktreePath, 'file'), 'corrected\n');
        if (callbackMode === 'withdraw-after-agent') callbackMode = 'denied';
    },
} });
const { processMilestoneCorrection } = await import('../src/jobs/milestoneCorrection.js');
const processJob = createMainJobProcessor({ processMilestoneCorrection } as never);
process.env.EZER_ADMISSION_HMAC_SECRET = SECRET;
process.env.EZER_INTERNAL_API_SECRET = SECRET;
process.env.EZER_API_BASE_URL = 'https://ezer.example.test';

for (const mode of ['valid', 'denied', 'wrong-id', 'false', 'withdraw-after-agent', 'paused', 'expired', 'empty']) {
    test(`registered worker enforces signed HTTP authority and one attempt: ${mode}`, async () => {
        const f = await correctionFixture();
        repositoryPath = f.root;
        f.git(['remote', 'add', 'origin', f.root]);
        api = signedMaintenanceApi(f.root, f.p.fromHead);
        paused = mode === 'paused'; ran = 0; spent.clear(); callbackMode = mode;
        if (mode === 'expired') f.p.expiresAt = new Date(0).toISOString();
        if (mode === 'empty') f.p.instructions = ' ';
        const fetchMock = mock.method(globalThis, 'fetch', async (url: any, options: any) => {
            assert.equal(String(url), 'https://ezer.example.test/internal/milestone-correction-authority');
            assert.equal(options.method, 'POST');
            assert.equal(options.redirect, 'error');
            assert.equal(options.body, JSON.stringify({ requestId: f.p.requestId }));
            assert.equal(options.headers[MILESTONE_SIGNATURE_HEADER], milestoneSignature(options.body, SECRET));
            return new Response(JSON.stringify({ valid: callbackMode !== 'false', requestId: callbackMode === 'wrong-id' ? 'other' : f.p.requestId }), { status: callbackMode === 'denied' ? 403 : 200 });
        });
        const job = { name: contract.MILESTONE_CORRECTION_JOB, data: { token: contract.signMilestoneCorrectionRequest(f.p, SECRET) } };
        try {
            if (mode === 'valid') {
                const result = await processJob(job as never);
                assert.equal(result.commit, SIGNED_MERGE_SHA);
                await assert.rejects(processJob(job as never), /attempt-already-spent/);
                assert.equal(ran, 1);
            } else {
                await assert.rejects(processJob(job as never));
                assert.equal(ran, mode === 'withdraw-after-agent' ? 1 : 0);
                assert.equal(api.ref(), f.p.fromHead);
                assert.ok(!api.calls.some(c => c.endpoint === 'POST /graphql'));
                if (['expired', 'paused', 'empty'].includes(mode)) assert.equal(fetchMock.mock.callCount(), 0);
            }
        } finally { fetchMock.mock.restore(); await f.cleanup(); }
    });
}

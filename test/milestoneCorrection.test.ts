import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeMilestoneCorrection } from '../src/jobs/milestoneCorrectionExecution.js';
import { readMilestoneCorrectionRequest, signMilestoneCorrectionRequest, milestoneCorrectionCommitMessage, MILESTONE_CORRECTION_INSTRUCTION_BYTES } from '../packages/core/src/admission/milestoneCorrection.js';
import { correctionFixture, SECRET } from './helpers/milestoneCorrectionFixture.js';
import { signedMaintenanceApi, SIGNED_MERGE_SHA } from './helpers/signedMaintenanceApi.js';

test('correction starts at exact head in private repository and publishes one signed parent/message with CAS', async () => {
    const f = await correctionFixture();
    try {
        const api = signedMaintenanceApi(f.root, f.p.fromHead);
        let runs = 0;
        const result = await executeMilestoneCorrection(f.p, {
            repositoryPath: f.root, api, fence: async () => {},
            correct: async (path, request) => {
                runs++;
                assert.deepEqual(request, f.p);
                const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
                assert.equal(git(['rev-parse', 'HEAD']), f.p.fromHead);
                assert.equal(git(['remote']), '');
                assert.ok(!git(['rev-parse', '--git-common-dir']).includes(f.root));
                await writeFile(join(path, 'file'), 'corrected\n');
            },
        });
        assert.equal(runs, 1);
        assert.equal(result, SIGNED_MERGE_SHA);
        const commit = api.calls.find(c => c.endpoint.endsWith('/git/commits'))!;
        assert.deepEqual(commit.options.parents, [f.p.fromHead]);
        assert.equal(commit.options.message, milestoneCorrectionCommitMessage(f.p.requestId));
        const update = api.calls.find(c => c.endpoint === 'POST /graphql')!;
        assert.equal(update.options.variables.input.refUpdates[0].beforeOid, f.p.fromHead);
        assert.equal(update.options.variables.input.refUpdates[0].force, false);
    } finally { await f.cleanup(); }
});

for (const failure of ['scope', 'rename', 'delete', 'no-change', 'pause', 'agent', 'head', 'late-scope', 'late-pause', 'race', 'unverified', 'wrong-parent', 'wrong-message']) {
    test(`correction refuses publication: ${failure}`, async () => {
        const f = await correctionFixture();
        let ran = false;
        let revoked = false;
        let worktree = '';
        try {
            const api = signedMaintenanceApi(f.root, f.p.fromHead, {
                raceAtUpdate: failure === 'race' ? 'e'.repeat(40) : undefined,
                unverified: failure === 'unverified',
                onCreate: async () => {
                    if (failure === 'late-scope') await writeFile(join(worktree, 'other'), 'outside\n');
                    if (failure === 'late-pause') revoked = true;
                },
            });
            await assert.rejects(executeMilestoneCorrection(f.p, {
                repositoryPath: f.root,
                api: { request: async (endpoint, options) => {
                    const response = await api.request(endpoint, options);
                    if (endpoint.endsWith('/git/commits')) {
                        if (failure === 'wrong-parent') (response.data as any).parents.push({ sha: 'b'.repeat(40) });
                        if (failure === 'wrong-message') (response.data as any).message = 'foreign';
                    }
                    return response;
                } },
                fence: async () => { if (revoked || (ran && failure === 'pause')) throw Error('paused'); },
                correct: async path => {
                    ran = true; worktree = path;
                    if (failure === 'agent') throw Error('agent failed');
                    if (failure === 'no-change') return;
                    await writeFile(join(path, 'file'), 'corrected\n');
                    if (failure === 'scope') await writeFile(join(path, 'other'), 'outside\n');
                    if (failure === 'rename') await rename(join(path, 'file'), join(path, 'outside'));
                    if (failure === 'delete') await rm(join(path, 'other'));
                    if (failure === 'head') execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.test', 'commit', '-am', 'unauthorized'], { cwd: path });
                },
            }));
            assert.equal(api.ref(), failure === 'race' ? 'e'.repeat(40) : f.p.fromHead);
            if (failure !== 'race') assert.ok(!api.calls.some(c => c.endpoint === 'POST /graphql'));
        } finally { await f.cleanup(); }
    });
}

test('signed correction mirrors strict ids, scope, attempt and instruction contract', async () => {
    const f = await correctionFixture();
    try {
        const token = signMilestoneCorrectionRequest(f.p, SECRET);
        assert.deepEqual(readMilestoneCorrectionRequest(token, SECRET), f.p);
        assert.throws(() => readMilestoneCorrectionRequest(token + 'x', SECRET));
        for (const override of [
            { requestId: 'a'.repeat(64) }, { epicId: '../bad' }, { milestoneId: 'bad/id' },
            { reviewId: 0 }, { reviewId: 3 }, { prNumber: 2 }, { attempt: 1 },
            { scope: [] }, { scope: ['../file'] }, { scope: ['file', 'file'] },
            { scope: ['z', 'a'] }, { scope: ['src\\file'] }, { scope: ['src/'] },
            { scope: ['/file'] }, { scope: ['src//file'] }, { scope: ['src/./file'] },
            { scope: ['a:b'] }, { scope: ['a\u0000b'] }, { fromHead: '--upload-pack=bad' },
            { instructions: 'é'.repeat(MILESTONE_CORRECTION_INSTRUCTION_BYTES) },
            { unexpected: true }, { branch: 'stage' }, { expiresAt: 'never' },
        ]) assert.throws(() => readMilestoneCorrectionRequest(signMilestoneCorrectionRequest({ ...f.p, ...override } as never, SECRET), SECRET), JSON.stringify(override).slice(0, 100));
        const empty = { ...f.p, instructions: '' };
        assert.deepEqual(readMilestoneCorrectionRequest(signMilestoneCorrectionRequest(empty, SECRET), SECRET), empty);
        await assert.rejects(executeMilestoneCorrection(empty, {} as never), /missing-instructions/);
    } finally { await f.cleanup(); }
});

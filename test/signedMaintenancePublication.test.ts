import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { publishSignedMaintenanceCommit } from '../src/jobs/signedMaintenancePublication.js';
import { signedMaintenanceApi, SIGNED_MERGE_SHA } from './helpers/signedMaintenanceApi.js';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'signed-merge-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git(['init', '-b', 'feature']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.test']);
    await writeFile(join(root, 'conflict'), 'initial\n');
    await writeFile(join(root, 'deleted'), 'delete me');
    git(['add', '.']); git(['commit', '-m', 'initial']);
    git(['checkout', '-b', 'base']);
    await writeFile(join(root, 'conflict'), 'base\n');
    await writeFile(join(root, 'inherited'), 'from base');
    git(['add', '.']); git(['commit', '-m', 'base']);
    const baseSha = git(['rev-parse', 'HEAD']);
    git(['checkout', 'feature']);
    await writeFile(join(root, 'conflict'), 'feature\n');
    git(['add', '.']); git(['commit', '-m', 'feature']);
    const headSha = git(['rev-parse', 'HEAD']);
    try { git(['merge', '--no-commit', 'base']); } catch { /* real conflict */ }
    await writeFile(join(root, 'conflict'), Buffer.from([0, 255, 13, 10, 128]));
    await rm(join(root, 'deleted'));
    await symlink('conflict', join(root, 'link'));
    await writeFile(join(root, 'script'), '#!/bin/sh\nexit 0\n'); await chmod(join(root, 'script'), 0o755);
    return { root, git, input: { owner: 'owner', repo: 'repo', worktreePath: root, branch: 'feature', headSha, baseSha,
        commitMessage: 'fix: resolve merge', beforePublish: async () => {} } };
}

test('publishes a verified two-parent merge with exact resolved binary bytes, deletions, modes and inherited base files', async () => {
    const f = await fixture();
    try {
        const api = signedMaintenanceApi(f.root, f.input.headSha);
        assert.equal(await publishSignedMaintenanceCommit({ ...f.input, octokit: api }), SIGNED_MERGE_SHA);
        const commit = api.calls.find(c => c.endpoint === 'POST /repos/{owner}/{repo}/git/commits')!.options;
        assert.deepEqual(commit.parents, [f.input.headSha, f.input.baseSha]);
        assert.equal(api.ref(), SIGNED_MERGE_SHA);
        assert.ok([...api.blobs.values()].some(b => b.equals(Buffer.from([0, 255, 13, 10, 128]))));
        const tree = api.calls.find(c => c.endpoint.endsWith('/git/trees'))!.options.tree;
        assert.equal(tree.find((e: any) => e.path === 'script').mode, '100755');
        assert.equal(tree.find((e: any) => e.path === 'link').mode, '120000');
        assert.ok(tree.find((e: any) => e.path === 'inherited'));
        assert.equal(tree.some((e: any) => e.path === 'deleted'), false);
        assert.equal(f.git(['rev-parse', 'HEAD']), f.input.headSha);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});

for (const failure of ['moved-before', 'race-second-parent', 'race-other', 'unverified', 'parents', 'tree-mutation', 'cancelled'] as const) {
    test(`refuses publication: ${failure}`, async () => {
        const f = await fixture();
        try {
            const api = signedMaintenanceApi(f.root, f.input.headSha, {
                raceAtUpdate: failure === 'race-second-parent' ? f.input.baseSha : failure === 'race-other' ? 'e'.repeat(40) : undefined,
                unverified: failure === 'unverified', wrongParents: failure === 'parents',
                onCreate: failure === 'tree-mutation' ? async () => { await writeFile(join(f.root, 'conflict'), 'changed again'); } : undefined,
            });
            if (failure === 'moved-before') api.moveRef(f.input.baseSha);
            await assert.rejects(publishSignedMaintenanceCommit({ ...f.input, octokit: api,
                beforePublish: async () => { if (failure === 'cancelled') throw new Error('cancelled'); },
            }));
            assert.notEqual(api.ref(), SIGNED_MERGE_SHA);
        } finally { await rm(f.root, { recursive: true, force: true }); }
    });
}

test('names the base tip Git actually merged as the second parent when the base moved forward', async () => {
    const f = await fixture();
    try {
        // The admitted base is an older base commit; the worker merged the tip that descends from it.
        const admitted = f.git(['rev-parse', `${f.input.baseSha}^`]);
        const api = signedMaintenanceApi(f.root, f.input.headSha);
        await publishSignedMaintenanceCommit({ ...f.input, baseSha: admitted, octokit: api });
        const commit = api.calls.find(c => c.endpoint === 'POST /repos/{owner}/{repo}/git/commits')!.options;
        assert.deepEqual(commit.parents, [f.input.headSha, f.input.baseSha]);
    } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('refuses a merged base that no longer contains the admitted base', async () => {
    const f = await fixture();
    try {
        const api = signedMaintenanceApi(f.root, f.input.headSha);
        await assert.rejects(
            publishSignedMaintenanceCommit({ ...f.input, baseSha: f.input.headSha, octokit: api }),
            /maintenance-base-moved/,
        );
    } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('names the base tip after a fast-forward (the admitted head was already in the base)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'signed-ff-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    try {
        git(['init', '-b', 'feature']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.test']);
        await writeFile(join(root, 'a'), 'a\n'); git(['add', '.']); git(['commit', '-m', 'head']);
        const headSha = git(['rev-parse', 'HEAD']);
        git(['checkout', '-b', 'base']);
        await writeFile(join(root, 'b'), 'b\n'); git(['add', '.']); git(['commit', '-m', 'base tip']);
        const tip = git(['rev-parse', 'HEAD']);
        git(['checkout', 'feature']); git(['merge', '--no-edit', tip]);
        assert.equal(git(['rev-parse', 'HEAD']), tip);
        const api = signedMaintenanceApi(root, headSha);
        await publishSignedMaintenanceCommit({ owner: 'owner', repo: 'repo', worktreePath: root, branch: 'feature', headSha,
            baseSha: headSha, commitMessage: 'merge', beforePublish: async () => {}, octokit: api });
        const commit = api.calls.find(c => c.endpoint === 'POST /repos/{owner}/{repo}/git/commits')!.options;
        assert.deepEqual(commit.parents, [headSha, tip]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

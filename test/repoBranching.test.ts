import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pushBranch, ensureBranchAndPush, redactAuthenticatedGitUrl } from '../packages/core/src/git/repoBranching.js';
import { addWorktreeWithoutTracking } from '../packages/core/src/git/worktreeCreation.js';
import { createHooklessGit } from '../packages/core/src/git/hooklessGit.js';

const execGit = promisify(execFile);

test('authenticated Git URL redaction removes modern installation tokens', () => {
    const token = 'ghs_1234567_eyJhbGciOiJFUzI1NiJ9.abc-DEF_123.xyz';
    const input = `remote https://x-access-token:${token}@github.com/integry/propr.git raw ${token}`;
    const result = redactAuthenticatedGitUrl(input);

    assert.ok(!result.includes(token));
    assert.match(result, /https:\/\/x-access-token:\[REDACTED\]@github\.com\/integry\/propr\.git/);
    assert.match(result, /raw \[REDACTED_GITHUB_TOKEN\]/);
});

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execGit('git', args, { cwd });
    return stdout.trim();
}

async function configureUser(cwd: string): Promise<void> {
    await git(cwd, ['config', 'user.email', 'test@example.com']);
    await git(cwd, ['config', 'user.name', 'Test User']);
}

test('pushBranch rebases and retries when remote branch advanced', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-repo-branching-'));
    try {
        const remotePath = path.join(tempDir, 'remote.git');
        const firstClone = path.join(tempDir, 'first');
        const secondClone = path.join(tempDir, 'second');

        await git(tempDir, ['init', '--bare', remotePath]);
        await git(tempDir, ['clone', remotePath, firstClone]);
        await configureUser(firstClone);

        await writeFile(path.join(firstClone, 'README.md'), 'base\n');
        await git(firstClone, ['add', 'README.md']);
        await git(firstClone, ['commit', '-m', 'base']);
        await git(firstClone, ['branch', '-M', 'main']);
        await git(firstClone, ['push', '-u', 'origin', 'main']);

        await git(firstClone, ['checkout', '-b', 'feature']);
        await writeFile(path.join(firstClone, 'feature.txt'), 'initial\n');
        await git(firstClone, ['add', 'feature.txt']);
        await git(firstClone, ['commit', '-m', 'initial feature']);
        await git(firstClone, ['push', '-u', 'origin', 'feature']);

        await git(tempDir, ['clone', remotePath, secondClone]);
        await configureUser(secondClone);
        await git(secondClone, ['checkout', 'feature']);
        await writeFile(path.join(secondClone, 'remote.txt'), 'remote change\n');
        await git(secondClone, ['add', 'remote.txt']);
        await git(secondClone, ['commit', '-m', 'remote advance']);
        await git(secondClone, ['push', 'origin', 'feature']);

        await writeFile(path.join(firstClone, 'local.txt'), 'local change\n');
        await git(firstClone, ['add', 'local.txt']);
        await git(firstClone, ['commit', '-m', 'local follow-up']);
        const originalLocalCommit = await git(firstClone, ['rev-parse', 'HEAD']);

        let tokenUses = 0;
        const result = await pushBranch(firstClone, 'feature', { rebaseOnNonFastForward: true, repoUrl: remotePath,
            tokenRefreshFn: async () => `fresh-${++tokenUses}` });
        assert.equal(tokenUses, 3, 'resolve credentials separately for push, fetch, and post-rebase push');
        const finalLocalCommit = await git(firstClone, ['rev-parse', 'HEAD']);
        const finalRemoteCommit = await git(firstClone, ['ls-remote', 'origin', 'refs/heads/feature']);
        const remoteLog = await git(firstClone, ['log', '--format=%s', 'origin/feature', '-3']);

        assert.strictEqual(result.rebased, true);
        assert.strictEqual(result.commitHash, finalLocalCommit);
        assert.notStrictEqual(finalLocalCommit, originalLocalCommit);
        assert.ok(finalRemoteCommit.startsWith(finalLocalCommit));
        assert.match(remoteLog, /local follow-up/);
        assert.match(remoteLog, /remote advance/);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('parallel-safe worktree creation and push do not require shared config writes', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'propr-worktree-config-lock-'));
    try {
        const remotePath = path.join(tempDir, 'remote.git');
        const clonePath = path.join(tempDir, 'clone');
        const worktreePath = path.join(tempDir, 'worktree');

        await git(tempDir, ['init', '--bare', remotePath]);
        await git(tempDir, ['clone', remotePath, clonePath]);
        await configureUser(clonePath);
        await writeFile(path.join(clonePath, 'README.md'), 'base\n');
        await git(clonePath, ['add', 'README.md']);
        await git(clonePath, ['commit', '-m', 'base']);
        await git(clonePath, ['branch', '-M', 'main']);
        await git(clonePath, ['push', '-u', 'origin', 'main']);

        // Simulate another worktree briefly owning the shared config lock.
        // --no-track must allow creation to proceed without touching it.
        const configLockPath = path.join(clonePath, '.git', 'config.lock');
        await writeFile(configLockPath, 'held by parallel task\n');
        await addWorktreeWithoutTracking(
            createHooklessGit(clonePath),
            worktreePath,
            'parallel-feature',
            { startPoint: 'origin/main' },
        );

        await writeFile(path.join(worktreePath, 'parallel.txt'), 'parallel\n');
        await git(worktreePath, ['add', 'parallel.txt']);
        await git(worktreePath, ['commit', '-m', 'parallel change']);

        // An explicit push must likewise avoid an upstream-config write.
        await pushBranch(worktreePath, 'parallel-feature');
        const remoteRef = await git(worktreePath, ['ls-remote', 'origin', 'refs/heads/parallel-feature']);
        assert.match(remoteRef, /^[0-9a-f]{40}\s+refs\/heads\/parallel-feature$/);

        await rm(configLockPath, { force: true });
        const upstream = await git(worktreePath, ['config', '--get', 'branch.parallel-feature.remote'])
            .catch(() => '');
        assert.strictEqual(upstream, '');
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
});

test('maintenance push uses an exact head lease and preserves a competing commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'propr-maintenance-cas-'));
    try {
        const remote = path.join(root, 'remote.git'), local = path.join(root, 'local');
        await git(root, ['init', '--bare', remote]);
        await git(root, ['clone', remote, local]); await configureUser(local);
        await git(local, ['checkout', '-b', 'feature']);
        await writeFile(path.join(local, 'file'), 'admitted\n'); await git(local, ['add', '.']); await git(local, ['commit', '-m', 'admitted']);
        const admitted = await git(local, ['rev-parse', 'HEAD']);
        await git(local, ['push', 'origin', 'feature']);
        await writeFile(path.join(local, 'file'), 'merged\n'); await git(local, ['commit', '-am', 'merge']);
        const merged = await git(local, ['rev-parse', 'HEAD']);
        await pushBranch(local, 'feature', { expectedHeadSha: admitted });
        assert.equal(await git(remote, ['rev-parse', 'feature']), merged);
        // Even a fast-forward candidate may not publish against a different admitted remote head.
        await writeFile(path.join(local, 'file'), 'later\n'); await git(local, ['commit', '-am', 'later']);
        await assert.rejects(() => pushBranch(local, 'feature', { expectedHeadSha: admitted }));
        assert.equal(await git(remote, ['rev-parse', 'feature']), merged);
        // A lease is not permission to rewrite the admitted history.
        await git(local, ['reset', '--hard', admitted]);
        await assert.rejects(() => pushBranch(local, 'feature', { expectedHeadSha: merged }));
        assert.equal(await git(remote, ['rev-parse', 'feature']), merged);
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const robust of [false, true]) test(`${robust ? 'ensureBranchAndPush' : 'pushBranch'} resolves credentials before its first push`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'propr-fresh-token-'));
    try {
        const origin = path.join(root, 'origin.git');
        const clone = path.join(root, 'clone');
        await git(root, ['init', '--bare', origin]);
        await git(root, ['clone', origin, clone]);
        await configureUser(clone);
        await writeFile(path.join(clone, 'file.txt'), 'agent output');
        await git(clone, ['add', '.']);
        await git(clone, ['commit', '-m', 'agent output']);
        await git(clone, ['branch', '-M', 'feature']);
        await git(clone, ['config', `url.${origin}.insteadOf`, 'https://x-access-token:fresh@token-test.invalid/repo.git']);
        await git(clone, ['config', `url.${origin}-missing.insteadOf`, 'https://x-access-token:expired@token-test.invalid/repo.git']);
        await git(clone, ['remote', 'set-url', 'origin', 'https://x-access-token:expired@token-test.invalid/repo.git']);
        let calls = 0;
        const options = { repoUrl: 'https://token-test.invalid/repo.git', authToken: 'expired',
            tokenRefreshFn: async () => { calls++; return 'fresh'; } };
        if (robust) await ensureBranchAndPush(clone, 'feature', 'main', options);
        else await pushBranch(clone, 'feature', options);
        assert.equal(await git(origin, ['rev-parse', 'refs/heads/feature']), await git(clone, ['rev-parse', 'HEAD']));
        assert.ok(calls >= 1);
        assert.equal(await git(clone, ['config', '--get', 'remote.origin.url']), 'https://x-access-token:fresh@token-test.invalid/repo.git');
    } finally { await rm(root, { recursive: true, force: true }); }
});

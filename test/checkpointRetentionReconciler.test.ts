import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { preserveExecutionCheckpoint, resolveRepositoryGitDir, executionCheckpointPinRef } from '@propr/core';
import type { ExecutionCheckpointRecord } from '@propr/core';
import { reconcileRetainedCheckpoints, type CheckpointRetentionPolicy } from '../src/jobs/checkpointRetentionReconciler.js';
import { listRetainedCheckpoints, saveRetainedCheckpoint } from '../src/jobs/checkpointRetentionStore.js';

// End-to-end against real git repositories: a stopped admitted execution whose checkpoint
// push fails is retained, and the recurring reconciler must eventually publish it or, at a
// bounded expiry, remove the worktree only after the content is held by a local ref.

const HOUR_MS = 60 * 60 * 1000;
const RETAINED_AT = Date.parse('2026-09-19T00:00:00.000Z');
const AUTHOR = { name: 'ProPR AI', email: 'ai@propr.dev' };
const UNREACHABLE_REMOTE = '/nonexistent/propr-checkpoint-remote.git';
const POLICY: CheckpointRetentionPolicy = { maxRetainedWorktrees: 10, maxWorktreeAgeMs: HOUR_MS, publishGiveUpMs: 100 * HOUR_MS, maxEntriesPerPass: 25 };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'propr-retention-reconciler-'));
    const origin = join(root, 'origin.git');
    await simpleGit().raw(['init', '--bare', '--initial-branch=stage', origin]);
    const clone = join(root, 'clone');
    await simpleGit().clone(origin, clone);
    const git = simpleGit(clone);
    await git.addConfig('user.name', 'Retention regression');
    await git.addConfig('user.email', 'retention-test@example.invalid');
    await writeFile(join(clone, 'allowed.txt'), 'base\n');
    await git.add(['allowed.txt']);
    await git.commit('test: base');
    await git.push('origin', 'stage');
    const baseSha = (await git.revparse(['HEAD'])).trim();
    // Every later push from this repository fails until a reconciler pass supplies a good URL.
    await git.remote(['set-url', 'origin', UNREACHABLE_REMOTE]);
    const worktreesBase = join(root, 'worktrees');
    await mkdir(worktreesBase);
    return { root, origin, clone, git, baseSha, worktreesBase, storeDir: join(root, 'store') };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function stoppedAttempt(fx: Fixture, taskId: string, retainedAt = RETAINED_AT) {
    const featureBranch = `task/${taskId}`;
    const worktree = join(fx.worktreesBase, taskId);
    await fx.git.raw(['worktree', 'add', '--no-track', '-b', featureBranch, worktree, fx.baseSha]);
    await writeFile(join(worktree, 'allowed.txt'), `partial progress for ${taskId}\n`);
    const record = await preserveExecutionCheckpoint({ worktreePath: worktree, taskId, failureClassification: 'max_turns', author: AUTHOR,
        execution: { baseSha: fx.baseSha, featureBranch, targetBranch: 'stage', allowedPaths: ['allowed.txt'] } as never });
    assert.equal(record.status, 'failed');
    await saveRetainedCheckpoint({ taskId, worktreePath: worktree, branchName: featureBranch, gitDir: await resolveRepositoryGitDir(worktree),
        retainedAt: new Date(retainedAt).toISOString(), publishAttempts: 0 }, fx.storeDir);
    return { worktree, record: record as ExecutionCheckpointRecord & { ref: string; sha: string } };
}

function durableTaskRecords(records: Record<string, { worktree: string; record: ExecutionCheckpointRecord }>) {
    const metadata = new Map(Object.entries(records).map(([taskId, attempt]) =>
        [taskId, { executionCheckpoint: attempt.record, retainedWorktreePath: attempt.worktree } as Record<string, unknown>]));
    return {
        metadata,
        stateManager: {
            getTaskState: async (taskId: string) => metadata.has(taskId)
                ? { taskId, issueRef: { number: 1, repoOwner: 'o', repoName: 'r' }, history: [{ state: 'failed', metadata: metadata.get(taskId) }] }
                : null,
            updateHistoryMetadata: async (taskId: string, _state: string, patch: Record<string, unknown>) => {
                metadata.set(taskId, { ...metadata.get(taskId), ...patch });
                return {};
            },
        } as never,
    };
}

async function exists(filePath: string): Promise<boolean> {
    return access(filePath).then(() => true, () => false);
}

async function commitSurvivesGc(fx: Fixture, sha: string): Promise<void> {
    await fx.git.raw(['reflog', 'expire', '--expire=now', '--all']);
    await fx.git.raw(['gc', '--prune=now', '--quiet']);
    assert.equal((await fx.git.raw(['cat-file', '-t', sha])).trim(), 'commit');
}

test('repeated failed pushes keep the pinned commit and worktree, and a later pass publishes and cleans up', async () => {
    const fx = await fixture();
    const attempt = await stoppedAttempt(fx, 'task-1');
    assert.equal(attempt.record.localRef, executionCheckpointPinRef(attempt.record.ref));
    const durable = durableTaskRecords({ 'task-1': attempt });
    let remoteUrl = UNREACHABLE_REMOTE;
    const deps = { stateManager: durable.stateManager, storeDir: fx.storeDir, worktreesBasePath: fx.worktreesBase, policy: POLICY,
        logger: silent, getAuthToken: async () => 'token', repoUrlFor: () => remoteUrl };

    for (let pass = 1; pass <= 3; pass++) {
        const summary = await reconcileRetainedCheckpoints({ ...deps, now: () => RETAINED_AT + pass });
        assert.equal(summary.pending, 1);
        assert.equal(await exists(attempt.worktree), true);
        assert.equal((await listRetainedCheckpoints(fx.storeDir)).entries[0].publishAttempts, pass);
    }
    // The only copy is referenced by the local pin: garbage collection cannot drop it.
    assert.equal((await fx.git.raw(['rev-parse', attempt.record.localRef!])).trim(), attempt.record.sha);
    await commitSurvivesGc(fx, attempt.record.sha);

    remoteUrl = fx.origin;
    const summary = await reconcileRetainedCheckpoints({ ...deps, now: () => RETAINED_AT + HOUR_MS / 2 });
    assert.equal(summary.published, 1);
    assert.equal((await simpleGit(fx.origin).raw(['rev-parse', attempt.record.ref])).trim(), attempt.record.sha);
    const recorded = durable.metadata.get('task-1')!;
    assert.deepEqual({ ...(recorded.executionCheckpoint as object), changedPaths: [], outOfScopePaths: [] },
        { status: 'preserved', failureClassification: 'max_turns', publication: 'none', baseSha: fx.baseSha,
            featureBranch: 'task/task-1', ref: attempt.record.ref, sha: attempt.record.sha, changedPaths: [], outOfScopePaths: [] });
    assert.equal(recorded.retainedWorktreePath, null);
    assert.equal(await exists(attempt.worktree), false);
    assert.equal((await fx.git.raw(['for-each-ref', attempt.record.localRef!])).trim(), '');
    assert.deepEqual((await listRetainedCheckpoints(fx.storeDir)).entries, []);
});

test('the age bound removes the worktree only after pinning the commit, and publication is still retried', async () => {
    const fx = await fixture();
    const attempt = await stoppedAttempt(fx, 'task-2');
    const durable = durableTaskRecords({ 'task-2': attempt });
    let remoteUrl = UNREACHABLE_REMOTE;
    const deps = { stateManager: durable.stateManager, storeDir: fx.storeDir, worktreesBasePath: fx.worktreesBase, policy: POLICY,
        logger: silent, getAuthToken: async () => 'token', repoUrlFor: () => remoteUrl, now: () => RETAINED_AT + 2 * HOUR_MS };

    assert.equal((await reconcileRetainedCheckpoints(deps)).expired, 1);
    assert.equal(await exists(attempt.worktree), false);
    await commitSurvivesGc(fx, attempt.record.sha);
    assert.equal((durable.metadata.get('task-2')!.checkpointRetention as { status: string }).status, 'worktree_expired');
    assert.ok((await listRetainedCheckpoints(fx.storeDir)).entries[0].worktreeRemovedAt);

    remoteUrl = fx.origin;
    assert.equal((await reconcileRetainedCheckpoints(deps)).published, 1);
    assert.equal((await simpleGit(fx.origin).raw(['rev-parse', attempt.record.ref])).trim(), attempt.record.sha);
    assert.deepEqual((await listRetainedCheckpoints(fx.storeDir)).entries, []);
});

test('the count bound expires the oldest retained worktrees first', async () => {
    const fx = await fixture();
    const older = await stoppedAttempt(fx, 'task-old', RETAINED_AT);
    const newer = await stoppedAttempt(fx, 'task-new', RETAINED_AT + 1);
    const durable = durableTaskRecords({ 'task-old': older, 'task-new': newer });
    const summary = await reconcileRetainedCheckpoints({ stateManager: durable.stateManager, storeDir: fx.storeDir,
        worktreesBasePath: fx.worktreesBase, policy: { ...POLICY, maxRetainedWorktrees: 1 }, logger: silent,
        getAuthToken: async () => 'token', repoUrlFor: () => UNREACHABLE_REMOTE, now: () => RETAINED_AT + 2 });
    assert.deepEqual({ expired: summary.expired, pending: summary.pending }, { expired: 1, pending: 1 });
    assert.equal(await exists(older.worktree), false);
    assert.equal(await exists(newer.worktree), true);
    await commitSurvivesGc(fx, older.record.sha);
});

test('without a recorded checkpoint commit, expiry snapshots the whole worktree to a local ref before removal', async () => {
    const fx = await fixture();
    const attempt = await stoppedAttempt(fx, 'task-3');
    await writeFile(join(attempt.worktree, 'stray.log'), 'uncommitted evidence\n');
    // No durable task record is readable: nothing authoritative to publish.
    const summary = await reconcileRetainedCheckpoints({ stateManager: durableTaskRecords({}).stateManager, storeDir: fx.storeDir,
        worktreesBasePath: fx.worktreesBase, policy: POLICY, logger: silent, now: () => RETAINED_AT + 2 * HOUR_MS });
    assert.equal(summary.expired, 1);
    assert.equal(await exists(attempt.worktree), false);
    const [snapshotRef] = (await fx.git.raw(['for-each-ref', '--format=%(refname)', 'refs/propr/retained-worktrees/'])).trim().split('\n');
    assert.match(snapshotRef, /^refs\/propr\/retained-worktrees\/task-3\/[0-9a-f]{40}$/);
    assert.equal(await fx.git.raw(['show', `${snapshotRef}:stray.log`]), 'uncommitted evidence\n');
    assert.equal(await fx.git.raw(['show', `${snapshotRef}:allowed.txt`]), 'partial progress for task-3\n');
    assert.deepEqual((await listRetainedCheckpoints(fx.storeDir)).entries, []);
    assert.equal(await readFile(join(fx.clone, 'allowed.txt'), 'utf8'), 'base\n');
});

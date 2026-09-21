import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { closeConnection, preserveExecutionCheckpoint, restoreExecutionCheckpoint, requireStoryExecutionContract } from '../src/index.js';

after(async () => { await closeConnection(); });

const AUTHOR = { name: 'ProPR AI', email: 'ai@propr.dev' };
const DIGEST = `sha256:${'a'.repeat(64)}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'propr-checkpoint-'));
  const origin = join(root, 'origin.git');
  await simpleGit().raw(['init', '--bare', '--initial-branch=stage', origin]);
  const clone = join(root, 'clone');
  await simpleGit().clone(origin, clone);
  const git = simpleGit(clone);
  await git.addConfig('user.name', 'Checkpoint regression');
  await git.addConfig('user.email', 'checkpoint-test@example.invalid');
  await writeFile(join(clone, 'allowed.txt'), 'base\n');
  await writeFile(join(clone, 'removed.txt'), 'remove me\n');
  await git.add(['allowed.txt', 'removed.txt']);
  await git.commit('test: base');
  await git.push('origin', 'stage');
  const baseSha = (await git.revparse(['HEAD'])).trim();
  const execution = { baseSha, featureBranch: 'task/story-attempt-1', targetBranch: 'stage',
    allowedPaths: ['allowed.txt', 'created.txt', 'removed.txt'] };
  const worktree = join(root, 'attempt-1');
  await git.raw(['worktree', 'add', '--no-track', '-b', execution.featureBranch, worktree, baseSha]);
  return { root, origin, clone, git, execution, worktree, baseSha };
}

test('preserves in-scope partial changes on a checkpoint ref without touching the feature branch or index', async () => {
  const { origin, git, execution, worktree, baseSha } = await fixture();
  await writeFile(join(worktree, 'allowed.txt'), 'partial progress\n');
  await writeFile(join(worktree, 'created.txt'), 'new untracked work\n');
  await writeFile(join(worktree, 'stray.log'), 'out of scope\n');
  const statusBefore = await simpleGit(worktree).raw(['status', '--porcelain']);

  const record = await preserveExecutionCheckpoint({ worktreePath: worktree, execution, taskId: 'owner-repo-7-task',
    failureClassification: 'max_turns', author: AUTHOR });

  assert.equal(record.status, 'preserved', record.error);
  assert.equal(record.failureClassification, 'max_turns');
  assert.equal(record.publication, 'none');
  assert.equal(record.ref, 'refs/propr/checkpoints/task/story-attempt-1/owner-repo-7-task');
  assert.deepEqual(record.changedPaths, ['allowed.txt', 'created.txt', 'stray.log']);
  assert.deepEqual(record.outOfScopePaths, ['stray.log']);
  const remote = simpleGit(origin);
  assert.equal((await remote.raw(['rev-parse', record.ref!])).trim(), record.sha);
  assert.equal((await remote.raw(['rev-parse', `${record.sha}^1`])).trim(), baseSha);
  assert.deepEqual((await remote.raw(['diff-tree', '-r', '--name-only', baseSha, record.sha!])).trim().split('\n'),
    ['allowed.txt', 'created.txt']);
  assert.match(await remote.raw(['log', '-1', '--format=%B', record.sha!]), /NOT FOR PUBLICATION[\s\S]*ProPR-Checkpoint-Failure: max_turns/);
  // Never a publication branch: no feature branch on the remote, local branch still at base.
  assert.equal((await remote.raw(['branch', '--list', execution.featureBranch])).trim(), '');
  assert.equal((await git.revparse([execution.featureBranch])).trim(), baseSha);
  assert.equal(await simpleGit(worktree).raw(['status', '--porcelain']), statusBefore);
});

test('never publishes an out-of-scope file: the pushed checkpoint tree holds only allowed paths', async () => {
  const { origin, execution, worktree, baseSha } = await fixture();
  const secret = 'GITHUB_TOKEN=ghp_checkpointregressionsecret0000000000\n';
  await writeFile(join(worktree, 'allowed.txt'), 'partial progress\n');
  await mkdir(join(worktree, 'config'), { recursive: true });
  await writeFile(join(worktree, 'config', 'credentials.env'), secret);
  await writeFile(join(worktree, 'removed.txt'), 'out-of-scope edit of an allowed-looking neighbour\n');
  const scoped = { ...execution, allowedPaths: ['allowed.txt', 'created.txt'] };

  const record = await preserveExecutionCheckpoint({ worktreePath: worktree, execution: scoped, taskId: 'task-secret',
    failureClassification: 'max_turns', author: AUTHOR });

  assert.equal(record.status, 'preserved', record.error);
  assert.deepEqual(record.changedPaths, ['allowed.txt', 'config/credentials.env', 'removed.txt']);
  assert.deepEqual(record.outOfScopePaths, ['config/credentials.env', 'removed.txt']);
  assert.doesNotMatch(JSON.stringify(record), /ghp_checkpointregressionsecret/);
  const remote = simpleGit(origin);
  assert.deepEqual((await remote.raw(['diff-tree', '-r', '--name-only', '--no-renames', baseSha, record.sha!])).trim().split('\n'),
    ['allowed.txt']);
  const pushedTree = (await remote.raw(['ls-tree', '-r', '--name-only', record.sha!])).trim().split('\n');
  assert.ok(!pushedTree.includes('config/credentials.env'));
  assert.equal((await remote.raw(['show', `${record.sha}:removed.txt`])), 'remove me\n');
  // The secret's blob was never hashed locally, so it cannot have reached the remote object store.
  const secretBlob = (await simpleGit(worktree).raw(['hash-object', '--', 'config/credentials.env'])).trim();
  await assert.rejects(remote.raw(['cat-file', '-t', secretBlob]));
  await assert.rejects(simpleGit(worktree).raw(['cat-file', '-t', secretBlob]));
  assert.match(await remote.raw(['log', '-1', '--format=%B', record.sha!]), /ProPR-Checkpoint-Paths: 1/);
});

test('only out-of-scope changes preserve nothing and push nothing, but still name the paths', async () => {
  const { origin, execution, worktree } = await fixture();
  await writeFile(join(worktree, 'stray.log'), 'out of scope\n');
  const record = await preserveExecutionCheckpoint({ worktreePath: worktree, execution, taskId: 'task-stray',
    failureClassification: 'timeout', author: AUTHOR });
  assert.equal(record.status, 'no_changes');
  assert.equal(record.ref, undefined);
  assert.deepEqual(record.outOfScopePaths, ['stray.log']);
  assert.equal((await simpleGit(origin).raw(['for-each-ref', 'refs/propr'])).trim(), '');
});

test('records an explicit no-change result and pushes nothing', async () => {
  const { origin, execution, worktree } = await fixture();
  const record = await preserveExecutionCheckpoint({ worktreePath: worktree, execution, taskId: 'task-empty',
    failureClassification: 'timeout', author: AUTHOR });
  assert.equal(record.status, 'no_changes');
  assert.equal(record.ref, undefined);
  assert.deepEqual(record.changedPaths, []);
  assert.equal((await simpleGit(origin).raw(['for-each-ref', 'refs/propr'])).trim(), '');
});

test('records a failed push truthfully instead of throwing away the classification', async () => {
  const { execution, worktree } = await fixture();
  await writeFile(join(worktree, 'allowed.txt'), 'partial\n');
  const record = await preserveExecutionCheckpoint({ worktreePath: worktree, execution, taskId: 'task-offline',
    failureClassification: 'agent_error', author: AUTHOR, remote: 'missing-remote' });
  assert.equal(record.status, 'failed');
  assert.equal(record.failureClassification, 'agent_error');
  assert.match(record.sha ?? '', /^[a-f0-9]{40}$/);
  assert.ok(record.error);
});

test('a later attempt starts from the exact checkpoint in-scope work, uncommitted on the admitted base', async () => {
  const { git, execution, worktree, root, baseSha } = await fixture();
  await writeFile(join(worktree, 'allowed.txt'), 'partial progress\n');
  await writeFile(join(worktree, 'created.txt'), 'new work\n');
  await writeFile(join(worktree, 'stray.log'), 'out of scope\n');
  await simpleGit(worktree).raw(['rm', '-q', 'removed.txt']);
  const record = await preserveExecutionCheckpoint({ worktreePath: worktree, execution, taskId: 'task-1',
    failureClassification: 'timeout', author: AUTHOR });
  assert.equal(record.status, 'preserved', record.error);

  const next = requireStoryExecutionContract({ ...execution, featureBranch: 'task/story-attempt-2',
    recovery: { sourceTaskId: 'task-1', evidenceDigest: DIGEST, action: 'continue', checkpointText: '',
      instructions: 'Continue from the checkpoint.', checkpoint: { ref: record.ref, sha: record.sha } } });
  const worktree2 = join(root, 'attempt-2');
  await git.raw(['worktree', 'add', '--no-track', '-b', next.featureBranch, worktree2, baseSha]);
  const restored = await restoreExecutionCheckpoint(worktree2, next);

  assert.deepEqual(restored, { ref: record.ref, sha: record.sha,
    restoredPaths: ['allowed.txt', 'created.txt', 'removed.txt'], ignoredPaths: [] });
  assert.equal(await readFile(join(worktree2, 'allowed.txt'), 'utf8'), 'partial progress\n');
  assert.equal(await readFile(join(worktree2, 'created.txt'), 'utf8'), 'new work\n');
  await assert.rejects(access(join(worktree2, 'removed.txt')));
  await assert.rejects(access(join(worktree2, 'stray.log')));
  assert.equal((await simpleGit(worktree2).revparse(['HEAD'])).trim(), baseSha);
});

test('refuses a checkpoint whose ref no longer names the admitted SHA', async () => {
  const { git, execution, worktree, root, baseSha } = await fixture();
  await writeFile(join(worktree, 'allowed.txt'), 'partial\n');
  const record = await preserveExecutionCheckpoint({ worktreePath: worktree, execution, taskId: 'task-1',
    failureClassification: 'timeout', author: AUTHOR });
  const next = requireStoryExecutionContract({ ...execution, featureBranch: 'task/story-attempt-2',
    recovery: { sourceTaskId: 'task-1', evidenceDigest: DIGEST, action: 'continue', checkpointText: '',
      instructions: 'Continue.', checkpoint: { ref: record.ref, sha: 'f'.repeat(40) } } });
  const worktree2 = join(root, 'attempt-2');
  await git.raw(['worktree', 'add', '--no-track', '-b', next.featureBranch, worktree2, baseSha]);
  await assert.rejects(restoreExecutionCheckpoint(worktree2, next), /STORY_EXECUTION_CHECKPOINT_CHANGED/);
});

test('the optional recovery checkpoint is exact and backward compatible', () => {
  const base = { baseSha: 'e'.repeat(40), featureBranch: 'task/a', targetBranch: 'stage', allowedPaths: ['a.ts'] };
  const recovery = { sourceTaskId: 't', evidenceDigest: DIGEST, action: 'continue', checkpointText: '', instructions: 'Go.' };
  assert.deepEqual(requireStoryExecutionContract({ ...base, recovery }).recovery, recovery);
  const checkpoint = { ref: 'refs/propr/checkpoints/task/a/t', sha: 'b'.repeat(40) };
  assert.deepEqual(requireStoryExecutionContract({ ...base, recovery: { ...recovery, checkpoint } }).recovery?.checkpoint, checkpoint);
  for (const invalid of [
    { ...checkpoint, ref: 'refs/heads/task/a' },
    { ...checkpoint, ref: 'refs/propr/checkpoints/../heads/x' },
    { ...checkpoint, sha: 'main' },
    { ...checkpoint, extra: true },
  ]) assert.throws(() => requireStoryExecutionContract({ ...base, recovery: { ...recovery, checkpoint: invalid } }),
    /EXECUTION_RECOVERY_CONTEXT_INVALID/);
});

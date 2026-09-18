import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { addWorktreeWithoutTracking } from '../src/git/worktreeCreation.js';
import { closeConnection, commitChanges, pushBranch, verifyStoryPublication } from '../src/index.js';
after(async () => { await closeConnection(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'propr-story-binding-'));
  const git = simpleGit(root);
  await git.raw(['init', '--initial-branch=stage']);
  await git.addConfig('user.name', 'Authority regression');
  await git.addConfig('user.email', 'authority-test@example.invalid');
  await writeFile(join(root, 'base.txt'), 'base\n');
  await git.add(['base.txt']); await git.commit('test: base');
  const baseSha = (await git.revparse(['HEAD'])).trim();
  return { root, git, execution: { baseSha, featureBranch: 'task/approved',
    targetBranch: 'stage', allowedPaths: ['allowed.txt'] } };
}
test('refuses a branch different from the exact admitted story before creating it', async () => {
  const { root, git, execution } = await fixture();
  await assert.rejects(addWorktreeWithoutTracking(git, join(root, 'candidate'), 'task/unapproved',
    { startPoint: execution.baseSha, execution } as any), /STORY_EXECUTION_BRANCH_CHANGED/);
  assert.equal((await git.branch()).all.includes('task/unapproved'), false);
});
test('refuses a mutable or different base instead of the exact admitted commit', async () => {
  const { root, git, execution } = await fixture();
  await assert.rejects(addWorktreeWithoutTracking(git, join(root, 'candidate'), execution.featureBranch,
    { startPoint: 'stage', execution } as any), /STORY_EXECUTION_BASE_CHANGED/);
  assert.equal((await git.branch()).all.includes(execution.featureBranch), false);
});
test('refuses a changed file outside the exact signed scope before committing it', async () => {
  const { root, git, execution } = await fixture();
  await git.checkout(['-b', execution.featureBranch]);
  await writeFile(join(root, 'outside.txt'), 'unapproved\n');
  await assert.rejects(commitChanges(root, 'test: unapproved', null, { execution } as any), /STORY_EXECUTION_SCOPE_CHANGED/);
  assert.equal((await git.revparse(['HEAD'])).trim(), execution.baseSha);
});
test('never runs untrusted repository hooks in the credential-bearing publication worker', async () => {
  const { root, git, execution } = await fixture();
  await git.checkout(['-b', execution.featureBranch]);
  await writeFile(join(root, 'allowed.txt'), 'approved\n');
  await writeFile(join(root, '.git/hooks/pre-commit'), '#!/bin/sh\ntouch hook-executed\nexit 1\n', { mode: 0o755 });
  const result = await commitChanges(root, 'test: sandbox-validated approved result', null, { execution });
  assert.ok(result?.commitHash);
  await assert.rejects(access(join(root, 'hook-executed')));
});
test('refuses staged out-of-scope content masked by a restored working file', async () => {
  const { root, git, execution } = await fixture();
  await git.checkout(['-b', execution.featureBranch]);
  await writeFile(join(root, 'base.txt'), 'unapproved\n');
  await git.add('base.txt');
  await writeFile(join(root, 'base.txt'), 'base\n');
  await assert.rejects(verifyStoryPublication(root, execution), /STORY_EXECUTION_SCOPE_CHANGED/);
});
test('refuses committed out-of-scope content masked by a restored working file', async () => {
  const { root, git, execution } = await fixture();
  await git.checkout(['-b', execution.featureBranch]);
  await writeFile(join(root, 'base.txt'), 'unapproved\n');
  await git.add('base.txt'); await git.commit('test: outside scope');
  await writeFile(join(root, 'base.txt'), 'base\n');
  await assert.rejects(verifyStoryPublication(root, execution), /STORY_EXECUTION_SCOPE_CHANGED/);
});
test('creates the exact branch at the immutable base and commits only approved files', async () => {
  const { root, git, execution } = await fixture();
  const candidate = join(root, 'candidate');
  await addWorktreeWithoutTracking(git, candidate, execution.featureBranch, { startPoint: execution.baseSha, execution });
  assert.equal((await simpleGit(candidate).revparse(['HEAD'])).trim(), execution.baseSha);
  await writeFile(join(candidate, 'allowed.txt'), 'approved\n');
  const result = await commitChanges(candidate, 'test: approved', null, { execution });
  assert.ok(result?.commitHash);
  assert.deepEqual(await verifyStoryPublication(candidate, execution), ['allowed.txt']);
  assert.equal((await git.revparse(['stage'])).trim(), execution.baseSha);
});
test('publishes only the named branch and refuses changed remote authority without touching stage', async () => {
  const { root, git, execution } = await fixture();
  const remote = await mkdtemp(join(tmpdir(), 'propr-story-remote-'));
  await simpleGit(remote).init(true);
  await git.addRemote('origin', remote);
  await git.push(['origin', 'stage']);
  await git.checkout(['-b', execution.featureBranch]);
  await pushBranch(root, execution.featureBranch, { execution });
  await writeFile(join(root, 'allowed.txt'), 'approved\n');
  const result = await commitChanges(root, 'test: approved', null, { execution });
  await pushBranch(root, execution.featureBranch, { execution });
  assert.equal((await simpleGit(remote).revparse([execution.featureBranch])).trim(), result?.commitHash);
  await assert.rejects(pushBranch(root, 'stage', { execution }), /STORY_EXECUTION_BRANCH_CHANGED/);
  await assert.rejects(pushBranch(root, execution.featureBranch, { execution }), /STORY_EXECUTION_REMOTE_CHANGED/);
  assert.equal((await simpleGit(remote).revparse(['stage'])).trim(), execution.baseSha);
});

/**
 * Local retention of partial-work checkpoints whose push failed.
 *
 * `commit-tree` produces an unreferenced commit: until it is pushed, nothing but the
 * worktree that produced it points at it, and `git gc` may prune it. Every checkpoint
 * commit is therefore pinned by a local ref (`refs/propr/local-checkpoints/...`, shared
 * by every worktree of the repository) before its push is attempted. The pin is removed
 * only after the exact SHA is verified on the remote checkpoint ref, so the only copy of
 * the partial work is never unreferenced — not by a failed push, not by worktree removal.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EXECUTION_CHECKPOINT_REF_PREFIX, requireExecutionCheckpointRef } from '../admission/executionRecoveryContext.js';
import { createHooklessGit, DISABLED_GIT_HOOKS_PATH } from './hooklessGit.js';
import { setupAuthenticatedRemote } from './repoBranching.js';

const runFile = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_REMOTE = 'origin';

/** Local-only pin namespace for checkpoint commits not yet verified on the remote. */
export const LOCAL_CHECKPOINT_PIN_PREFIX = 'refs/propr/local-checkpoints/';
/**
 * Local-only namespace for a whole-worktree snapshot taken when a retained worktree
 * expires without any checkpoint commit. Never pushed: it may hold out-of-scope paths.
 */
export const LOCAL_WORKTREE_SNAPSHOT_PREFIX = 'refs/propr/retained-worktrees/';

export type CheckpointGitEnvironment = Record<string, string | undefined>;

/** Runs git with repository hooks disabled. `cwd` may be a worktree or a repository git dir. */
export async function runCheckpointGit(cwd: string, args: string[], env?: CheckpointGitEnvironment): Promise<string> {
    const { stdout } = await runFile('git', ['-c', `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, ...args], {
        cwd, env: env ?? process.env, maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stdout;
}

/** The local pin ref for a remote checkpoint ref. */
export function executionCheckpointPinRef(checkpointRef: string): string {
    const ref = requireExecutionCheckpointRef(checkpointRef);
    return `${LOCAL_CHECKPOINT_PIN_PREFIX}${ref.slice(EXECUTION_CHECKPOINT_REF_PREFIX.length)}`;
}

/** The repository's shared git directory, absolute, resolved from any of its worktrees. */
export async function resolveRepositoryGitDir(worktreePath: string): Promise<string> {
    return (await runCheckpointGit(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
}

/**
 * Pins `sha` at the local pin for `checkpointRef`. Throws when the commit object is
 * absent or the pin already names a different commit: a pin is never moved.
 */
export async function pinExecutionCheckpoint(repoPath: string, checkpointRef: string, sha: string): Promise<string> {
    const pin = executionCheckpointPinRef(checkpointRef);
    await runCheckpointGit(repoPath, ['cat-file', '-e', `${sha}^{commit}`]);
    const existing = await readLocalRef(repoPath, pin);
    if (existing === sha) return pin;
    if (existing) throw Error('EXECUTION_CHECKPOINT_PIN_CONFLICT');
    await runCheckpointGit(repoPath, ['update-ref', pin, sha, '']);
    return pin;
}

export async function readLocalRef(repoPath: string, ref: string): Promise<string | undefined> {
    try {
        return (await runCheckpointGit(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || undefined;
    } catch {
        return undefined;
    }
}

export interface PublishPinnedCheckpointOptions {
    repoPath: string;
    ref: string;
    sha: string;
    remote?: string;
    repoUrl?: string;
    authToken?: string;
}

/**
 * Pushes an exact checkpoint commit to its checkpoint ref (never forced), verifies the
 * remote now names that SHA, and only then releases the local pin. Throws on any failure
 * with the pin left in place.
 */
export async function publishPinnedExecutionCheckpoint(options: PublishPinnedCheckpointOptions): Promise<void> {
    const remote = options.remote ?? DEFAULT_REMOTE;
    const ref = requireExecutionCheckpointRef(options.ref);
    const pin = await pinExecutionCheckpoint(options.repoPath, ref, options.sha);
    if (options.repoUrl && options.authToken)
        await setupAuthenticatedRemote(createHooklessGit(options.repoPath), options.repoUrl, options.authToken);
    await runCheckpointGit(options.repoPath, ['push', remote, `${options.sha}:${ref}`]);
    const remoteSha = (await runCheckpointGit(options.repoPath, ['ls-remote', remote, ref])).trim().split(/\s+/)[0];
    if (remoteSha !== options.sha) throw Error('EXECUTION_CHECKPOINT_REMOTE_MISMATCH');
    // Published and verified: the remote ref now holds the only copy that must survive.
    await runCheckpointGit(options.repoPath, ['update-ref', '-d', pin, options.sha]).catch(() => undefined);
}

/**
 * Commits the entire current worktree state (tracked and untracked non-ignored, in or
 * out of scope) on top of HEAD with a private index, and pins it locally. Used only to
 * keep a recoverable copy before an expired retained worktree with no checkpoint commit
 * is removed. The snapshot is local-only and is never pushed.
 */
export async function snapshotWorktreeToLocalRef(worktreePath: string, taskSegment: string,
    author: { name: string; email: string }): Promise<{ ref: string; sha: string }> {
    const indexDirectory = await mkdtemp(join(tmpdir(), 'propr-retained-snapshot-'));
    try {
        const env: CheckpointGitEnvironment = {
            ...process.env, GIT_INDEX_FILE: join(indexDirectory, 'index'),
            GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
        };
        await runCheckpointGit(worktreePath, ['read-tree', 'HEAD'], env);
        await runCheckpointGit(worktreePath, ['add', '-A', '--', '.'], env);
        const tree = (await runCheckpointGit(worktreePath, ['write-tree'], env)).trim();
        const sha = (await runCheckpointGit(worktreePath, ['commit-tree', '--no-gpg-sign', tree, '-p', 'HEAD',
            '-m', 'chore(checkpoint): local-only snapshot of an expired retained worktree (never publish)'], env)).trim();
        // One ref per snapshot commit: an earlier snapshot is never overwritten.
        const ref = `${LOCAL_WORKTREE_SNAPSHOT_PREFIX}${taskSegment}/${sha}`;
        await runCheckpointGit(worktreePath, ['update-ref', ref, sha, '']);
        return { ref, sha };
    } finally {
        await rm(indexDirectory, { recursive: true, force: true });
    }
}

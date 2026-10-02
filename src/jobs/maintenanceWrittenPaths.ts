/**
 * What an Ezer maintenance agent itself changed: a snapshot of the worktree right after Git's
 * merge (conflict markers included) is taken before the agent runs, and every path that differs
 * from it afterwards, staged or not, tracked or new, is the agent's. Inherited base and PR changes,
 * including ones Git merged cleanly into the same file, are in the snapshot and never counted; a
 * reverted or restored file is counted.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The full worktree as a tree object, written through a private COPY of the real index: every path
 * the real index tracks (ignored-but-tracked and force-added ones included) is captured, unmerged
 * entries are resolved only in the copy, and the real index is untouched.
 */
export function snapshotWorktree(cwd: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'propr-snapshot-'));
    try {
        const privateIndex = join(dir, 'index');
        const realIndex = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd, encoding: 'utf8' }).trim();
        if (existsSync(realIndex)) copyFileSync(realIndex, privateIndex);
        const env = { ...process.env, GIT_INDEX_FILE: privateIndex };
        const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env });
        git(['add', '-A', '--', '.']);
        return git(['write-tree']).trim();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

/** Paths whose content differs between the pre-agent snapshot and the worktree now. */
export function changedSinceSnapshot(cwd: string, snapshot: string): string[] {
    const now = snapshotWorktree(cwd);
    return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', snapshot, now], { cwd, encoding: 'utf8' })
        .split('\0')
        .filter(Boolean);
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exactSha, milestoneCorrectionCommitMessage, type MilestoneCorrectionRequest } from '@propr/core';
import { publishSignedMaintenanceCommit } from './signedMaintenancePublication.js';
import { snapshotWorktree, changedSinceSnapshot } from './maintenanceWrittenPaths.js';
import { isWithinMergeScope } from './mergeScope.js';
const MAX_BUFFER = 100 * 1024 * 1024;
const PREFIX = 'milestone-correction-';
export interface MilestoneCorrectionPorts {
    repositoryPath: string;
    api: Parameters<typeof publishSignedMaintenanceCommit>[0]['octokit'];
    fence(): Promise<void>;
    correct(worktreePath: string, request: MilestoneCorrectionRequest): Promise<void>;
}
/** Real Git execution; only authority, agent execution, and GitHub are external ports. */
export async function executeMilestoneCorrection(
    p: MilestoneCorrectionRequest,
    ports: MilestoneCorrectionPorts,
): Promise<string> {
    if (!p.instructions.trim()) throw Error('milestone-correction-missing-instructions');
    await ports.fence();
    const scratch = mkdtempSync(join(tmpdir(), PREFIX));
    const privateRepository = join(scratch, 'repository');
    const dir = join(scratch, 'worktree');
    const git = (args: string[], cwd = dir) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
    const [owner, repo] = p.repository.split('/');
    try {
        mkdirSync(privateRepository);
        git(['init', '--quiet'], privateRepository);
        git(['fetch', '--quiet', '--no-tags', '--', ports.repositoryPath, exactSha(p.fromHead)], privateRepository);
        git(['worktree', 'add', '--quiet', '--detach', '--', dir, exactSha(p.fromHead)], privateRepository);
        const snapshot = snapshotWorktree(dir);
        await ports.fence();
        await ports.correct(dir, p);
        const verify = async () => {
            await ports.fence();
            if (git(['rev-parse', 'HEAD']).trim() !== p.fromHead)
                throw Error('milestone-correction-local-head-changed');
            const changed = changedSinceSnapshot(dir, snapshot);
            if (changed.some(path => !isWithinMergeScope(path, p.scope)))
                throw Error('milestone-correction-scope-changed');
            if (!changed.length) throw Error('milestone-correction-no-change');
            git(['add', '-A', '--', '.']);
            git(['diff', '--cached', '--check']);
        };
        await verify();
        return await publishSignedMaintenanceCommit({
            kind: 'correction', octokit: ports.api, owner, repo, worktreePath: dir,
            branch: p.branch, headSha: p.fromHead,
            commitMessage: milestoneCorrectionCommitMessage(p.requestId), beforePublish: verify,
        });
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

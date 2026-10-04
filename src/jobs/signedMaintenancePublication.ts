import { exactSha } from '@propr/core';
import { execFileSync } from 'node:child_process';
import { snapshotWorktree } from './maintenanceWrittenPaths.js';
import { createVerifiedGitCommit, record, sha, type Api } from './signedGitPublication.js';

/** Publish Git's resolved snapshot, including inherited base changes and agent edits. */
export async function publishSignedMaintenanceCommit(input: {
    octokit: Api;
    owner: string;
    repo: string;
    worktreePath: string;
    branch: string;
    headSha: string;
    commitMessage: string;
    beforePublish: () => Promise<void>;
} & ({ kind: 'correction' } | { kind?: 'maintenance'; baseSha: string; mergedBaseSha: string })): Promise<string> {
    const { octokit, owner, repo, worktreePath, branch, headSha } = input;
    const git = (args: string[]) => execFileSync('git', args, { cwd: worktreePath, maxBuffer: 100 * 1024 * 1024 });
    // The second parent is the base commit the worker actually merged, never the older admitted base
    // (GitHub would then show every later base change as part of the pull request). It must still
    // contain the admitted base.
    const baseSha = input.kind === 'correction' ? undefined : input.mergedBaseSha;
    if (input.kind !== 'correction') try {
        git(['merge-base', '--is-ancestor', '--', exactSha(input.baseSha), exactSha(input.mergedBaseSha)]);
    } catch {
        throw new Error('maintenance-base-moved');
    }
    const localHead = git(['rev-parse', 'HEAD']).toString().trim();
    const treeSha = snapshotWorktree(worktreePath);
    const readHead = async () => {
        const ref = record((await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
            owner, repo, ref: `heads/${branch}`, headers: { 'cache-control': 'no-store' },
        })).data);
        return sha(record(ref.object).sha);
    };
    if (await readHead() !== headSha) throw new Error('maintenance-head-changed');
    if (treeSha === git(['cat-file', '-p', '--', exactSha(headSha)]).toString().split('\n')[0].slice('tree '.length)) {
        if (input.kind === 'correction') throw new Error('milestone-correction-no-change');
        let baseAlreadyMerged = false;
        try { git(['merge-base', '--is-ancestor', '--', exactSha(baseSha!), exactSha(headSha)]); baseAlreadyMerged = true; } catch { /* Merge still required. */ }
        if (baseAlreadyMerged) {
            await input.beforePublish();
            if (snapshotWorktree(worktreePath) !== treeSha || git(['rev-parse', 'HEAD']).toString().trim() !== localHead) {
                throw new Error('maintenance-worktree-changed');
            }
            if (await readHead() !== headSha) throw new Error('maintenance-head-changed');
            return headSha;
        }
    }
    // A full tree avoids treating inherited base changes as agent-authored changes.
    // Read immutable Git blobs, not UTF-8 file strings, preserving binary data and symlinks.
    const tree = [];
    // Blobs reachable from either admitted parent already exist on GitHub.
    const uploaded = new Set((baseSha ? [headSha, baseSha] : [headSha]).flatMap(parent =>
        git(['ls-tree', '-rz', '--', exactSha(parent)]).toString().split('\0').filter(Boolean)
            .map(entry => entry.slice(0, entry.indexOf('\t')).split(' ')[2])));
    for (const entry of git(['ls-tree', '-rz', treeSha]).toString().split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const [mode, type, blobSha] = entry.slice(0, tab).split(' ');
        const path = entry.slice(tab + 1);
        if (type === 'blob' && !uploaded.has(blobSha)) {
            const blob = record((await octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
                owner, repo, content: git(['cat-file', 'blob', blobSha]).toString('base64'), encoding: 'base64',
            })).data);
            if (blob.sha !== blobSha) throw new Error('maintenance-blob-mismatch');
            uploaded.add(blobSha);
        }
        tree.push({ path, mode, type, sha: blobSha });
    }
    const createdTree = record((await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner, repo, tree,
    })).data);
    if (createdTree.sha !== treeSha) throw new Error('maintenance-tree-mismatch');
    const commit = await createVerifiedGitCommit({
        octokit, owner, repo, parents: baseSha ? [sha(headSha), sha(baseSha)] : [sha(headSha)], treeSha, message: input.commitMessage,
    });
    const repository = record((await octokit.request('GET /repos/{owner}/{repo}', { owner, repo })).data);
    if (typeof repository.node_id !== 'string' || !repository.node_id) throw new Error('maintenance-repository-invalid');
    await input.beforePublish();
    if (git(['rev-parse', 'HEAD']).toString().trim() !== localHead || snapshotWorktree(worktreePath) !== treeSha) {
        throw new Error('maintenance-worktree-changed');
    }
    if (await readHead() !== headSha) throw new Error('maintenance-head-changed');
    // REST updateRef has no expected-head field. GraphQL updateRefs checks beforeOid
    // atomically, including a move to the second parent between the read and update.
    const response = record((await octokit.request('POST /graphql', {
        query: 'mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }',
        variables: { input: { repositoryId: repository.node_id, refUpdates: [{
            name: `refs/heads/${branch}`, beforeOid: headSha, afterOid: commit, force: false,
        }] } },
    })).data);
    if (response.errors || !record(response.data).updateRefs) throw new Error('maintenance-ref-update-failed');
    // The atomic update acknowledgement is the publication boundary. Do not insert
    // fallible readbacks here: the worker must now persist the acknowledged commit.
    return commit;
}

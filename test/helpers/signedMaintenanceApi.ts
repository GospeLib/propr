import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const SIGNED_MERGE_SHA = 'd'.repeat(40);
export function signedMaintenanceApi(cwd: string, head: string, options: {
    onCreate?: () => Promise<void>;
    onUpdate?: () => void;
    raceAtUpdate?: string;
    unverified?: boolean;
    wrongParents?: boolean;
} = {}) {
    let ref = head;
    let commit: Record<string, unknown>;
    const calls: Array<{ endpoint: string; options: Record<string, any> }> = [];
    const blobs = new Map<string, Buffer>();
    const git = (args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    const request = async (endpoint: string, input: Record<string, any>) => {
        calls.push({ endpoint, options: input });
        if (endpoint.includes('/git/ref/')) return { data: { object: { type: 'commit', sha: ref } } };
        if (endpoint.endsWith('/git/blobs')) {
            const bytes = Buffer.from(input.content, 'base64');
            const sha = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
            blobs.set(sha, bytes);
            return { data: { sha } };
        }
        if (endpoint.endsWith('/git/trees')) {
            // Materialize the submitted API tree independently; its SHA must match the worktree snapshot.
            const index = `${cwd}/.git/api-index`;
            const env = { ...process.env, GIT_INDEX_FILE: index };
            execFileSync('git', ['read-tree', '--empty'], { cwd, env });
            for (const entry of input.tree) {
                execFileSync('git', ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.sha},${entry.path}`], { cwd, env });
            }
            const sha = execFileSync('git', ['write-tree'], { cwd, env, encoding: 'utf8' }).trim();
            return { data: { sha } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/git/commits') {
            assert.equal('author' in input, false);
            assert.equal('committer' in input, false);
            commit = { sha: SIGNED_MERGE_SHA, message: input.message, tree: { sha: input.tree },
                parents: (options.wrongParents ? [head] : input.parents).map((sha: string) => ({ sha })),
                verification: { verified: !options.unverified, reason: 'valid', signature: 'signature', payload: 'payload' } };
            await options.onCreate?.();
            return { data: commit };
        }
        if (endpoint.includes('/git/commits/')) return { data: commit };
        if (endpoint === 'GET /repos/{owner}/{repo}') return { data: { node_id: 'repo-id' } };
        if (endpoint === 'POST /graphql') {
            const update = input.variables.input.refUpdates[0];
            assert.equal(update.force, false);
            if (options.raceAtUpdate) ref = options.raceAtUpdate;
            if (update.beforeOid !== ref) return { data: { errors: [{ message: 'reference moved' }] } };
            ref = update.afterOid;
            options.onUpdate?.();
            return { data: { data: { updateRefs: { clientMutationId: null } } } };
        }
        throw new Error(`Unexpected API: ${endpoint}`);
    };
    return { request, calls, blobs, moveRef: (sha: string) => { ref = sha; }, ref: () => ref, git };
}

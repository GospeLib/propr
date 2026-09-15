import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import type { StoryExecutionContract } from '@propr/core';
import { simpleGit, type SimpleGit } from 'simple-git';
import { publicationMetadataDigest, requireAuthorizedPublicationMetadata } from '../packages/core/src/admission/authorizedPublicationMetadata.js';

const FEATURE_BRANCH = 'task/signed-publication';
const TASK_ID = 'EP-signed-publication-S01-T02';
const CHANGED_PATH = 'src/change.ts';
const CHANGED_CONTENT = 'export const recovered = true;\n';
const BASE_TREE_SHA = 'b'.repeat(40);
const CREATED_TREE_SHA = 'c'.repeat(40);
const COMMIT_SHA = 'd'.repeat(40);
const RACING_REF_SHA = 'e'.repeat(40);
const README_BLOB_SHA = 'f'.repeat(40);
const VERIFIED_SIGNATURE = {
    verified: true,
    reason: 'valid',
    signature: '-----BEGIN PGP SIGNATURE-----\ntest\n-----END PGP SIGNATURE-----',
    payload: 'tree signed payload',
};
const COMMIT_MESSAGE = `fix(ai): Implement ${TASK_ID}\n\nTask: ${TASK_ID}`;

const verifyStoryPublication = mock.fn(async (worktree: string, execution: StoryExecutionContract) => {
    const git = simpleGit(worktree);
    if ((await git.revparse(['--abbrev-ref', 'HEAD'])).trim() !== execution.featureBranch) {
        throw new Error('STORY_EXECUTION_BRANCH_CHANGED');
    }
    const changedPaths = (await git.status()).files.map(file => file.path).sort();
    if (changedPaths.some(path => !execution.allowedPaths.includes(path))) {
        throw new Error('STORY_EXECUTION_SCOPE_CHANGED');
    }
    return changedPaths;
});

await mock.module('@propr/core', { namedExports: {
    requireAuthorizedPublicationMetadata,
    verifyStoryPublication,
    requireStoryPublicationId: (storyId: string) => storyId,
    storyPublicationSpecLinkPath: (taskId: string) => `specs/${taskId}/link.md`,
    storyPublicationTaskLinkRequired: () => true,
    STORY_PUBLICATION_TASK_ID_PATTERN: /-T[0-9]+$/,
    STORY_PUBLICATION_TASK_SUFFIX_PATTERN: /-T[0-9]+$/,
    STORY_PUBLICATION_SPEC_DIRECTORY_PREFIX: 'specs/',
} });
const { publishSignedStoryCommit } = await import('../src/jobs/signedStoryPublication.js');

interface GitTreeEntry {
    path: string;
    mode: string;
    type: string;
    sha: string;
}

interface Fixture {
    directory: string;
    git: SimpleGit;
    baseSha: string;
    execution: StoryExecutionContract;
}

interface ApiOptions {
    priorRef?: string;
    commitMessage?: string;
    blobSha?: string;
    createdTreeSha?: string;
    createdTreeEntries?: GitTreeEntry[];
    treeTruncated?: boolean;
    createdCommitTreeSha?: string;
    fetchedCommitTreeSha?: string;
    createdCommitParentSha?: string;
    fetchedCommitParentSha?: string;
    fetchedCommitSha?: string;
    createdVerification?: typeof VERIFIED_SIGNATURE;
    fetchedVerification?: typeof VERIFIED_SIGNATURE;
    beforeUpdate?: (fixture: Fixture) => Promise<void>;
    raceBeforeUpdate?: boolean;
    readbackSha?: string;
}

function gitBlobSha(content: Buffer): string {
    const header = Buffer.from(`blob ${content.byteLength}\0`);
    return createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

function artifact(path: string, content: string) {
    return { path, content, digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
}

async function createFixture(): Promise<Fixture> {
    const directory = await mkdtemp(join(tmpdir(), 'propr-signed-publication-'));
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'Test Author');
    await git.addConfig('user.email', 'test@example.test');
    await writeFile(join(directory, 'README.md'), 'base\n');
    await git.add('README.md');
    await git.commit('chore: establish exact base');
    const baseSha = (await git.revparse(['HEAD'])).trim();
    await git.checkoutLocalBranch(FEATURE_BRANCH);
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(join(directory, CHANGED_PATH), CHANGED_CONTENT);
    const taskRoot = 'specs/EP-signed-publication-S01';
    const execution: StoryExecutionContract = {
        baseSha,
        featureBranch: FEATURE_BRANCH,
        targetBranch: 'stage',
        allowedPaths: [CHANGED_PATH],
        taskAssignment: {
            taskId: TASK_ID,
            artifacts: [
                artifact(`${taskRoot}/tasks.md`, `# Tasks\n\n- ${TASK_ID}\n`),
                artifact(`${taskRoot}/link.md`, '# Task link\n'),
            ],
        },
    };
    return { directory, git, baseSha, execution };
}

function commitData(baseSha: string, treeSha: string, verification = VERIFIED_SIGNATURE, commitSha = COMMIT_SHA, message = COMMIT_MESSAGE) {
    return {
        sha: commitSha,
        message,
        tree: { sha: treeSha },
        parents: [{ sha: baseSha }],
        verification,
        commit: { message, tree: { sha: treeSha }, verification },
    };
}

function createApi(fixture: Fixture, options: ApiOptions = {}) {
    const calls: Array<{ endpoint: string; request: Record<string, unknown> }> = [];
    const changedBlobSha = gitBlobSha(Buffer.from(CHANGED_CONTENT));
    const baseTree: GitTreeEntry[] = [
        { path: 'README.md', mode: '100644', type: 'blob', sha: README_BLOB_SHA },
    ];
    const createdTree = options.createdTreeEntries ?? [
        ...baseTree,
        { path: CHANGED_PATH, mode: '100644', type: 'blob', sha: changedBlobSha },
    ];
    let refSha = options.priorRef ?? fixture.baseSha;
    let refReads = 0;
    let beforeUpdateRan = false;
    const request = async (endpoint: string, requestOptions: Record<string, unknown>) => {
        calls.push({ endpoint, request: requestOptions });
        if (endpoint === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
            refReads += 1;
            if (options.raceBeforeUpdate && refReads === 2) return { data: { object: { type: 'commit', sha: RACING_REF_SHA } } };
            if (refReads >= 3 && options.readbackSha) return { data: { object: { type: 'commit', sha: options.readbackSha } } };
            return { data: { object: { type: 'commit', sha: refSha } } };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}') {
            const requestedSha = requestOptions.commit_sha;
            if (requestedSha === fixture.baseSha) return { data: { sha: fixture.baseSha, tree: { sha: BASE_TREE_SHA } } };
            return { data: commitData(
                options.fetchedCommitParentSha ?? fixture.baseSha,
                options.fetchedCommitTreeSha ?? CREATED_TREE_SHA,
                options.fetchedVerification,
                options.fetchedCommitSha,
                options.commitMessage,
            ) };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/commits/{ref}') {
            return { data: commitData(
                options.fetchedCommitParentSha ?? fixture.baseSha,
                options.fetchedCommitTreeSha ?? CREATED_TREE_SHA,
                options.fetchedVerification,
                options.fetchedCommitSha,
                options.commitMessage,
            ) };
        }
        if (endpoint === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
            const entries = requestOptions.tree_sha === BASE_TREE_SHA ? baseTree : createdTree;
            return { data: { sha: requestOptions.tree_sha, truncated: options.treeTruncated ?? false, tree: entries } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/git/blobs') {
            return { data: { sha: options.blobSha ?? changedBlobSha } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/git/trees') {
            return { data: { sha: options.createdTreeSha ?? CREATED_TREE_SHA, truncated: false, tree: createdTree } };
        }
        if (endpoint === 'POST /repos/{owner}/{repo}/git/commits') {
            if (!beforeUpdateRan && options.beforeUpdate) {
                beforeUpdateRan = true;
                await options.beforeUpdate(fixture);
            }
            return { data: commitData(
                options.createdCommitParentSha ?? fixture.baseSha,
                options.createdCommitTreeSha ?? CREATED_TREE_SHA,
                options.createdVerification,
                COMMIT_SHA,
                options.commitMessage,
            ) };
        }
        if (endpoint === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}') {
            assert.equal(requestOptions.force, false, 'existing refs must only receive a non-force update');
            refSha = String(requestOptions.sha);
            return { data: { object: { type: 'commit', sha: refSha } } };
        }
        throw new Error(`UNEXPECTED_API_CALL:${endpoint}`);
    };
    return { octokit: { request }, calls };
}

async function runPublication(options: ApiOptions = {}, commitMessage = COMMIT_MESSAGE) {
    const fixture = await createFixture();
    const api = createApi(fixture, options);
    try {
        const result = await publishSignedStoryCommit({
            octokit: api.octokit,
            owner: 'example',
            repo: 'code',
            worktreePath: fixture.directory,
            execution: fixture.execution,
            commitMessage,
        });
        return { result, calls: api.calls, fixture };
    } catch (error) {
        await rm(fixture.directory, { recursive: true, force: true });
        throw error;
    }
}

test('resumes an exact verified published ref without creating objects or changing remote history', async () => {
    const { result, calls, fixture } = await runPublication({ priorRef: COMMIT_SHA });
    try {
        assert.equal(result?.commitHash, COMMIT_SHA);
        assert.equal(calls.some(call => !call.endpoint.startsWith('GET ')), false);
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test('rejects a resumed ref with different bytes, parent, message, signature, or a racing ref', async () => {
    for (const options of [
        { createdTreeEntries: [] },
        { fetchedCommitParentSha: RACING_REF_SHA },
        { commitMessage: 'unauthorized' },
        { fetchedVerification: { ...VERIFIED_SIGNATURE, verified: false } },
        { raceBeforeUpdate: true },
    ]) await assert.rejects(runPublication({ priorRef: COMMIT_SHA, ...options }));
});

test('publishes the exact authorized bytes with a verified GitHub commit and non-force ref update', async () => {
    const { result, calls, fixture } = await runPublication();
    try {
        assert.deepEqual(result, { commitHash: COMMIT_SHA, commitMessage: COMMIT_MESSAGE, filesChanged: [CHANGED_PATH] });
        const createCommit = calls.find(call => call.endpoint === 'POST /repos/{owner}/{repo}/git/commits');
        assert.deepEqual(createCommit?.request.parents, [fixture.baseSha]);
        assert.equal(createCommit?.request.tree, CREATED_TREE_SHA);
        assert.equal('author' in (createCommit?.request ?? {}), false, 'GitHub must supply the authenticated author');
        assert.equal('committer' in (createCommit?.request ?? {}), false, 'GitHub must supply the authenticated committer');
        assert.equal((await fixture.git.revparse(['HEAD'])).trim(), fixture.baseSha, 'publication must not create a local unsigned commit');
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('refuses caller-controlled commit prose that omits exact conventional task metadata', async () => {
    await assert.rejects(() => runPublication({}, 'Implementation complete'), /STORY_SIGNED_PUBLICATION_COMMIT_MESSAGE/);
});

test('publishes exact authorized metadata and refuses substituted caller text before GitHub writes', async () => {
    const fixture = await createFixture();
    const task = fixture.execution.taskAssignment!;
    const metadata = {
        commitMessage: `docs(ezer): publish replacement fixture\n\nTask: ${TASK_ID}\n`,
        prTitle: 'docs(ezer): publish replacement fixture',
        prBody: `## Summary\n\nReplacement.\n\n## Story / task\n\n- Story / task: \`${TASK_ID}\`\n- Spec: \`specs/EP-signed-publication-S01/\`\n\n## Impact & Risk\n\n- **Domains / repos touched:** docs\n- **Contract surface touched:** no\n- **Risk level:** low\n- **Rollback plan:** close PR\n\n## Testing\n\nRun checks.\n\n## Checklist\n\n- [ ] Checks pass\n`,
    };
    fixture.execution.publicationMetadata = { ...metadata, digest: publicationMetadataDigest(task, metadata) };
    const api = createApi(fixture, { commitMessage: metadata.commitMessage });
    try {
        await assert.rejects(publishSignedStoryCommit({ octokit: api.octokit, owner: 'example', repo: 'code',
            worktreePath: fixture.directory, execution: fixture.execution, commitMessage: COMMIT_MESSAGE }), /STORY_SIGNED_PUBLICATION_COMMIT_MESSAGE/);
        assert.equal(api.calls.length, 0);
        const result = await publishSignedStoryCommit({ octokit: api.octokit, owner: 'example', repo: 'code',
            worktreePath: fixture.directory, execution: fixture.execution, commitMessage: metadata.commitMessage });
        assert.equal(result?.commitMessage, metadata.commitMessage);
        assert.equal(api.calls.find(call => call.endpoint === 'POST /repos/{owner}/{repo}/git/commits')?.request.message, metadata.commitMessage);
        for (const edit of [
            { prTitle: 'Unconventional prose' }, { commitMessage: metadata.commitMessage.replace(TASK_ID, 'EP-other-S01-T01') },
            { prBody: metadata.prBody.replace('## Testing', '## Omitted') },
            { prBody: metadata.prBody.replace(TASK_ID, 'EP-other-S01-T01') },
        ]) {
            const changed = { ...metadata, ...edit };
            assert.throws(() => requireAuthorizedPublicationMetadata({ ...changed,
                digest: publicationMetadataDigest(task, changed) }, task), /STORY_PUBLICATION_METADATA/);
        }
        assert.throws(() => requireAuthorizedPublicationMetadata({ ...fixture.execution.publicationMetadata, extra: true }, task), /STORY_PUBLICATION_METADATA/);
        const changedTask = { ...task, artifacts: task.artifacts.map(a => artifact(a.path, a.content + '\n')) };
        assert.throws(() => requireAuthorizedPublicationMetadata(fixture.execution.publicationMetadata, changedTask), /STORY_PUBLICATION_METADATA_DIGEST/);
    } finally {
        await rm(fixture.directory, { recursive: true, force: true });
    }
});

test('refuses a blob response that does not identify the exact authorized bytes', async () => {
    await assert.rejects(() => runPublication({ blobSha: '1'.repeat(40) }), /STORY_SIGNED_PUBLICATION_BLOB_MISMATCH/);
});

test('refuses a created tree containing an unauthorized path', async () => {
    await assert.rejects(() => runPublication({
        createdTreeEntries: [
            { path: 'README.md', mode: '100644', type: 'blob', sha: README_BLOB_SHA },
            { path: CHANGED_PATH, mode: '100644', type: 'blob', sha: gitBlobSha(Buffer.from(CHANGED_CONTENT)) },
            { path: 'src/unauthorized.ts', mode: '100644', type: 'blob', sha: '2'.repeat(40) },
        ],
    }), /STORY_SIGNED_PUBLICATION_TREE_MISMATCH/);
});

test('refuses a no-op tree response when the verified worktree has changes', async () => {
    await assert.rejects(() => runPublication({ createdTreeSha: BASE_TREE_SHA }), /STORY_SIGNED_PUBLICATION_TREE_MISMATCH/);
});

test('refuses a commit creation response bound to the wrong tree', async () => {
    await assert.rejects(() => runPublication({ createdCommitTreeSha: '3'.repeat(40) }), /STORY_SIGNED_PUBLICATION_COMMIT_MISMATCH/);
});

test('refuses a fetched commit bound to the wrong tree', async () => {
    await assert.rejects(() => runPublication({ fetchedCommitTreeSha: '4'.repeat(40) }), /STORY_SIGNED_PUBLICATION_COMMIT_MISMATCH/);
});

test('refuses a commit creation response bound to the wrong parent', async () => {
    await assert.rejects(() => runPublication({ createdCommitParentSha: '5'.repeat(40) }), /STORY_SIGNED_PUBLICATION_COMMIT_MISMATCH/);
});

test('refuses a fetched commit whose identity disagrees with the created commit', async () => {
    await assert.rejects(() => runPublication({ fetchedCommitSha: '6'.repeat(40) }), /STORY_SIGNED_PUBLICATION_COMMIT_MISMATCH/);
});

test('refuses a truncated tree readback because exact path coverage is unavailable', async () => {
    await assert.rejects(() => runPublication({ treeTruncated: true }), /STORY_SIGNED_PUBLICATION_TREE_MISMATCH/);
});

test('refuses when the GitHub commit creation response is not itself verified', async () => {
    await assert.rejects(() => runPublication({
        createdVerification: { ...VERIFIED_SIGNATURE, verified: false, reason: 'unsigned' },
    }), /STORY_SIGNED_PUBLICATION_UNVERIFIED/);
});

test('refuses a verified flag without signature and payload evidence', async () => {
    await assert.rejects(() => runPublication({
        fetchedVerification: { ...VERIFIED_SIGNATURE, signature: '', payload: '' },
    }), /STORY_SIGNED_PUBLICATION_UNVERIFIED/);
});

test('refuses publication if the local head changes during GitHub object creation', async () => {
    await assert.rejects(() => runPublication({
        beforeUpdate: async ({ git }) => { await git.commit('chore: concurrent local head', { '--allow-empty': null }); },
    }), /STORY_SIGNED_PUBLICATION_LOCAL_HISTORY_CHANGED/);
});

test('refuses publication if authorized worktree bytes change during GitHub object creation', async () => {
    await assert.rejects(() => runPublication({
        beforeUpdate: async ({ directory }) => { await writeFile(join(directory, CHANGED_PATH), 'mutated during publication\n'); },
    }), /STORY_SIGNED_PUBLICATION_WORKTREE_CHANGED/);
});

test('refuses a feature-ref race before attempting the update', async () => {
    await assert.rejects(() => runPublication({ raceBeforeUpdate: true }), /STORY_SIGNED_PUBLICATION_REF_CHANGED/);
});

test('refuses a ref readback inconsistent with the created commit', async () => {
    await assert.rejects(() => runPublication({ readbackSha: RACING_REF_SHA }), /STORY_SIGNED_PUBLICATION_READBACK_CHANGED/);
});

/** Publish an exact bounded worktree snapshot through GitHub's verified commit path. */
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitResult, StoryExecutionContract } from '@propr/core';
import { verifyStoryPublication } from '@propr/core';
import { simpleGit, type SimpleGit } from 'simple-git';
import { buildStoryCommitMessage } from './publicationMetadata.js';

interface Api {
    request(endpoint: string, options: Record<string, unknown>): Promise<{ data: unknown }>;
}

interface PublicationSnapshot {
    path: string;
    mode: GitFileMode;
    content: Buffer | null;
    blobSha: string | null;
}

interface GitTreeEntry {
    path: string;
    mode: string;
    type: string;
    sha: string;
}

type GitFileMode = typeof REGULAR_FILE_MODE | typeof EXECUTABLE_FILE_MODE | typeof SYMBOLIC_LINK_MODE;

const GET_REF_ENDPOINT = 'GET /repos/{owner}/{repo}/git/ref/{ref}';
const GET_COMMIT_ENDPOINT = 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}';
const GET_TREE_ENDPOINT = 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}';
const CREATE_BLOB_ENDPOINT = 'POST /repos/{owner}/{repo}/git/blobs';
const CREATE_TREE_ENDPOINT = 'POST /repos/{owner}/{repo}/git/trees';
const CREATE_COMMIT_ENDPOINT = 'POST /repos/{owner}/{repo}/git/commits';
const CREATE_REF_ENDPOINT = 'POST /repos/{owner}/{repo}/git/refs';
const UPDATE_REF_ENDPOINT = 'PATCH /repos/{owner}/{repo}/git/refs/{ref}';
const HEADS_PREFIX = 'heads/';
const FULL_HEADS_PREFIX = 'refs/heads/';
const BASE64_ENCODING = 'base64';
const GIT_BLOB_TYPE = 'blob';
const GIT_COMMIT_TYPE = 'commit';
const GIT_TREE_TYPE = 'tree';
const REGULAR_FILE_MODE = '100644';
const EXECUTABLE_FILE_MODE = '100755';
const SYMBOLIC_LINK_MODE = '120000';
const EXECUTABLE_MASK = 0o111;
const NOT_FOUND_STATUS = 404;
const EXPECTED_PARENT_COUNT = 1;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GIT_OBJECT_HEADER_SEPARATOR = '\0';
const GIT_BLOB_HEADER = 'blob';
const GIT_SHA_ALGORITHM = 'sha1';
const VERIFIED_REASON = 'valid';
const RECURSIVE_TREE_VALUE = '1';

const ERROR_COMMIT_MESSAGE = 'STORY_SIGNED_PUBLICATION_COMMIT_MESSAGE';
const ERROR_LOCAL_HISTORY = 'STORY_SIGNED_PUBLICATION_LOCAL_HISTORY_CHANGED';
const ERROR_REMOTE_HISTORY = 'STORY_SIGNED_PUBLICATION_REMOTE_HISTORY_CHANGED';
const ERROR_BASE_CHANGED = 'STORY_SIGNED_PUBLICATION_BASE_CHANGED';
const ERROR_FILE_TYPE = 'STORY_SIGNED_PUBLICATION_FILE_TYPE';
const ERROR_BLOB_MISMATCH = 'STORY_SIGNED_PUBLICATION_BLOB_MISMATCH';
const ERROR_TREE_MISMATCH = 'STORY_SIGNED_PUBLICATION_TREE_MISMATCH';
const ERROR_COMMIT_MISMATCH = 'STORY_SIGNED_PUBLICATION_COMMIT_MISMATCH';
const ERROR_UNVERIFIED = 'STORY_SIGNED_PUBLICATION_UNVERIFIED';
const ERROR_WORKTREE_CHANGED = 'STORY_SIGNED_PUBLICATION_WORKTREE_CHANGED';
const ERROR_REF_CHANGED = 'STORY_SIGNED_PUBLICATION_REF_CHANGED';
const ERROR_READBACK_CHANGED = 'STORY_SIGNED_PUBLICATION_READBACK_CHANGED';
const ERROR_API_RESPONSE = 'STORY_SIGNED_PUBLICATION_API_RESPONSE_INVALID';

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ERROR_API_RESPONSE);
    return value as Record<string, unknown>;
}

function sha(value: unknown, errorCode = ERROR_API_RESPONSE): string {
    if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new Error(errorCode);
    return value;
}

function status(error: unknown): number | undefined {
    return error && typeof error === 'object' && 'status' in error
        ? Number((error as { status: unknown }).status)
        : undefined;
}

function gitBlobSha(content: Buffer): string {
    const header = Buffer.from(`${GIT_BLOB_HEADER} ${content.byteLength}${GIT_OBJECT_HEADER_SEPARATOR}`);
    return createHash(GIT_SHA_ALGORITHM).update(header).update(content).digest('hex');
}

async function assertLocalHead(git: SimpleGit, expectedHead: string): Promise<void> {
    if ((await git.revparse(['HEAD'])).trim() !== expectedHead) throw new Error(ERROR_LOCAL_HISTORY);
}

async function readSnapshot(worktreePath: string, path: string): Promise<PublicationSnapshot> {
    const absolutePath = join(worktreePath, path);
    try {
        const stat = await lstat(absolutePath);
        if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(ERROR_FILE_TYPE);
        const content = stat.isSymbolicLink()
            ? Buffer.from(await readlink(absolutePath))
            : await readFile(absolutePath);
        const mode = stat.isSymbolicLink()
            ? SYMBOLIC_LINK_MODE
            : stat.mode & EXECUTABLE_MASK ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE;
        return { path, mode, content, blobSha: gitBlobSha(content) };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { path, mode: REGULAR_FILE_MODE, content: null, blobSha: null };
        }
        throw error;
    }
}

function sameSnapshot(left: PublicationSnapshot, right: PublicationSnapshot): boolean {
    return left.path === right.path && left.mode === right.mode && left.blobSha === right.blobSha;
}

async function readRef(input: {
    octokit: Api;
    owner: string;
    repo: string;
    featureBranch: string;
}): Promise<string | undefined> {
    try {
        const response = await input.octokit.request(GET_REF_ENDPOINT, {
            owner: input.owner,
            repo: input.repo,
            ref: `${HEADS_PREFIX}${input.featureBranch}`,
        });
        const object = record(record(response.data).object);
        if (object.type !== GIT_COMMIT_TYPE) throw new Error(ERROR_API_RESPONSE);
        return sha(object.sha);
    } catch (error) {
        if (status(error) === NOT_FOUND_STATUS) return undefined;
        throw error;
    }
}

function treeEntry(value: unknown): GitTreeEntry | null {
    const entry = record(value);
    if (entry.type === GIT_TREE_TYPE) return null;
    if (typeof entry.path !== 'string' || typeof entry.mode !== 'string' ||
        (entry.type !== GIT_BLOB_TYPE && entry.type !== GIT_COMMIT_TYPE)) {
        throw new Error(ERROR_TREE_MISMATCH);
    }
    return { path: entry.path, mode: entry.mode, type: entry.type, sha: sha(entry.sha, ERROR_TREE_MISMATCH) };
}

async function fetchLeafTree(input: {
    octokit: Api;
    owner: string;
    repo: string;
    treeSha: string;
}): Promise<Map<string, GitTreeEntry>> {
    const response = record((await input.octokit.request(GET_TREE_ENDPOINT, {
        owner: input.owner,
        repo: input.repo,
        tree_sha: input.treeSha,
        recursive: RECURSIVE_TREE_VALUE,
    })).data);
    if (response.sha !== input.treeSha || response.truncated !== false || !Array.isArray(response.tree)) {
        throw new Error(ERROR_TREE_MISMATCH);
    }
    const entries = new Map<string, GitTreeEntry>();
    for (const value of response.tree) {
        const entry = treeEntry(value);
        if (!entry) continue;
        if (entries.has(entry.path)) throw new Error(ERROR_TREE_MISMATCH);
        entries.set(entry.path, entry);
    }
    return entries;
}

function sameTreeEntry(left: GitTreeEntry | undefined, right: GitTreeEntry | undefined): boolean {
    return left?.path === right?.path && left?.mode === right?.mode &&
        left?.type === right?.type && left?.sha === right?.sha;
}

function assertExactTreeDelta(
    baseTree: Map<string, GitTreeEntry>,
    createdTree: Map<string, GitTreeEntry>,
    snapshots: readonly PublicationSnapshot[],
): void {
    const expectedPaths = new Set(snapshots.map(snapshot => snapshot.path));
    const actualPaths = new Set([...baseTree.keys(), ...createdTree.keys()].filter(path =>
        !sameTreeEntry(baseTree.get(path), createdTree.get(path))));
    if (actualPaths.size !== expectedPaths.size || [...actualPaths].some(path => !expectedPaths.has(path))) {
        throw new Error(ERROR_TREE_MISMATCH);
    }
    for (const snapshot of snapshots) {
        const created = createdTree.get(snapshot.path);
        if (snapshot.blobSha === null) {
            if (created !== undefined || baseTree.get(snapshot.path) === undefined) throw new Error(ERROR_TREE_MISMATCH);
        } else if (!created || created.mode !== snapshot.mode || created.type !== GIT_BLOB_TYPE || created.sha !== snapshot.blobSha) {
            throw new Error(ERROR_TREE_MISMATCH);
        }
    }
}

function assertVerified(value: unknown): void {
    const verification = record(value);
    if (verification.verified !== true || verification.reason !== VERIFIED_REASON ||
        typeof verification.signature !== 'string' || verification.signature.trim().length === 0 ||
        typeof verification.payload !== 'string' || verification.payload.trim().length === 0) {
        throw new Error(ERROR_UNVERIFIED);
    }
}

function assertCommit(value: unknown, expected: {
    commitSha?: string;
    baseSha: string;
    treeSha: string;
    message: string;
}): string {
    const commit = record(value);
    const commitSha = sha(commit.sha, ERROR_COMMIT_MISMATCH);
    const treeSha = sha(record(commit.tree).sha, ERROR_COMMIT_MISMATCH);
    const parents = commit.parents;
    if ((expected.commitSha && commitSha !== expected.commitSha) || treeSha !== expected.treeSha ||
        commit.message !== expected.message || !Array.isArray(parents) || parents.length !== EXPECTED_PARENT_COUNT ||
        sha(record(parents[0]).sha, ERROR_COMMIT_MISMATCH) !== expected.baseSha) {
        throw new Error(ERROR_COMMIT_MISMATCH);
    }
    assertVerified(commit.verification);
    return commitSha;
}

async function assertStableWorktree(input: {
    git: SimpleGit;
    worktreePath: string;
    execution: StoryExecutionContract;
    paths: readonly string[];
    snapshots: readonly PublicationSnapshot[];
}): Promise<void> {
    await assertLocalHead(input.git, input.execution.baseSha);
    const finalPaths = await verifyStoryPublication(input.worktreePath, input.execution);
    if (finalPaths.length !== input.paths.length || finalPaths.some((path, index) => path !== input.paths[index])) {
        throw new Error(ERROR_WORKTREE_CHANGED);
    }
    const finalSnapshots = await Promise.all(input.paths.map(path => readSnapshot(input.worktreePath, path)));
    if (finalSnapshots.some((snapshot, index) => !sameSnapshot(snapshot, input.snapshots[index]))) {
        throw new Error(ERROR_WORKTREE_CHANGED);
    }
}

export async function publishSignedStoryCommit(options: {
    octokit: Api;
    owner: string;
    repo: string;
    worktreePath: string;
    execution: StoryExecutionContract;
    commitMessage: string;
}): Promise<CommitResult | null> {
    const { octokit, owner, repo, worktreePath, execution, commitMessage } = options;
    const taskId = execution.taskAssignment?.taskId;
    if (!taskId || commitMessage !== buildStoryCommitMessage(taskId, true, execution)) throw new Error(ERROR_COMMIT_MESSAGE);

    const git = simpleGit(worktreePath);
    const paths = await verifyStoryPublication(worktreePath, execution);
    if (paths.length === 0) return null;
    await assertLocalHead(git, execution.baseSha);

    const refInput = { octokit, owner, repo, featureBranch: execution.featureBranch };
    const priorRef = await readRef(refInput);
    if (priorRef !== undefined && priorRef !== execution.baseSha) throw new Error(ERROR_REMOTE_HISTORY);

    const baseCommit = record((await octokit.request(GET_COMMIT_ENDPOINT, {
        owner,
        repo,
        commit_sha: execution.baseSha,
    })).data);
    if (baseCommit.sha !== execution.baseSha) throw new Error(ERROR_BASE_CHANGED);
    const baseTreeSha = sha(record(baseCommit.tree).sha, ERROR_BASE_CHANGED);
    const snapshots = await Promise.all(paths.map(path => readSnapshot(worktreePath, path)));
    const tree = [];
    for (const snapshot of snapshots) {
        let blobSha: string | null = null;
        if (snapshot.content !== null && snapshot.blobSha !== null) {
            const blob = record((await octokit.request(CREATE_BLOB_ENDPOINT, {
                owner,
                repo,
                content: snapshot.content.toString(BASE64_ENCODING),
                encoding: BASE64_ENCODING,
            })).data);
            if (blob.sha !== snapshot.blobSha) throw new Error(ERROR_BLOB_MISMATCH);
            blobSha = snapshot.blobSha;
        }
        tree.push({ path: snapshot.path, mode: snapshot.mode, type: GIT_BLOB_TYPE, sha: blobSha });
    }

    const createdTreeResponse = record((await octokit.request(CREATE_TREE_ENDPOINT, {
        owner,
        repo,
        base_tree: baseTreeSha,
        tree,
    })).data);
    const createdTreeSha = sha(createdTreeResponse.sha, ERROR_TREE_MISMATCH);
    if (createdTreeSha === baseTreeSha) throw new Error(ERROR_TREE_MISMATCH);
    const [baseTree, createdTree] = await Promise.all([
        fetchLeafTree({ octokit, owner, repo, treeSha: baseTreeSha }),
        fetchLeafTree({ octokit, owner, repo, treeSha: createdTreeSha }),
    ]);
    assertExactTreeDelta(baseTree, createdTree, snapshots);

    const createdCommit = assertCommit((await octokit.request(CREATE_COMMIT_ENDPOINT, {
        owner,
        repo,
        message: commitMessage,
        tree: createdTreeSha,
        parents: [execution.baseSha],
    })).data, { baseSha: execution.baseSha, treeSha: createdTreeSha, message: commitMessage });
    const fetchedCommit = (await octokit.request(GET_COMMIT_ENDPOINT, {
        owner,
        repo,
        commit_sha: createdCommit,
    })).data;
    assertCommit(fetchedCommit, {
        commitSha: createdCommit,
        baseSha: execution.baseSha,
        treeSha: createdTreeSha,
        message: commitMessage,
    });

    await assertStableWorktree({ git, worktreePath, execution, paths, snapshots });
    if (await readRef(refInput) !== priorRef) throw new Error(ERROR_REF_CHANGED);

    const refResponse = priorRef === undefined
        ? await octokit.request(CREATE_REF_ENDPOINT, {
            owner,
            repo,
            ref: `${FULL_HEADS_PREFIX}${execution.featureBranch}`,
            sha: createdCommit,
        })
        : await octokit.request(UPDATE_REF_ENDPOINT, {
            owner,
            repo,
            ref: `${HEADS_PREFIX}${execution.featureBranch}`,
            sha: createdCommit,
            force: false,
        });
    const updatedRef = record(record(refResponse.data).object);
    if (updatedRef.type !== GIT_COMMIT_TYPE || sha(updatedRef.sha, ERROR_READBACK_CHANGED) !== createdCommit ||
        await readRef(refInput) !== createdCommit) {
        throw new Error(ERROR_READBACK_CHANGED);
    }
    return { commitHash: createdCommit, commitMessage, filesChanged: paths };
}

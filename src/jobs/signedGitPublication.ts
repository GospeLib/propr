export interface Api {
    request(endpoint: string, options: Record<string, unknown>): Promise<{ data: unknown }>;
}

const GET_COMMIT_ENDPOINT = 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}';
const CREATE_COMMIT_ENDPOINT = 'POST /repos/{owner}/{repo}/git/commits';
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const VERIFIED_REASON = 'valid';
const ERROR_COMMIT_MISMATCH = 'STORY_SIGNED_PUBLICATION_COMMIT_MISMATCH';
const ERROR_UNVERIFIED = 'STORY_SIGNED_PUBLICATION_UNVERIFIED';
const ERROR_API_RESPONSE = 'STORY_SIGNED_PUBLICATION_API_RESPONSE_INVALID';

export function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ERROR_API_RESPONSE);
    return value as Record<string, unknown>;
}

export function sha(value: unknown, errorCode = ERROR_API_RESPONSE): string {
    if (typeof value !== 'string' || !SHA_PATTERN.test(value)) throw new Error(errorCode);
    return value;
}

function assertVerified(value: unknown): void {
    const verification = record(value);
    if (verification.verified !== true || verification.reason !== VERIFIED_REASON ||
        typeof verification.signature !== 'string' || verification.signature.trim().length === 0 ||
        typeof verification.payload !== 'string' || verification.payload.trim().length === 0) {
        throw new Error(ERROR_UNVERIFIED);
    }
}

export function assertCommit(value: unknown, expected: {
    commitSha?: string;
    parents: readonly string[];
    treeSha: string;
    message: string;
}): string {
    const commit = record(value);
    const commitSha = sha(commit.sha, ERROR_COMMIT_MISMATCH);
    const treeSha = sha(record(commit.tree).sha, ERROR_COMMIT_MISMATCH);
    const parents = commit.parents;
    if ((expected.commitSha && commitSha !== expected.commitSha) || treeSha !== expected.treeSha ||
        commit.message !== expected.message || !Array.isArray(parents) || parents.length !== expected.parents.length ||
        parents.some((parent, index) => sha(record(parent).sha, ERROR_COMMIT_MISMATCH) !== expected.parents[index])) {
        throw new Error(ERROR_COMMIT_MISMATCH);
    }
    assertVerified(commit.verification);
    return commitSha;
}

/** Leave author and committer unset so GitHub signs as the authenticated App. */
export async function createVerifiedGitCommit(input: {
    octokit: Api;
    owner: string;
    repo: string;
    parents: readonly string[];
    treeSha: string;
    message: string;
}): Promise<string> {
    const { octokit, owner, repo, parents, treeSha, message } = input;
    const commitSha = assertCommit((await octokit.request(CREATE_COMMIT_ENDPOINT, {
        owner, repo, message, tree: treeSha, parents,
    })).data, input);
    assertCommit((await octokit.request(GET_COMMIT_ENDPOINT, {
        owner, repo, commit_sha: commitSha,
    })).data, { ...input, commitSha });
    return commitSha;
}

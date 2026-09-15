import type { PaginatedOctokitInstance } from '../auth/githubAuth.js';

const STORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const STORY_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-T[0-9]+$/;
export const STORY_TASK_SUFFIX_PATTERN = /-T[0-9]+$/;
const TASK_POLICY_DECLARATION = 'Task: <story>-<task>';
const SPEC_LINK_GATE_PATH = 'checks/spec-link.sh';
const PULL_REQUEST_TEMPLATE_PATHS = ['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md'] as const;
export const SPEC_DIRECTORY_PREFIX = 'specs/';
const SPEC_LINK_FILENAME = 'link.md';
const GITHUB_NOT_FOUND_STATUS = 404;
const REPOSITORY_PART_COUNT = 2;
const REPOSITORY_SEPARATOR = '/';
const GITHUB_FILE_TYPE = 'file';
const GITHUB_CONTENT_ENCODING = 'base64';

export interface StoryPublicationPolicyInput {
    changedPaths: readonly string[];
    signedStoryId: string | undefined;
    readFile: (path: string) => Promise<string | null>;
}

export function storyPublicationTaskLinkRequired(input: {
    specLinkGatePresent: boolean;
    pullRequestTemplate: string | null;
}): boolean {
    return input.specLinkGatePresent && input.pullRequestTemplate?.includes(TASK_POLICY_DECLARATION) === true;
}

export function requireStoryPublicationId(storyId: string, taskLinkRequired = false): string {
    if (!STORY_ID_PATTERN.test(storyId)) throw new Error('STORY_PUBLICATION_STORY_ID_INVALID');
    if (taskLinkRequired && !STORY_TASK_ID_PATTERN.test(storyId)) {
        throw new Error('STORY_PUBLICATION_TASK_ID_REQUIRED');
    }
    return storyId;
}

export function storyPublicationSpecLinkPath(taskId: string): string {
    const storyId = requireStoryPublicationId(taskId, true).replace(STORY_TASK_SUFFIX_PATTERN, '');
    return `${SPEC_DIRECTORY_PREFIX}${storyId}/${SPEC_LINK_FILENAME}`;
}

export async function requireStoryPublicationPolicyFromReader(
    input: StoryPublicationPolicyInput,
): Promise<{ taskLinkRequired: boolean }> {
    if (!input.signedStoryId) throw new Error('STORY_PUBLICATION_SIGNED_STORY_ID_REQUIRED');
    if ([SPEC_LINK_GATE_PATH, ...PULL_REQUEST_TEMPLATE_PATHS].some(path => input.changedPaths.includes(path))) {
        throw new Error('STORY_PUBLICATION_POLICY_CHANGED');
    }

    const specLinkGatePresent = await input.readFile(SPEC_LINK_GATE_PATH) !== null;
    let pullRequestTemplate: string | null = null;
    for (const templatePath of PULL_REQUEST_TEMPLATE_PATHS) {
        pullRequestTemplate = await input.readFile(templatePath);
        if (pullRequestTemplate !== null) break;
    }
    const taskLinkRequired = storyPublicationTaskLinkRequired({ specLinkGatePresent, pullRequestTemplate });
    requireStoryPublicationId(input.signedStoryId, taskLinkRequired);
    if (!taskLinkRequired) return { taskLinkRequired };

    const specLinkPath = storyPublicationSpecLinkPath(input.signedStoryId);
    if (input.changedPaths.includes(specLinkPath)) throw new Error('STORY_PUBLICATION_SPEC_LINK_CHANGED');
    if (await input.readFile(specLinkPath) === null) {
        throw new Error('STORY_PUBLICATION_SPEC_LINK_REQUIRED');
    }
    return { taskLinkRequired };
}

function githubStatus(error: unknown): number | undefined {
    return typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status: unknown }).status)
        : undefined;
}

async function readRepositoryFileAtRevision(input: {
    octokit: PaginatedOctokitInstance;
    owner: string;
    repo: string;
    path: string;
    baseSha: string;
}): Promise<string | null> {
    try {
        const response = await input.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
            owner: input.owner,
            repo: input.repo,
            path: input.path,
            ref: input.baseSha,
        });
        const data = response.data;
        if (Array.isArray(data) || data.type !== GITHUB_FILE_TYPE || data.encoding !== GITHUB_CONTENT_ENCODING || typeof data.content !== 'string') {
            throw new Error('STORY_PUBLICATION_POLICY_CONTENT_INVALID');
        }
        return Buffer.from(data.content, GITHUB_CONTENT_ENCODING).toString('utf8');
    } catch (error) {
        if (githubStatus(error) === GITHUB_NOT_FOUND_STATUS) return null;
        throw error;
    }
}

export async function requireStoryPublicationPolicyAtRevision(input: {
    octokit: PaginatedOctokitInstance;
    repository: string;
    baseSha: string;
    changedPaths: readonly string[];
    signedStoryId: string | undefined;
}): Promise<{ taskLinkRequired: boolean }> {
    const repositoryParts = input.repository.split(REPOSITORY_SEPARATOR);
    if (repositoryParts.length !== REPOSITORY_PART_COUNT || repositoryParts.some(part => part.trim() === '')) {
        throw new Error('STORY_PUBLICATION_REPOSITORY_INVALID');
    }
    const [owner, repo] = repositoryParts;
    const revision = await input.octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        owner,
        repo,
        commit_sha: input.baseSha,
    });
    if (revision.data.sha !== input.baseSha) throw new Error('STORY_PUBLICATION_BASE_REVISION_MISMATCH');

    return requireStoryPublicationPolicyFromReader({
        changedPaths: input.changedPaths,
        signedStoryId: input.signedStoryId,
        readFile: path => readRepositoryFileAtRevision({
            octokit: input.octokit,
            owner,
            repo,
            path,
            baseSha: input.baseSha,
        }),
    });
}

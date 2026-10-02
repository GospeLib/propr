/**
 * The merge method GitHub will accept for a pull request into `baseBranch`: one the repository
 * enables AND every enforced ruleset on that branch allows. Squash is preferred where allowed (the
 * historical default), then a merge commit, then rebase. Requesting any other method makes GitHub
 * refuse auto-merge or the merge.
 */
import type { getAuthenticatedOctokit } from './githubAuth.js';

export type MergeMethod = 'merge' | 'squash' | 'rebase';
const PREFERENCE: readonly MergeMethod[] = ['squash', 'merge', 'rebase'];
type Octokit = Awaited<ReturnType<typeof getAuthenticatedOctokit>>;
type RepoSettings = { allow_squash_merge?: boolean; allow_merge_commit?: boolean; allow_rebase_merge?: boolean };
type BranchRule = { type?: string; parameters?: { allowed_merge_methods?: string[] } };

export async function allowedMergeMethod(
    octokit: Octokit,
    owner: string,
    repo: string,
    baseBranch: string,
): Promise<MergeMethod> {
    const { data: settings } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo }) as { data: RepoSettings };
    const enabled: Record<MergeMethod, boolean> = {
        squash: settings.allow_squash_merge !== false,
        merge: settings.allow_merge_commit !== false,
        rebase: settings.allow_rebase_merge !== false,
    };
    const rules = await branchRules(octokit, owner, repo, baseBranch);
    const restrictions = rules
        .filter((rule) => rule.type === 'pull_request' && Array.isArray(rule.parameters?.allowed_merge_methods))
        .map((rule) => new Set(rule.parameters!.allowed_merge_methods));
    // Linear history (a ruleset rule or classic protection) forbids merge commits. Unreadable
    // protection may require it, so a linear method is preferred and a merge commit is the last resort.
    const classic = await classicLinearHistory(octokit, owner, repo, baseBranch);
    const linear = rules.some((rule) => rule.type === 'required_linear_history') || classic === true;
    const permitted = PREFERENCE.filter((candidate) =>
        enabled[candidate] && !(linear && candidate === 'merge')
        && restrictions.every((allowed) => allowed.has(candidate)));
    const method = classic === UNKNOWN
        ? permitted.find((candidate) => candidate !== 'merge') ?? permitted[0]
        : permitted[0];
    if (!method) throw new Error(`No merge method is allowed for ${owner}/${repo} into ${baseBranch}`);
    return method;
}

const RULES_PAGE_SIZE = 100;
const NOT_FOUND = 404;
/** An App without administration read cannot see classic protection: whether it applies is unknown. */
const FORBIDDEN = 403;
const UNKNOWN = 'unknown';

/** Every rule enforced on the branch, across all pages. */
async function branchRules(octokit: Octokit, owner: string, repo: string, branch: string): Promise<BranchRule[]> {
    const all: BranchRule[] = [];
    for (let page = 1; ; page++) {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
            owner, repo, branch, per_page: RULES_PAGE_SIZE, page,
        }) as { data: BranchRule[] };
        const batch = Array.isArray(data) ? data : [];
        all.push(...batch);
        if (batch.length < RULES_PAGE_SIZE) return all;
    }
}

/** Classic branch protection's required linear history: none on an unprotected branch, unknown when unreadable. */
async function classicLinearHistory(
    octokit: Octokit, owner: string, repo: string, branch: string,
): Promise<boolean | typeof UNKNOWN> {
    try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
            owner, repo, branch,
        }) as { data: { required_linear_history?: { enabled?: boolean } } };
        return data?.required_linear_history?.enabled === true;
    } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === NOT_FOUND) return false;
        if (status === FORBIDDEN) return UNKNOWN;
        throw error;
    }
}

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
    const { data: rules } = await octokit.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
        owner, repo, branch: baseBranch,
    }) as { data: BranchRule[] };
    const restrictions = (Array.isArray(rules) ? rules : [])
        .filter((rule) => rule.type === 'pull_request' && Array.isArray(rule.parameters?.allowed_merge_methods))
        .map((rule) => new Set(rule.parameters!.allowed_merge_methods));
    const method = PREFERENCE.find((candidate) =>
        enabled[candidate] && restrictions.every((allowed) => allowed.has(candidate)));
    if (!method) throw new Error(`No merge method is allowed for ${owner}/${repo} into ${baseBranch}`);
    return method;
}

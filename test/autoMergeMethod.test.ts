import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let repo: Record<string, boolean> = {};
let rules: unknown[] = [];
let rulesPage2: unknown[] = [];
let linearClassic = false;
const graphqlCalls: Record<string, unknown>[] = [];
const octokit = {
    request: async (route: string, params: unknown = {}) => {
        if (route.startsWith('GET /repos/{owner}/{repo}/pulls')) return { data: { node_id: 'PR_node', base: { ref: 'stage' } } };
        if (route.startsWith('GET /repos/{owner}/{repo}/rules/branches'))
            return { data: (params as { page?: number }).page === 2 ? rulesPage2 : rules };
        if (route.startsWith('GET /repos/{owner}/{repo}/branches/{branch}/protection'))
            return { data: { required_linear_history: { enabled: linearClassic } } };
        return { data: repo };
    },
    graphql: async (_query: string, variables: Record<string, unknown>) => {
        graphqlCalls.push(variables);
        return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: {
            enabledAt: 'now', enabledBy: { login: 'propr' }, mergeMethod: variables.mergeMethod } } } };
    },
};
const { allowedMergeMethod } = await import('../packages/core/src/auth/mergeMethod.js');
const noop = () => undefined;
await mock.module('@propr/core', { namedExports: {
    getAuthenticatedOctokit: async () => octokit,
    allowedMergeMethod,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    handleError: noop,
} });
const { enableAutoMerge } = await import('../src/github/autoMergeOperations.js');
const merge = (methods: string[]) => [{ type: 'pull_request', parameters: { allowed_merge_methods: methods } }];

test('auto-merge uses a merge commit where the repository allows only merge commits', async () => {
    repo = { allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false };
    rules = [];
    graphqlCalls.length = 0;
    const result = await enableAutoMerge({ owner: 'o', repoName: 'r', prNumber: 1 });
    assert.equal(result.success, true);
    assert.equal(graphqlCalls[0]?.mergeMethod, 'MERGE');
});

test("the base branch's ruleset narrows the repository's methods", async () => {
    repo = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true };
    rules = merge(['merge']);
    graphqlCalls.length = 0;
    await enableAutoMerge({ owner: 'o', repoName: 'r', prNumber: 1 });
    assert.equal(graphqlCalls[0]?.mergeMethod, 'MERGE');
    assert.equal(await allowedMergeMethod(octokit as never, 'o', 'r', 'stage'), 'merge');
});

test('squash stays the default where allowed, an explicit method is honoured, and none allowed fails loudly', async () => {
    repo = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true };
    rules = [];
    graphqlCalls.length = 0;
    await enableAutoMerge({ owner: 'o', repoName: 'r', prNumber: 1 });
    await enableAutoMerge({ owner: 'o', repoName: 'r', prNumber: 1, mergeMethod: 'REBASE' });
    assert.deepEqual(graphqlCalls.map((call) => call.mergeMethod), ['SQUASH', 'REBASE']);
    repo = { allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false };
    rules = merge(['merge']);
    await assert.rejects(allowedMergeMethod(octokit as never, 'o', 'r', 'stage'), /No merge method is allowed/);
});

test('linear history, from a ruleset or classic protection, rules out a merge commit', async () => {
    repo = { allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true };
    rules = [{ type: 'required_linear_history' }];
    rulesPage2 = [];
    linearClassic = false;
    assert.equal(await allowedMergeMethod(octokit as never, 'o', 'r', 'stage'), 'rebase');
    rules = [];
    linearClassic = true;
    assert.equal(await allowedMergeMethod(octokit as never, 'o', 'r', 'stage'), 'rebase');
    linearClassic = false;
    assert.equal(await allowedMergeMethod(octokit as never, 'o', 'r', 'stage'), 'merge');
});

test('a restriction on a later page of branch rules still applies', async () => {
    repo = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true };
    rules = Array.from({ length: 100 }, () => ({ type: 'deletion' }));
    rulesPage2 = merge(['merge']);
    linearClassic = false;
    assert.equal(await allowedMergeMethod(octokit as never, 'o', 'r', 'stage'), 'merge');
    rulesPage2 = [];
});

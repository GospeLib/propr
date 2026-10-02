import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let repo: Record<string, boolean> = {};
let rules: unknown[] = [];
const graphqlCalls: Record<string, unknown>[] = [];
const octokit = {
    request: async (route: string) => {
        if (route.startsWith('GET /repos/{owner}/{repo}/pulls')) return { data: { node_id: 'PR_node', base: { ref: 'stage' } } };
        if (route.startsWith('GET /repos/{owner}/{repo}/rules/branches')) return { data: rules };
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

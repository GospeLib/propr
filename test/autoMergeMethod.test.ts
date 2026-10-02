import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let repo: Record<string, boolean> = {};
const graphqlCalls: Record<string, unknown>[] = [];
const octokit = {
    request: async (route: string) => route.startsWith('GET /repos/{owner}/{repo}/pulls')
        ? { data: { node_id: 'PR_node' } }
        : { data: repo },
    graphql: async (_query: string, variables: Record<string, unknown>) => {
        graphqlCalls.push(variables);
        return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: {
            enabledAt: 'now', enabledBy: { login: 'propr' }, mergeMethod: variables.mergeMethod } } } };
    },
};
const noop = () => undefined;
await mock.module('@propr/core', { namedExports: {
    getAuthenticatedOctokit: async () => octokit,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    handleError: noop,
} });
const { enableAutoMerge } = await import('../src/github/autoMergeOperations.js');

test('auto-merge uses a merge commit where the repository allows only merge commits', async () => {
    repo = { allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: false };
    graphqlCalls.length = 0;
    const result = await enableAutoMerge({ owner: 'o', repoName: 'r', prNumber: 1 });
    assert.equal(result.success, true);
    assert.equal(graphqlCalls[0]?.mergeMethod, 'MERGE');
});

test('auto-merge keeps squash where the repository allows it, and honours an explicit method', async () => {
    repo = { allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true };
    graphqlCalls.length = 0;
    await enableAutoMerge({ owner: 'o', repoName: 'r', prNumber: 1 });
    await enableAutoMerge({ owner: 'o', repoName: 'r', prNumber: 1, mergeMethod: 'REBASE' });
    assert.deepEqual(graphqlCalls.map((call) => call.mergeMethod), ['SQUASH', 'REBASE']);
});

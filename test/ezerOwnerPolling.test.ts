import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
const added: any[] = [];
const log = { debug() {}, info() {}, warn() {}, error() {} };
await mock.module('@propr/core', { namedExports: {
    logger: { withCorrelation: () => log }, generateCorrelationId: () => 'correlation', handleError: (e: Error) => { throw e; },
    getIssueQueue: async () => ({ getActive: async () => [], getWaiting: async () => [], getDelayed: async () => [],
        add: async (_name: string, data: unknown) => { added.push(data); } }), COMMENT_BATCH_DELAY_MS: 1,
    filterCommentByAuthor: () => ({ shouldFilter: false }), checkCommentTrigger: () => ({ isTriggered: true }),
    extractLlmFromLabels: () => null, resolveModelAlias: (value: string) => value, loadPrimaryProcessingLabels: async () => ['propr'],
} });
const { pollForPullRequestComments } = await import('../src/polling/prCommentPolling.js');
test('polling skips owner-authored issue and review comments, retaining non-owner intake', async () => {
    process.env.EZER_OWNER_GITHUB_USER_ID = '42';
    const comment = (id: number, author: number, review = false) => ({ id, user: { id: author, login: `user-${author}` }, body: 'fix this',
        created_at: '2026-09-29T10:00:00Z', ...(review ? { pull_request_review_id: 5, diff_hunk: 'diff' } : {}) });
    const octokit = { paginate: async (route: string) => route.endsWith('/pulls')
        ? [{ number: 7, title: 'PR', labels: [{ name: 'propr' }], head: { ref: 'feature' } }]
        : route.includes('/issues/') ? [comment(1, 42), comment(2, 99)] : [comment(3, 42, true), comment(4, 99, true)] };
    const pipeline = { setex: () => pipeline, exec: async () => [] };
    await pollForPullRequestComments(octokit as never, 'owner/repo', 'correlation', { redisClient: { get: async () => null, pipeline: () => pipeline } as never,
        PR_FOLLOWUP_TRIGGER_KEYWORDS: [], MODEL_LABEL_PATTERN: '' });
    assert.equal(added.length, 1); assert.deepEqual(added[0].comments.map((c: any) => c.id), [2, 4]);
});

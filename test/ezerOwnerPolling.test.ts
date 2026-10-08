import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { classifyEzerAddressedComment } from '../packages/core/src/intake/routingOwnerEvent.js';
import { EZER_REVIEW_REQUEST } from '../packages/core/src/admission/reviewRequest.js';
const reviews: unknown[] = [];
const added: { comments: { id: number }[] }[] = [];
const log = { debug() {}, info() {}, warn() {}, error() {} };
await mock.module('@propr/core', { namedExports: {
    classifyEzerAddressedComment, EZER_REVIEW_REQUEST, enqueueAdmittedComment: async (input: unknown) => { reviews.push(input); },
    logger: { withCorrelation: () => log }, generateCorrelationId: () => 'correlation', handleError: (e: Error) => { throw e; },
    getIssueQueue: async () => ({ getActive: async () => [], getWaiting: async () => [], getDelayed: async () => [],
        add: async (_name: string, data: unknown) => { added.push(data as { comments: { id: number }[] }); } }), COMMENT_BATCH_DELAY_MS: 1,
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
    assert.equal(added.length, 1); assert.deepEqual(added[0].comments.map(c => c.id), [2, 4]);
});

test('polling sends only configured bot issue reviews to signed admission, never generic work', async () => {
    added.length = 0; reviews.length = 0;
    process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID = '77';
    const admissionId = '7b2a8c82-cd1a-4b89-8f83-465c29cf3a98';
    const body = `/ezer review ${admissionId}\nModel: gpt-5.6-sol\nRead only`;
    const comment = (id: number, author: number, text = body) => ({ id, user: { id: author, login: `bot-${author}[bot]` }, body: text, created_at: '2026-10-07T00:00:00Z' });
    const octokit = { paginate: async (route: string) => route.endsWith('/pulls')
        ? [{ number: 7, title: 'PR', labels: [{ name: 'propr' }], head: { ref: 'feature' } }]
        : route.includes('/issues/') ? [comment(1, 77), comment(2, 99), comment(3, 77, '/ezer fix this')]
            : [{ ...comment(4, 77), pull_request_review_id: 5 }] };
    const config = { redisClient: { get: async () => null } as never, PR_FOLLOWUP_TRIGGER_KEYWORDS: [], MODEL_LABEL_PATTERN: '' };
    await pollForPullRequestComments(octokit as never, 'owner/repo', 'correlation', config);
    assert.deepEqual(reviews, [{ repository: 'owner/repo', prNumber: 7, commentId: 1, body, admissionId, review: true }]);
    assert.deepEqual(added, []);
    delete process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID; reviews.length = 0;
    await pollForPullRequestComments(octokit as never, 'owner/repo', 'correlation', config);
    assert.deepEqual(reviews, []); assert.deepEqual(added, []);
});

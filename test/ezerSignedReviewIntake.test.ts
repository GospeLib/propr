import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import * as admission from '../packages/core/src/admission/ezerExecutionAdmission.js';
import { createWebhookIssueCommentCreatedEvent, createWebhookPRReviewCommentCreatedEvent } from './testHelpers.js';

const connection = { host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '16487') };
const redis = new Redis(connection);
const queue = new Queue('signed-review-intake-tests', { connection });
const secret = 'signed-review-test-secret-at-least-32-bytes';
const admissionId = '7b2a8c82-cd1a-4b89-8f83-465c29cf3a98';
const body = `/ezer review ${admissionId}\nModel: gpt-5.6-sol\nRead only`;
const bot = { id: 322838413, login: 'gospelib-ezer[bot]', type: 'Bot' as const };
const jobId = `pr-comments-batch-ezer-${admissionId}`;
let liveBody = body;
let liveAuthor = bot.id;
const pr = { state: 'open', head: { sha: 'a'.repeat(40), ref: 'feature', repo: { full_name: 'owner/repo' } },
    base: { ref: 'main', repo: { full_name: 'owner/repo' } }, labels: [] };
const octokit = { request: async (route: string) => ({ data: route.endsWith('/pulls/{pull_number}') ? pr : {
    id: 9, body: liveBody, user: { ...bot, id: liveAuthor }, issue_url: 'https://api.github.com/repos/owner/repo/issues/7',
    created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z',
} }) };
await mock.module('../packages/core/src/auth/githubAuth.js', { namedExports: { getAuthenticatedOctokit: async () => octokit } });
await mock.module('../packages/core/src/queue/taskQueue.js', { namedExports: { issueQueue: queue, getIssueQueue: async () => queue, COMMENT_BATCH_DELAY_MS: 1, shutdownQueue: async () => {} } });
// The admission implementation uses the public barrel; keep unrelated services out of this harness.
await mock.module('../packages/core/src/index.js', { namedExports: { ...admission,
    getAuthenticatedOctokit: async () => octokit, issueQueue: queue, generateCorrelationId: () => 'signed-review-test',
    extractLlmFromLabels: () => null, logger: { withCorrelation: () => ({}) },
} });
const { processCommentEvent, handleCommentEdited } = await import('../packages/core/src/webhook/commentEventHandler.js');
const { resolveOwnerEzerCommandBody } = await import('../packages/core/src/intake/routingOwnerEvent.js');
const config = { redisClient: redis, PR_FOLLOWUP_TRIGGER_KEYWORDS: [], processCommentEvent };
function event(text = body, author = bot) {
    const payload = createWebhookIssueCommentCreatedEvent({ comment: { body: text }, issue: { number: 7 } });
    payload.repository.owner.login = 'owner'; payload.repository.name = 'repo';
    payload.issue.pull_request = { url: 'https://api.github.com/repos/owner/repo/pulls/7' } as never;
    payload.comment.id = 9; payload.comment.user = { ...author } as never;
    return payload;
}
async function pending(signingSecret = secret) {
    const claims = { version: 1, admissionId, operationId: 'op', storyId: 'story', epicId: 'epic', featureThread: 'feature',
        repository: 'owner/repo', issueNumber: 7, target: 'main', scope: ['src/'], authorityRevision: 'r1', authorityDigest: 'd1',
        issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        comment: { commentId: 9, bodyDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`, headSha: pr.head.sha, headBranch: 'feature' } };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    await redis.set(admission.pendingExecutionAdmissionKey('owner/repo', 7), `${encoded}.${createHmac('sha256', signingSecret).update(encoded).digest('base64url')}`);
}
beforeEach(async () => {
    await redis.flushdb(); liveBody = body; liveAuthor = bot.id;
    process.env.EZER_OWNER_GITHUB_USER_ID = '42';
    process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID = String(bot.id);
    // The trigger identity is independent of the existing typed-source identity.
    process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID = '213159723';
    process.env.EZER_ADMISSION_HMAC_SECRET = secret;
});
after(async () => { await queue.close(); redis.disconnect(); });
test('Ezer bot signed PR issue comment is admitted only as a review', async () => {
    await pending();
    assert.equal((await processCommentEvent(event(), 'issue_comment', 'test', config)).status, 'accepted');
    const job = (await queue.getJob(jobId))!;
    assert.equal(job.data.commandMode, 'review');
    assert.deepEqual(job.data.requestedModels, ['gpt-5.6-sol']);
    assert.equal(job.data.commandInstructions, 'Read only');
    assert.equal(job.data.executionAdmissionReceipt.admissionId, admissionId);
    assert.equal(resolveOwnerEzerCommandBody(event().comment), null);
    assert.equal((await queue.getJobs()).length, 1);
});
for (const scenario of ['unknown', 'non-review', 'unset', 'invalid-id', 'inline', 'issue'] as const) {
    test(`${scenario} cannot use the bot review exception`, async () => {
        await pending(); const payload = event();
        if (scenario === 'unknown') payload.comment.user.id = 123;
        if (scenario === 'non-review') payload.comment.body = '/ezer fix this';
        if (scenario === 'unset' || scenario === 'invalid-id') process.env.EZER_PROPR_REVIEW_AUTHOR_USER_ID = String(bot.id);
        if (scenario === 'unset') delete process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID;
        if (scenario === 'invalid-id') process.env.EZER_REVIEW_TRIGGER_AUTHOR_USER_ID = '322838413.0';
        if (scenario === 'issue') delete payload.issue.pull_request;
        const inline = createWebhookPRReviewCommentCreatedEvent({ comment: { body }, pullRequest: { number: 7 } });
        inline.comment.user = bot as never;
        const result = scenario === 'inline'
            ? await processCommentEvent(inline, 'pull_request_review_comment', 'test', config)
            : await processCommentEvent(payload, 'issue_comment', 'test', config);
        assert.equal(result.status, 'ignored'); assert.equal(await queue.getJob(jobId), undefined);
    });
}
for (const scenario of ['missing', 'bad-hmac', 'changed-body', 'changed-author'] as const) {
    test(`${scenario} fails signed admission after the shared gate`, async () => {
        if (scenario !== 'missing') await pending(scenario === 'bad-hmac' ? 'wrong-secret' : secret);
        if (scenario === 'changed-body') liveBody += ' edited';
        if (scenario === 'changed-author') liveAuthor = 123;
        await assert.rejects(() => processCommentEvent(event(liveBody), 'issue_comment', 'test', config));
        assert.equal(await queue.getJob(jobId), undefined);
    });
}
for (const replacement of [body, `${body} edited`, '/ezer fix this']) {
    test(`edited review safely reprocesses ${JSON.stringify(replacement)}`, async () => {
        await pending(); await processCommentEvent(event(), 'issue_comment', 'test', config);
        liveBody = replacement;
        if (replacement === `${body} edited`) {
            await assert.rejects(() => handleCommentEdited(event(replacement), 'issue_comment', 'test', config));
        } else await handleCommentEdited(event(replacement), 'issue_comment', 'test', config);
        if (replacement === body) assert.equal((await queue.getJob(jobId))?.data.commandMode, 'review');
        else {
            assert.equal(await queue.getJob(jobId), undefined);
            assert.ok(await redis.get(`worker:abort:${jobId}`));
            assert.equal((await queue.getJobs()).length, 0);
        }
    });
}

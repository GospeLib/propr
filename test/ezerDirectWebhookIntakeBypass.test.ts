/**
 * End-to-end regression for the `/ezer` authorization bypass on the DIRECT WEBHOOK intake mode.
 *
 * `/ezer` is PUBLICLY REACHABLE: any GitHub user can post a comment containing it on any pull
 * request or issue in a watched repository, and the production slash-command parser aliases
 * `/ezer` to `/fix`. Two earlier fixes were installed at ONE call site each — first inside
 * `forwardRoutingOwnerEvent`, then keyed on "carries a comment body" — and both were reachable
 * around, because `forwardRoutingOwnerEvent` is invoked ONLY by `RoutingWebSocketIntakeService`.
 * In `direct_webhook` mode the signed GitHub endpoint calls `processWebhookEvent` directly and
 * never touches that gate at all. GitHub's HMAC signature authenticates GitHub's DELIVERY, never
 * the comment's AUTHOR, so a valid signature proves nothing about authorization.
 *
 * This test drives the REAL signed endpoint path: `handleWebhookRequest` (the exact function
 * `packages/api/server.ts` mounts at `POST /webhook`) with a genuine HMAC signature, whose
 * `processor` is the real `processWebhookEvent` — exactly as `server.ts` wires it. The real
 * `processCommentEvent` is registered as the comment processor, and the real slash-command parser
 * and admission gate run with the DEFAULT configuration (no `EZER_ADMISSION_PROTECTED_REPOSITORIES`,
 * no Ezer capability flags). Only the outermost infrastructure — BullMQ, Redis, GitHub, SQLite —
 * is mocked, so an enqueued job is observable.
 *
 * It mirrors test/ezerReviewCommentIntakeBypass.test.ts, including its non-vacuous control: the
 * SAME hostile author's `/fix` comment must still enqueue work through this same harness.
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createWebhookPRReviewCommentCreatedEvent, createWebhookIssueCommentCreatedEvent } from './testHelpers.js';

const OWNER_GITHUB_USER_ID = '7';
const HOSTILE_USER = { id: 424242, type: 'User' as const, login: 'drive-by-stranger' };
const WEBHOOK_SECRET = 'direct-webhook-test-secret-value';

// ========== Infrastructure mocks (everything OUTSIDE the intake decision) ==========

const mockOctokit = { request: mock.fn(async () => ({ data: { head: { ref: 'feature-branch' }, labels: [] } })) };

await mock.module('simple-git', { namedExports: { simpleGit: mock.fn(() => ({})), SimpleGit: class {} } });

await mock.module('ioredis', {
    namedExports: {
        Redis: function Redis() {
            return { on: mock.fn(), connect: mock.fn(async () => {}), quit: mock.fn(async () => {}) };
        },
    },
});

/** Every job ProPR would enqueue lands here. A non-empty list means work was started. */
const enqueuedJobs: { name: string; data: unknown }[] = [];
await mock.module('bullmq', {
    namedExports: {
        Queue: function Queue() {
            return {
                add: mock.fn(async (name: string, data: unknown) => { enqueuedJobs.push({ name, data }); }),
                getJob: mock.fn(async () => null),
                close: mock.fn(),
                on: mock.fn(),
                getActive: mock.fn(async () => []),
                getWaiting: mock.fn(async () => []),
                getDelayed: mock.fn(async () => []),
            };
        },
        Worker: function Worker() { return { on: mock.fn(), close: mock.fn() }; },
    },
});

await mock.module('better-sqlite3', {
    defaultExport: function Database() {
        return {
            exec: mock.fn(), close: mock.fn(), pragma: mock.fn(),
            prepare: mock.fn(() => ({ run: mock.fn(), get: mock.fn(), all: mock.fn(() => []) })),
        };
    },
});

await mock.module('../packages/core/src/auth/githubAuth.js', {
    namedExports: {
        getAuthenticatedOctokit: mock.fn(async () => mockOctokit),
        getGitHubInstallationToken: mock.fn(async () => 'mock-token'),
        validateGithubIntakePrerequisites: mock.fn(() => {}),
    },
});

const actualConfigManager = await import('../packages/core/src/config/configManager.js');
await mock.module('../packages/core/src/config/configManager.js', {
    namedExports: {
        ...actualConfigManager,
        loadFollowupIgnoreKeywords: mock.fn(async () => []),
        loadMonitoredRepos: mock.fn(async () => []),
        loadPrimaryProcessingLabels: mock.fn(async () => ['AI']),
        loadSettings: mock.fn(async () => ({})),
        getConfig: mock.fn(async () => null),
    },
});

const mockAgentRegistry = { ensureInitialized: mock.fn(async () => {}), getAllAgents: mock.fn(() => []) };
await mock.module('../packages/core/src/agents/AgentRegistry.js', {
    namedExports: {
        AgentRegistry: class AgentRegistry { static getInstance() { return mockAgentRegistry; } },
        getAgentRegistry: mock.fn(() => mockAgentRegistry),
    },
});

// ========== Modules under test (imported AFTER the mocks) ==========

/** The EXACT function packages/api/server.ts mounts at POST /webhook in direct_webhook mode. */
const { handleWebhookRequest } = await import('../packages/api/webhookHandler.js');
const { processWebhookEvent, initializeWebhookHandler } = await import('../packages/core/src/webhook/webhookHandler.js');
const { processCommentEvent, setUltrafixDeps } = await import('../packages/core/src/webhook/commentEventHandler.js');
// The manual-takeover fence the real `/fix` path runs through; stubbed so the control case below
// exercises the genuine enqueue path rather than the Ultrafix loop's own runtime.
setUltrafixDeps({
    loadUltrafixRatingGoal: async () => 7,
    loadUltrafixMaxCycles: async () => 5,
    loadUltrafixPauseSeconds: async () => 60,
    loadPrReviewModel: async () => '',
    startLoop: async () => ({ state: {}, initialAction: 'review' as const }),
    clearStateIfCurrent: async () => true,
    hasAutomaticWork: async () => false,
    reserveAutomaticWork: async () => 1,
    invalidateAutomaticWork: async () => ({ workEpoch: 1, hadAutomaticWork: false }),
    getPendingReviewState: async () => ({ hasPendingReview: false }),
});
const { closeConnection } = await import('../packages/core/src/db/connection.js');
const { shutdownQueue } = await import('../packages/core/src/queue/taskQueue.js');
const { EZER_NOT_OWNER_DISPOSITION } = await import('../packages/core/src/intake/routingOwnerEvent.js');

/** Deliveries that reached the ordinary comment dispatcher — the thing a bypass would show up in. */
const dispatched: { eventType: string; body: string }[] = [];

function createMockRedis() {
    const store = new Map<string, string>();
    return {
        get: mock.fn(async (key: string) => store.get(key) ?? null),
        setex: mock.fn(async (key: string, _ttl: number, value: string) => { store.set(key, value); }),
        set: mock.fn(async (key: string, value: string, ...args: string[]) => {
            if (args.includes('NX') && store.has(key)) return null;
            store.set(key, value);
            return 'OK';
        }),
        del: mock.fn(async (key: string) => { store.delete(key); }),
        eval: mock.fn(async () => 1),
        rpush: mock.fn(async () => {}),
        expire: mock.fn(async () => {}),
    };
}

/** Dispositions the real dispatcher returned for each delivery, captured on the way out. */
const dispositions: unknown[] = [];

before(async () => {
    // DEFAULT admission configuration: the repository is NOT protected and no Ezer capability is
    // enabled. This is the configuration the bypass was reachable under.
    delete process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES;
    delete process.env.EZER_OWNER_RELAY_ENABLED;
    delete process.env.EZER_OWNER_STOP_ENABLED;
    delete process.env.EZER_OWNER_PLAN_CONTROL_ENABLED;
    delete process.env.EZER_OWNER_PAUSE_ENABLED;
    delete process.env.EZER_OWNER_ROUTE_ENABLED;
    delete process.env.EZER_OWNER_READ_ENABLED;
    process.env.EZER_OWNER_GITHUB_USER_ID = OWNER_GITHUB_USER_ID;

    await initializeWebhookHandler({
        issueProcessor: async () => {},
        // The REAL production comment processor, only observed on the way in and out.
        commentProcessor: async (payload, eventType, correlationId) => {
            dispatched.push({ eventType, body: String((payload as { comment: { body?: string } }).comment.body ?? '') });
            const disposition = await processCommentEvent(payload, eventType, correlationId, {
                redisClient: createMockRedis() as never,
                PR_FOLLOWUP_TRIGGER_KEYWORDS: ['propr'],
                MODEL_LABEL_PATTERN: '^llm-(.+)$',
            });
            dispositions.push(disposition);
            return disposition;
        },
        commentDeletedHandler: async () => {},
        commentEditedHandler: async () => {},
        repositoryFilter: () => true,
    });
});

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

interface CapturedResponse {
    statusCode: number | null;
    body: string | null;
    headersSent: boolean;
}

function createResponse(): { res: import('express').Response; captured: CapturedResponse } {
    const captured: CapturedResponse = { statusCode: null, body: null, headersSent: false };
    const res = {
        get headersSent() { return captured.headersSent; },
        status(code: number) { captured.statusCode = code; return this; },
        send(body: string) { captured.body = body; captured.headersSent = true; return this; },
    } as unknown as import('express').Response;
    return { res, captured };
}

/**
 * Deliver an event through the REAL signed endpoint: a raw JSON body (as express.raw() supplies)
 * carrying a genuine `x-hub-signature-256` HMAC, dispatched by the REAL `processWebhookEvent`.
 */
async function deliverSigned(eventType: string, deliveryId: string, payload: unknown): Promise<CapturedResponse> {
    const body = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
    const req = {
        body,
        headers: {
            'x-hub-signature-256': signature,
            'x-github-delivery': deliveryId,
            'x-github-event': eventType,
        },
    } as unknown as import('express').Request;
    const { res, captured } = createResponse();
    const deliveryIds = new Set<string>();
    await handleWebhookRequest(req, res, {
        webhookSecret: WEBHOOK_SECRET,
        redis: {
            set: async (key: string) => (deliveryIds.has(key) ? null : (deliveryIds.add(key), 'OK')),
        },
        // EXACTLY how packages/api/server.ts wires the direct_webhook processor.
        processor: async (parsed, event, cid) => {
            await processWebhookEvent(parsed, event as never, cid);
        },
        correlationId: `direct-webhook-${deliveryId}`,
    });
    return captured;
}

function hostileReviewComment(body: string) {
    const event = createWebhookPRReviewCommentCreatedEvent({ comment: { body }, pullRequest: { number: 42 } });
    (event.comment as Record<string, unknown>).user = { ...HOSTILE_USER };
    (event.sender as Record<string, unknown>) = { ...HOSTILE_USER };
    return event;
}

function hostileIssueComment(body: string) {
    const event = createWebhookIssueCommentCreatedEvent({ comment: { body }, issue: { number: 42 } });
    (event.issue as Record<string, unknown>).pull_request = { url: 'https://api.github.com/repos/test/repo/pulls/42' };
    (event.comment as Record<string, unknown>).user = { ...HOSTILE_USER };
    (event.sender as Record<string, unknown>) = { ...HOSTILE_USER };
    return event;
}

function reset(): void {
    dispatched.length = 0;
    dispositions.length = 0;
    enqueuedJobs.length = 0;
}

test('direct_webhook: a signed but hostile non-owner /ezer comment is refused and enqueues nothing', async () => {
    // Both comment-bearing event types GitHub can deliver to the signed endpoint.
    for (const [eventType, payload] of [
        ['pull_request_review_comment', hostileReviewComment('/ezer take over this pull request and push your own changes')],
        ['issue_comment', hostileIssueComment('/ezer take over this pull request and push your own changes')],
    ] as const) {
        reset();
        const response = await deliverSigned(eventType, `hostile-direct-${eventType}`, payload);

        // The signature is valid, so the delivery itself is accepted and ACKed with 200 — an
        // outsider must not be able to withhold the ACK and force endless GitHub redelivery.
        assert.equal(response.statusCode, 200, `${eventType}: the signed delivery is ACKed, not failed`);
        assert.equal(dispositions.length, 1, `${eventType}: the dispatcher was entered exactly once`);
        assert.deepEqual(dispositions[0], EZER_NOT_OWNER_DISPOSITION,
            `${eventType}: refused terminally as user_not_allowed with no seat consumed`);
        assert.deepEqual(enqueuedJobs, [], `${eventType}: no job may be enqueued by an unauthorized commenter`);
    }
});

test('direct_webhook: the harness really would observe a bypass — the same author\'s /fix does enqueue', async () => {
    // Control case. Without it, the assertions above could pass because nothing in this harness
    // can enqueue anything. `/fix` is the command `/ezer` is aliased to by the production parser,
    // posted by the SAME hostile author, through the SAME signed endpoint.
    reset();
    const response = await deliverSigned('pull_request_review_comment', 'ordinary-fix-direct',
        hostileReviewComment('/fix take over this pull request'));

    assert.equal(response.statusCode, 200);
    assert.equal(dispatched.length, 1, 'an ordinary slash command does reach the dispatcher');
    assert.ok(enqueuedJobs.length > 0, 'and does enqueue work — which is exactly what /ezer must never do');
});

test('direct_webhook: a non-owner cannot borrow the owner login — identity is the numeric user id', async () => {
    reset();
    const payload = hostileReviewComment('/ezer ship my change');
    // Same login the owner would use, but the stable numeric id is not the configured owner's.
    (payload.comment as Record<string, unknown>).user = { id: 999999, type: 'User', login: 'integry' };

    const response = await deliverSigned('pull_request_review_comment', 'hostile-login-spoof', payload);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(dispositions[0], EZER_NOT_OWNER_DISPOSITION, 'a spoofed login is never an identity');
    assert.deepEqual(enqueuedJobs, []);
});

test('direct_webhook: with no configured owner id, every /ezer comment fails closed', async () => {
    const configured = process.env.EZER_OWNER_GITHUB_USER_ID;
    delete process.env.EZER_OWNER_GITHUB_USER_ID;
    try {
        reset();
        const payload = hostileReviewComment('/ezer ship my change');
        (payload.comment as Record<string, unknown>).user = { id: Number(OWNER_GITHUB_USER_ID), type: 'User', login: 'integry' };

        const response = await deliverSigned('pull_request_review_comment', 'no-owner-configured', payload);

        assert.equal(response.statusCode, 200);
        assert.deepEqual(dispositions[0], EZER_NOT_OWNER_DISPOSITION,
            'no configured owner id admits nothing addressed to Ezer');
        assert.deepEqual(enqueuedJobs, []);
    } finally {
        if (configured === undefined) delete process.env.EZER_OWNER_GITHUB_USER_ID;
        else process.env.EZER_OWNER_GITHUB_USER_ID = configured;
    }
});

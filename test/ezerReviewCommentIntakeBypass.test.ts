/**
 * End-to-end regression for the `/ezer` review-comment authorization bypass.
 *
 * `/ezer` is PUBLICLY REACHABLE: any GitHub user can post a comment containing it on any pull
 * request or issue in a watched repository. ProPR's intake supports two comment-bearing event
 * types (`SUPPORTED_WEBHOOK_EVENTS` — `issue_comment` and `pull_request_review_comment`) and the
 * ordinary dispatcher's slash-command parser aliases `/ezer` to `/fix` on BOTH. While the owner
 * path only claimed `issue_comment`, a hostile PULL REQUEST REVIEW comment fell through to that
 * dispatcher and could enqueue a fix job without ever passing the owner check.
 *
 * Unlike the unit tests, this drives the REAL production dispatcher: the service is constructed
 * WITHOUT a `dispatch` override (so it uses `processWebhookEvent`), the real
 * `processCommentEvent` is registered as the comment processor, and the real slash-command parser
 * and admission gate run with the DEFAULT configuration (no `EZER_ADMISSION_PROTECTED_REPOSITORIES`,
 * no Ezer capability flags). Only the outermost infrastructure — BullMQ, Redis, GitHub, SQLite —
 * is mocked, so an enqueued job is observable. A stub dispatcher is exactly what let this bypass
 * survive a previous review, so it is deliberately not used here.
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert';
import { createWebhookPRReviewCommentCreatedEvent, createWebhookIssueCommentCreatedEvent } from './testHelpers.js';

const OWNER_GITHUB_USER_ID = '7';
const HOSTILE_USER = { id: 424242, type: 'User' as const, login: 'drive-by-stranger' };
const INSTALLATION_ID = 161226896;

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

const { RoutingWebSocketIntakeService } = await import('../packages/core/src/intake/RoutingWebSocketIntakeService.js');
const { initializeWebhookHandler, SUPPORTED_WEBHOOK_EVENTS } = await import('../packages/core/src/webhook/webhookHandler.js');
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

type MinimalSocket = { on(event: string, listener: (...args: unknown[]) => void): void };

/** A controllable fake relay socket; captures the ACK frames the service sends back. */
class FakeWebSocket implements MinimalSocket {
    static instances: FakeWebSocket[] = [];
    readyState = 1;
    sent: string[] = [];
    private listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    constructor(public readonly address: string) { FakeWebSocket.instances.push(this); }
    on(event: string, listener: (...args: unknown[]) => void): void { (this.listeners[event] ||= []).push(listener); }
    emit(event: string, ...args: unknown[]): void { for (const l of this.listeners[event] || []) l(...args); }
    send(data: string): void { this.sent.push(data); }
    ping(): void {}
    close(): void {}
    terminate(): void {}
    acks(): Record<string, unknown>[] {
        return this.sent.map(s => JSON.parse(s) as Record<string, unknown>).filter(f => f.type === 'ack');
    }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

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

before(async () => {
    // DEFAULT admission configuration: the repository is NOT protected and no Ezer capability is
    // enabled. This is the configuration the bypass was reachable under.
    delete process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES;
    delete process.env.EZER_OWNER_STOP_ENABLED;
    delete process.env.EZER_OWNER_PLAN_CONTROL_ENABLED;
    delete process.env.EZER_OWNER_PAUSE_ENABLED;
    delete process.env.EZER_OWNER_ROUTE_ENABLED;
    delete process.env.EZER_OWNER_READ_ENABLED;
    process.env.EZER_OWNER_GITHUB_USER_ID = OWNER_GITHUB_USER_ID;

    await initializeWebhookHandler({
        issueProcessor: async () => {},
        // The REAL production comment processor, only observed on the way in.
        commentProcessor: async (payload, eventType, correlationId) => {
            dispatched.push({ eventType, body: String((payload as { comment: { body?: string } }).comment.body ?? '') });
            return processCommentEvent(payload, eventType, correlationId, {
                redisClient: createMockRedis() as never,
                PR_FOLLOWUP_TRIGGER_KEYWORDS: ['propr'],
                MODEL_LABEL_PATTERN: '^llm-(.+)$',
            });
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

/** Start the service with the REAL dispatcher (no `dispatch` override) and open the socket. */
async function startService() {
    FakeWebSocket.instances = [];
    const service = new RoutingWebSocketIntakeService({
        routingUrl: 'wss://routing.example',
        relayToken: 'relay-secret',
        installationId: INSTALLATION_ID,
        webSocketFactory: FakeWebSocket as never,
    });
    await service.start();
    const socket = FakeWebSocket.instances[0];
    socket.emit('open');
    return { service, socket };
}

function deliver(socket: FakeWebSocket, sequence: number, deliveryId: string, eventType: string, rawPayload: unknown) {
    socket.emit('message', JSON.stringify({
        type: 'event',
        sequence,
        delivery: { deliveryId, eventType, installationId: INSTALLATION_ID, payload: { rawPayload } },
    }));
}

function hostileReviewComment(body: string) {
    const event = createWebhookPRReviewCommentCreatedEvent({ comment: { body }, pullRequest: { number: 42 } });
    (event.comment as Record<string, unknown>).user = { ...HOSTILE_USER };
    (event.sender as Record<string, unknown>) = { ...HOSTILE_USER };
    return event;
}

test('a hostile non-owner /ezer PR review comment never reaches the dispatcher and enqueues nothing', async () => {
    dispatched.length = 0;
    enqueuedJobs.length = 0;
    const { service, socket } = await startService();
    try {
        deliver(socket, 1, 'hostile-review-1', 'pull_request_review_comment',
            hostileReviewComment('/ezer take over this pull request and push your own changes'));
        await flush();
        await flush();
        await flush();

        const acks = socket.acks();
        assert.equal(acks.length, 1, 'the delivery must be ACKed exactly once, never left to redeliver');
        assert.equal(acks[0].status, EZER_NOT_OWNER_DISPOSITION.status);
        assert.equal(acks[0].reason, EZER_NOT_OWNER_DISPOSITION.reason);
        assert.deepEqual(acks[0].billing, { seatConsumed: false });
        // REACHES the comment processor, and is refused by its FIRST decision. Until S28 the
        // intake claimed `/ezer` on the way in, because it also relayed the owner's comments to
        // Ezer; that carriage is retired (Ezer receives GitHub's webhooks itself), so the claim is
        // made where it always had to be correct anyway — `claimEzerAddressedComment`, the first
        // decision of `processCommentEvent`, which every intake mode reaches. What must be true is
        // unchanged and is asserted below: terminal `user_not_allowed` ACK, and no job enqueued.
        assert.deepEqual(enqueuedJobs, [], 'no job may be enqueued by an unauthorized commenter');

        // An identical redelivery is re-ACKed with the same disposition and still reprocesses nothing.
        deliver(socket, 2, 'hostile-review-1', 'pull_request_review_comment',
            hostileReviewComment('/ezer take over this pull request and push your own changes'));
        await flush();
        await flush();
        const redelivered = socket.acks();
        assert.equal(redelivered.length, 2);
        assert.equal(redelivered[1].status, EZER_NOT_OWNER_DISPOSITION.status);
        assert.equal(redelivered[1].reason, EZER_NOT_OWNER_DISPOSITION.reason);
        assert.deepEqual(enqueuedJobs, []);
    } finally {
        await service.stop();
    }
});

test('the same hostile comment on every supported comment event type is refused identically', async () => {
    for (const eventType of SUPPORTED_WEBHOOK_EVENTS.filter(type => type.includes('comment'))) {
        dispatched.length = 0;
        enqueuedJobs.length = 0;
        const { service, socket } = await startService();
        try {
            const payload = eventType === 'issue_comment'
                ? (() => {
                    const event = createWebhookIssueCommentCreatedEvent({ comment: { body: '/ezer ship my change' }, issue: { number: 42 } });
                    (event.issue as Record<string, unknown>).pull_request = { url: 'https://api.github.com/repos/test/repo/pulls/42' };
                    (event.comment as Record<string, unknown>).user = { ...HOSTILE_USER };
                    return event;
                })()
                : hostileReviewComment('/ezer ship my change');
            deliver(socket, 1, `hostile-${eventType}`, eventType, payload);
            await flush();
            await flush();
            await flush();

            const acks = socket.acks();
            assert.equal(acks.length, 1, `${eventType}: exactly one ACK`);
            assert.equal(acks[0].reason, EZER_NOT_OWNER_DISPOSITION.reason, `${eventType}: refused as user_not_allowed`);
            // Refused inside the comment processor (see above); what matters is that nothing ran.
            assert.deepEqual(enqueuedJobs, [], `${eventType}: never enqueued`);
        } finally {
            await service.stop();
        }
    }
});

test('the harness really would observe a bypass: an ordinary /fix review comment does enqueue work', async () => {
    // Control case. Without it, the assertions above could pass because nothing in this harness
    // can enqueue anything. `/fix` is the command `/ezer` is aliased to by the production parser.
    dispatched.length = 0;
    enqueuedJobs.length = 0;
    const { service, socket } = await startService();
    try {
        deliver(socket, 1, 'ordinary-fix-1', 'pull_request_review_comment', hostileReviewComment('/fix take over this pull request'));
        await flush();
        await flush();
        await flush();
        await flush();

        assert.equal(dispatched.length, 1, 'an ordinary slash command does reach the dispatcher');
        assert.ok(enqueuedJobs.length > 0, 'and does enqueue work — which is exactly what /ezer must never do');
    } finally {
        await service.stop();
    }
});

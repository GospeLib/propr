/**
 * The `/ezer` authorization chokepoint, proved at the boundary itself rather than per intake mode.
 *
 * `processCommentEvent` (packages/core/src/webhook/commentEventHandler.ts) is the ONLY consumer of
 * `parseSlashCommand` in the codebase, and therefore the only place the production parser's
 * `/ezer` → `/fix` alias can be reached. Every route to that dispatcher goes through it:
 *
 *   - routing-WebSocket intake  → processWebhookEvent → handleIssueCommentEvent / handlePullRequestReviewCommentEvent
 *   - direct_webhook endpoint   → processWebhookEvent → (the same two handlers)
 *   - daemon comment wrapper    → src/daemon.ts:432
 *   - API comment wrapper       → packages/api/server.ts:140
 *   - edited-comment reprocess  → packages/core/src/webhook/commentEventHandler.ts:249
 *   - system-ultrafix re-entry  → src/jobs/issueJobPostProcessingHelpers.ts:155 (synthetic Bot payload)
 *
 * Each of the wrappers above adds no logic of its own — it supplies a config and calls this one
 * function — so exercising the function directly exercises all of them. The two intake modes get
 * their own full end-to-end regressions (test/ezerReviewCommentIntakeBypass.test.ts and
 * test/ezerDirectWebhookIntakeBypass.test.ts); this file covers the rest and pins the structural
 * invariant that makes one gate sufficient.
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createWebhookIssueCommentCreatedEvent, createWebhookPRReviewCommentCreatedEvent } from './testHelpers.js';

const OWNER_GITHUB_USER_ID = '7';
const OWNER_USER = { id: Number(OWNER_GITHUB_USER_ID), type: 'User' as const, login: 'integry' };
const HOSTILE_USER = { id: 424242, type: 'User' as const, login: 'drive-by-stranger' };

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

const { processCommentEvent, setUltrafixDeps } = await import('../packages/core/src/webhook/commentEventHandler.js');
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

const config = () => ({
    redisClient: createMockRedis() as never,
    PR_FOLLOWUP_TRIGGER_KEYWORDS: ['propr'],
    MODEL_LABEL_PATTERN: '^llm-(.+)$',
});

function issueComment(body: string, user: Record<string, unknown>) {
    const event = createWebhookIssueCommentCreatedEvent({ comment: { body }, issue: { number: 42 } });
    (event.issue as Record<string, unknown>).pull_request = { url: 'https://api.github.com/repos/test/repo/pulls/42' };
    (event.comment as Record<string, unknown>).user = { ...user };
    (event.sender as Record<string, unknown>) = { ...user };
    return event;
}

function reviewComment(body: string, user: Record<string, unknown>) {
    const event = createWebhookPRReviewCommentCreatedEvent({ comment: { body }, pullRequest: { number: 42 } });
    (event.comment as Record<string, unknown>).user = { ...user };
    (event.sender as Record<string, unknown>) = { ...user };
    return event;
}

before(() => {
    delete process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES;
    process.env.EZER_OWNER_GITHUB_USER_ID = OWNER_GITHUB_USER_ID;
});

after(async () => {
    await shutdownQueue();
    await closeConnection();
});

test('every caller of the dispatcher refuses a non-owner /ezer comment, on both comment event types', async () => {
    for (const [eventType, event] of [
        ['issue_comment', issueComment('/ezer take over this pull request', HOSTILE_USER)],
        ['pull_request_review_comment', reviewComment('/ezer take over this pull request', HOSTILE_USER)],
    ] as const) {
        enqueuedJobs.length = 0;
        const disposition = await processCommentEvent(event as never, eventType, `chokepoint-${eventType}`, config());
        assert.deepEqual(disposition, EZER_NOT_OWNER_DISPOSITION, `${eventType}: refused at the chokepoint`);
        assert.deepEqual(enqueuedJobs, [], `${eventType}: nothing enqueued`);
    }
});

test('the synthetic system re-entry shape cannot smuggle /ezer either', async () => {
    // The exact payload shape src/jobs/issueJobPostProcessingHelpers.ts builds for system ultrafix:
    // a Bot-authored synthetic `issue_comment`. A Bot is never the owner, so an `/ezer` body here
    // is refused like any other — the synthetic path gets no implicit trust from being internal.
    enqueuedJobs.length = 0;
    const syntheticBotComment = {
        action: 'created',
        repository: { name: 'testrepo', owner: { login: 'testowner' }, full_name: 'testowner/testrepo' },
        issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/testowner/testrepo/pulls/42' } },
        comment: { id: 555, body: '/ezer run the loop', user: { login: 'propr-dev[bot]', type: 'Bot' } },
    };
    const disposition = await processCommentEvent(syntheticBotComment as never, 'issue_comment', 'chokepoint-synthetic', config());
    assert.deepEqual(disposition, EZER_NOT_OWNER_DISPOSITION);
    assert.deepEqual(enqueuedJobs, []);
});

test('the gate is authorization, not a blanket ban: the owner\'s own /ezer comment still dispatches', async () => {
    // Non-vacuous control. If the chokepoint refused everything addressed to Ezer, the assertions
    // above would pass for the wrong reason and the owner's own commands would be broken.
    enqueuedJobs.length = 0;
    const disposition = await processCommentEvent(
        issueComment('/ezer finish the refactor', OWNER_USER) as never, 'issue_comment', 'chokepoint-owner', config());
    assert.notDeepEqual(disposition, EZER_NOT_OWNER_DISPOSITION, 'the configured owner passes the gate');
    assert.ok(enqueuedJobs.length > 0, 'and the owner\'s command reaches the dispatcher and enqueues work');
});

test('processCommentEvent is the only consumer of the slash-command parser', async () => {
    // The structural invariant that makes ONE gate sufficient. A second consumer of
    // `parseSlashCommand` would be a second route to the `/ezer` → `/fix` alias that the chokepoint
    // in processCommentEvent does not dominate — exactly the shape of the bug found three times.
    // If this fails, do not add a second guard: move the gate to the new common boundary.
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const roots = ['src', 'packages/core/src', 'packages/api', 'packages/cli', 'scripts'];
    const skipDirectories = new Set(['node_modules', 'dist', 'test', '.git']);
    const consumers: string[] = [];

    async function walk(directory: string): Promise<void> {
        let entries;
        try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!skipDirectories.has(entry.name)) await walk(full);
                continue;
            }
            if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mts')) continue;
            const source = await readFile(full, 'utf8');
            // An import of the parser from anywhere other than its own module or the re-export barrel.
            if (/\bimport\s[^;]*\bparseSlashCommand\b/.test(source)) {
                consumers.push(path.relative(repoRoot, full));
            }
        }
    }
    for (const root of roots) await walk(path.join(repoRoot, root));

    assert.deepEqual(
        consumers.filter(file => !file.endsWith('index.jobs.ts')).sort(),
        ['packages/core/src/webhook/commentEventHandler.ts'],
        'a new consumer of parseSlashCommand is a new route to the /ezer alias — move the chokepoint, do not duplicate it',
    );
});

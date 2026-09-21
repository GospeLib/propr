/**
 * The `/ezer` authorization chokepoint, proved at the boundary itself rather than per intake mode.
 *
 * `processCommentEvent` (packages/core/src/webhook/commentEventHandler.ts) is the only place the
 * `/ezer` address acquires a command meaning: the generally-exported slash parser has no `/ezer`
 * alias at all, and the address is resolved to `/fix` by `resolveOwnerEzerCommandBody`, which
 * yields nothing unless the configured owner wrote the comment. Every route to that dispatcher
 * goes through this one function:
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
 * invariant that makes one gate sufficient — no longer "one import of the parser", which a
 * namespace or dynamic import could evade, but "the parser resolves `/ezer` for nobody".
 */
import { test, mock, before, after } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';
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

test('the shared slash parser resolves /ezer for nobody, through every import shape', async () => {
    // THE load-bearing invariant. It used to be "processCommentEvent is the only consumer of
    // parseSlashCommand", enforced by scanning a hand-picked set of roots for static named
    // imports — which could not see a namespace import, a dynamic import(), a property read off
    // a module namespace, or any file under a root that was not on the list. A second consumer
    // acquiring the `/ezer` -> `/fix` alias through one of those shapes would have kept that test
    // green, which is precisely the incomplete-path-coverage mistake behind three prior bypasses.
    //
    // The alias no longer exists in the shared parser, so reachability of `/ezer` is no longer a
    // question of who imports the parser: NO importer of it can resolve `/ezer`, by any route.
    // This asserts that directly, over the import shapes the old scan was blind to. It fails if
    // anyone puts the alias back into the generally-exported parser.
    const parserSpecifier = '../packages/core/src/webhook/slashCommandParser.js';
    const namespace = await import(parserSpecifier);                       // namespace import
    const dynamic = (await import(parserSpecifier)).parseSlashCommand;     // dynamic import
    const propertyAccess = namespace['parseSlashCommand'];                 // computed property read
    const { parseSlashCommand: staticNamed } = namespace;                  // static named binding

    const hostileBodies = [
        '/ezer take over this pull request',
        '/ezer',
        '/ezer\nPlease fix the failing test',
        '  /ezer do it  ',
    ];
    for (const [shape, parse] of Object.entries({
        'namespace import': namespace.parseSlashCommand,
        'dynamic import': dynamic,
        'computed property access': propertyAccess,
        'static named import': staticNamed,
    })) {
        for (const body of hostileBodies) {
            assert.strictEqual(parse(body), null,
                `${shape} must not resolve ${JSON.stringify(body)} — the shared parser has no /ezer alias`);
        }
        // Non-vacuous: the same function still resolves an ordinary command through that shape.
        assert.strictEqual(parse('/fix do the thing')?.command, 'fix', `${shape}: /fix still parses`);
    }
});

test('the parser module itself carries no /ezer handling, only prose about not having any', async () => {
    // Source-level guard on the ONE module the invariant above depends on. Comments are stripped
    // first, so the explanatory block comment does not satisfy it and a reintroduced
    // `COMMAND_ALIASES = { ezer: 'fix' }` cannot hide as documentation.
    const source = await readFile(
        path.resolve(import.meta.dirname, '../packages/core/src/webhook/slashCommandParser.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.strictEqual(/ezer/i.test(code), false,
        'the generally-exported slash parser must contain no /ezer handling — resolve it inside the authorized boundary instead');
});

test('the public barrel re-exports no value that can resolve a slash command', async () => {
    // A barrel re-export is an import shape a source scan of call sites cannot follow, so the
    // parser is simply not on the public surface. Types are fine: a type carries no behaviour.
    const barrel = await readFile(
        path.resolve(import.meta.dirname, '../packages/core/src/index.jobs.ts'), 'utf8');
    const valueExports = barrel.split('\n').filter(line => /^export\s*\{/.test(line) && !/^export\s+type/.test(line));
    assert.strictEqual(
        valueExports.some(line => /\bparseSlashCommand\b|\bbuildCommandMeta\b/.test(line)), false,
        'do not re-export the slash parser publicly — it widens the set of places a /ezer alias could be reached from',
    );
});

test('/ezer acquires a command meaning only for the configured owner', async () => {
    // The other half: the resolution that replaced the alias is itself authorization-gated, and
    // it reproduces the old alias byte for byte for the owner.
    const { resolveOwnerEzerCommandBody } = await import('../packages/core/src/intake/routingOwnerEvent.js');
    const body = '/ezer address the linting errors';

    assert.strictEqual(resolveOwnerEzerCommandBody({ body, user: HOSTILE_USER }), null,
        'a non-owner /ezer comment resolves to no command at all');
    assert.strictEqual(resolveOwnerEzerCommandBody({ body, user: { ...OWNER_USER, id: OWNER_USER.id + 1 } }), null,
        'a different numeric user id is not the owner');
    assert.strictEqual(resolveOwnerEzerCommandBody({ body, user: { ...HOSTILE_USER, login: OWNER_USER.login } }), null,
        'the owner\'s login on a stranger\'s id is not the owner — identity is the numeric id');

    const resolved = resolveOwnerEzerCommandBody({ body, user: OWNER_USER });
    assert.strictEqual(resolved, '/fix address the linting errors');
    const { parseSlashCommand } = await import('../packages/core/src/webhook/slashCommandParser.js');
    assert.deepEqual(parseSlashCommand(resolved), parseSlashCommand('/fix address the linting errors'),
        'the owner\'s /ezer parses exactly as the old alias made it parse');

    // Multiline and case are preserved exactly as the alias table handled them.
    assert.strictEqual(resolveOwnerEzerCommandBody({ body: '/ezer\nfix the test', user: OWNER_USER }), '/fix\nfix the test');
    assert.strictEqual(resolveOwnerEzerCommandBody({ body: '/ezersomething do a thing', user: OWNER_USER }), null,
        '/ezersomething was never the address and is still not');
    assert.strictEqual(resolveOwnerEzerCommandBody({ body: '/EZER do a thing', user: OWNER_USER }), null,
        'the alias table was case-sensitive; so is this');
});

test('a caller cannot redefine the owner by supplying its own numeric id', async () => {
    // The exported resolver must read the configured owner internally and unconditionally — it
    // must not accept a caller-supplied owner id at all. `resolveOwnerEzerCommandBody` takes a
    // single `comment` parameter now, so there is no second positional argument through which an
    // importer could ever smuggle its own owner id, however it calls the function. We still probe
    // at runtime (via an unsafe cast, since TypeScript itself now refuses the call at compile
    // time) to prove that even a caller who bypasses the type system cannot move the owner.
    const { resolveOwnerEzerCommandBody } = await import('../packages/core/src/intake/routingOwnerEvent.js');
    const hostileWithOwnClaimedId = { id: 123, type: 'User' as const, login: 'drive-by-stranger' };
    const body = '/ezer run hostile work';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bypassAttempt = (resolveOwnerEzerCommandBody as any)(
        { body, user: hostileWithOwnClaimedId },
        '123', // the exact reproduction: try to make the resolver believe id 123 is the owner
    );
    assert.strictEqual(bypassAttempt, null,
        'a non-owner cannot resolve /ezer by supplying their own numeric id as a second argument — ' +
        'the exported resolver ignores any argument beyond `comment` and reads the configured owner itself');

    // Sanity: the same hostile comment is refused through the normal single-argument call too.
    assert.strictEqual(resolveOwnerEzerCommandBody({ body, user: hostileWithOwnClaimedId }), null);
});

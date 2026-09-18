import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const abortSpawnedExecution = mock.fn(async () => {});

await mock.module('../src/claude/docker/dockerExecutionOwnership.js', {
    namedExports: { abortSpawnedExecution },
});

await mock.module('../src/utils/logger.js', {
    defaultExport: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
        debug: mock.fn(),
    },
});

const { setupAbortChecker, checkAbortSignal, clearWorkerAbortSignalWithClient, buildPlannerAbortSignalKey } = await import('../src/claude/docker/dockerAbortController.js');

const OWNED_CONTAINER = 'owned-container';
const REPLACEMENT_CONTAINER = 'replacement-container';
const TASK_ID = 'owned-stop';
const WORKER_KEY = `worker:abort:${TASK_ID}`;
const PLANNER_KEY = `planner:abort:${TASK_ID}`;
const POLL_INTERVAL_MS = 1;
const POLL_WINDOW_MS = 25;

for (const target of [OWNED_CONTAINER, REPLACEMENT_CONTAINER]) {
    test(`existing run-scoped markers target only the owned container: ${target}`, async () => {
        for (const containerId of [OWNED_CONTAINER, REPLACEMENT_CONTAINER]) {
            abortSpawnedExecution.mock.resetCalls();
            const markerKey = buildPlannerAbortSignalKey(TASK_ID, target);
            const markers = new Map([[markerKey, JSON.stringify({ containerId: target })]]);
            const redis = { get: async (key: string) => markers.get(key) ?? null,
                del: mock.fn(async () => 1), quit: async () => undefined, disconnect() {} };
            const handle = setupAbortChecker({ taskId: TASK_ID, plannerAbortKey: PLANNER_KEY,
                child: {} as never, state: { aborted: { value: false }, containerId: { value: containerId }, teardownPromise: null },
                namedContainer: null, redisFactory: () => redis, pollIntervalMs: POLL_INTERVAL_MS });
            try { await delay(POLL_WINDOW_MS); } finally { await handle.close(); }
            assert.equal(abortSpawnedExecution.mock.calls.length > 0, target === containerId);
            assert.equal(markers.has(markerKey), true);
            assert.equal(redis.del.mock.calls.length, 0);
        }
    });
}

for (const containerId of [OWNED_CONTAINER, REPLACEMENT_CONTAINER]) {
    test(`scoped owner stop is observed only by its exact container: ${containerId}`, async () => {
        abortSpawnedExecution.mock.resetCalls();
        const marker = JSON.stringify({ containerId: OWNED_CONTAINER });
        const redis = { get: async (key: string) => key === WORKER_KEY ? marker : null,
            del: mock.fn(async () => 1), quit: async () => undefined, disconnect() {} };
        assert.equal(await checkAbortSignal(TASK_ID, PLANNER_KEY, () => redis), false,
            'a future container must not inherit an already-owned stop');
        const state = { aborted: { value: false }, containerId: { value: containerId }, teardownPromise: null };
        const handle = setupAbortChecker({ taskId: TASK_ID, plannerAbortKey: PLANNER_KEY,
            child: {} as never, state, namedContainer: null, redisFactory: () => redis,
            pollIntervalMs: POLL_INTERVAL_MS });
        try { await delay(POLL_WINDOW_MS); } finally { await handle.close(); }
        assert.equal(abortSpawnedExecution.mock.calls.length > 0, containerId === OWNED_CONTAINER);
        assert.equal(redis.del.mock.calls.length, 0, 'scoped marker remains intact until expiry');
    });
}

test('legacy marker consumption cannot erase a concurrent scoped replacement marker', async () => {
    const observed = JSON.stringify({ requestedBy: 'legacy-owner' });
    const replacement = JSON.stringify({ containerId: REPLACEMENT_CONTAINER });
    let value = observed;
    await clearWorkerAbortSignalWithClient(TASK_ID, {
        get: async () => value,
        eval: async (_script, _keyCount, _key, expected) => {
            value = replacement;
            if (value !== expected) return 0;
            value = ''; return 1;
        },
    });
    assert.equal(value, replacement);
});

test('close waits for an in-flight poll and suppresses its late abort result', async () => {
    let resolveGet!: (value: string | null) => void;
    const getStarted = Promise.withResolvers<void>();
    const pendingGet = new Promise<string | null>(resolve => { resolveGet = resolve; });
    const quit = mock.fn(async () => {});
    const redis = {
        get: mock.fn(async () => {
            getStarted.resolve();
            return await pendingGet;
        }),
        del: mock.fn(async () => 1),
        quit,
        disconnect: mock.fn(),
    };
    const handle = setupAbortChecker({
        taskId: 'task-1748',
        plannerAbortKey: 'planner:abort:task-1748',
        child: { kill: mock.fn(), exitCode: null, signalCode: null } as never,
        state: {
            aborted: { value: false },
            containerId: { value: null },
            teardownPromise: null,
        },
        namedContainer: 'propr-agent-task-1748',
        redisFactory: () => redis,
        pollIntervalMs: 1,
    });

    await getStarted.promise;
    const closePromise = handle.close();
    await Promise.resolve();
    assert.equal(quit.mock.calls.length, 0);

    resolveGet('abort');
    await closePromise;

    assert.equal(abortSpawnedExecution.mock.calls.length, 0);
    assert.equal(quit.mock.calls.length, 1);
});

test('close disconnects after a bounded wait for an unresponsive Redis poll', async () => {
    const getStarted = Promise.withResolvers<void>();
    const pendingGet = new Promise<string | null>(() => {});
    const disconnect = mock.fn();
    const redis = {
        get: mock.fn(async () => {
            getStarted.resolve();
            return await pendingGet;
        }),
        del: mock.fn(async () => 1),
        quit: mock.fn(async () => {}),
        disconnect,
    };
    const handle = setupAbortChecker({
        taskId: 'task-unresponsive-redis',
        plannerAbortKey: 'planner:abort:task-unresponsive-redis',
        child: { kill: mock.fn(), exitCode: null, signalCode: null } as never,
        state: {
            aborted: { value: false },
            containerId: { value: null },
            teardownPromise: null,
        },
        namedContainer: 'propr-agent-task-unresponsive-redis',
        redisFactory: () => redis,
        pollIntervalMs: 1,
        closeTimeoutMs: 10,
    });

    await getStarted.promise;
    await handle.close();

    assert.equal(disconnect.mock.calls.length, 1);
    assert.equal(redis.quit.mock.calls.length, 0);
});

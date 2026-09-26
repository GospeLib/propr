/**
 * EP-ezer-follow-ups-S03 / AC-S03-1 (TC-007) — the executor half.
 *
 * Exercises the real cessation-confirmation path that the abort checker runs
 * after it terminates an execution: actual child and container evidence, the
 * refusal to read an unobservable daemon as "stopped", and the explicit
 * still-running report with a reason and a recovery step.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

interface TeardownTarget {
    taskId?: string;
    attemptGeneration?: string;
    containerId?: string | null;
    containerName?: string | null;
}

const listOwnedExecutionContainers = mock.fn<(target: TeardownTarget, timeoutMs: number) => Promise<string[] | null>>(
    async () => [],
);

const abortSpawnedExecution = mock.fn(
    async (child: { exitCode: number | null }, state: { aborted: { value: boolean } }) => {
        state.aborted.value = true;
        // The real teardown ends the process; reflect that so cessation
        // confirmation observes a genuinely exited child.
        (child as { exitCode: number | null }).exitCode = 137;
    },
);

await mock.module('../src/claude/docker/dockerContainerControl.js', {
    namedExports: {
        listOwnedExecutionContainers,
        teardownDockerExecution: mock.fn(async () => {}),
        stopDockerContainer: mock.fn(async () => ({ success: true })),
    },
});

await mock.module('../src/claude/docker/dockerExecutionOwnership.js', {
    namedExports: { abortSpawnedExecution },
});

await mock.module('../src/utils/logger.js', {
    defaultExport: { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() },
});

const {
    confirmExecutionCessation,
    EZER_CESSATION_CONFIRM_TIMEOUT_MS,
    EZER_CESSATION_POLL_INTERVAL_MS,
} = await import('../src/claude/docker/ep-ezer-follow-ups-s03.js');
const { setupAbortChecker } = await import('../src/claude/docker/dockerAbortController.js');
const { listOwnedExecutionContainers: realListOwnedExecutionContainers } =
    await import('../src/claude/docker/dockerContainerControl.js');

function createClock(): { now: () => number; wait: (ms: number) => Promise<void> } {
    let value = 1_700_000_000_000;
    return {
        now: () => value,
        wait: async (ms: number) => { value += ms; },
    };
}

const EXITED_CHILD = { exitCode: 0, signalCode: null } as const;
const RUNNING_CHILD = { exitCode: null, signalCode: null } as const;

test('the contract design targets are the confirmation defaults', () => {
    assert.equal(EZER_CESSATION_CONFIRM_TIMEOUT_MS, 10_000);
    assert.ok(EZER_CESSATION_POLL_INTERVAL_MS > 0 && EZER_CESSATION_POLL_INTERVAL_MS < 1_000);
});

test('cessation is confirmed once the child exited and no owned container remains', async () => {
    const clock = createClock();
    const report = await confirmExecutionCessation({
        child: EXITED_CHILD,
        taskId: 'task-a',
        attemptGeneration: 'gen-1',
        listContainers: async () => [],
        ...clock,
    });

    assert.equal(report.stopped, true);
    assert.equal(report.childExited, true);
    assert.equal(report.containerEvidence, 'confirmed-absent');
    assert.deepEqual(report.containersRemaining, []);
    assert.equal(report.reason, undefined);
    assert.equal(report.recovery, undefined);
});

test('confirmation keeps polling until an owned container actually disappears', async () => {
    const clock = createClock();
    const observations = [['c1'], ['c1'], []];
    let index = 0;
    const report = await confirmExecutionCessation({
        child: EXITED_CHILD,
        taskId: 'task-b',
        attemptGeneration: 'gen-2',
        listContainers: async () => observations[Math.min(index++, observations.length - 1)],
        ...clock,
    });

    assert.equal(report.stopped, true);
    assert.equal(report.pollCount, 3);
    assert.equal(report.containerEvidence, 'confirmed-absent');
});

test('a still-running child is never reported as stopped, and carries reason and recovery', async () => {
    const clock = createClock();
    const report = await confirmExecutionCessation({
        child: RUNNING_CHILD,
        taskId: 'task-c',
        attemptGeneration: 'gen-3',
        timeoutMs: 1_000,
        listContainers: async () => [],
        ...clock,
    });

    assert.equal(report.stopped, false);
    assert.equal(report.childExited, false);
    assert.match(report.reason!, /had not exited/);
    assert.match(report.recovery!, /Re-issue the stop/);
    assert.ok(report.elapsedMs >= 1_000);
});

test('an unobservable Docker daemon is never read as "no containers remain"', async () => {
    const clock = createClock();
    const report = await confirmExecutionCessation({
        child: EXITED_CHILD,
        taskId: 'task-d',
        attemptGeneration: 'gen-4',
        timeoutMs: 500,
        listContainers: async () => null,
        ...clock,
    });

    assert.equal(report.stopped, false);
    assert.equal(report.containerEvidence, 'unobservable');
    assert.match(report.reason!, /could not be queried/);
    assert.match(report.recovery!, /Restore Docker daemon access/);
});

test('a container still present at the deadline is named in the orphan report', async () => {
    const clock = createClock();
    const report = await confirmExecutionCessation({
        child: EXITED_CHILD,
        containerId: 'orphan1234',
        timeoutMs: 500,
        listContainers: async () => ['orphan1234'],
        ...clock,
    });

    assert.equal(report.stopped, false);
    assert.equal(report.containerEvidence, 'still-present');
    assert.deepEqual(report.containersRemaining, ['orphan1234']);
    assert.match(report.reason!, /orphan1234/);
});

test('without any container selector the child exit alone settles the report', async () => {
    const clock = createClock();
    const report = await confirmExecutionCessation({ child: EXITED_CHILD, ...clock });

    assert.equal(report.stopped, true);
    assert.equal(report.containerEvidence, 'not-applicable');
    assert.equal(report.pollCount, 1);
});

test('container observation is skipped, not faked, when nothing identifies the execution', async () => {
    assert.deepEqual(await realListOwnedExecutionContainers({}), []);
});

test('the abort checker confirms real cessation after terminating an execution', async () => {
    listOwnedExecutionContainers.mock.resetCalls();
    listOwnedExecutionContainers.mock.mockImplementation(async () => []);
    const reports: Array<{ stopped: boolean }> = [];
    const child = { kill: mock.fn(), exitCode: null as number | null, signalCode: null };
    const redis = {
        get: mock.fn(async (key: string) => (key === 'worker:abort:task-stop' ? 'abort' : null)),
        del: mock.fn(async (_key: string) => 1),
        // f730c101: model the compare-delete operation, retaining the deletion assertion.
        eval: async (_script: string, _keyCount: number, key: string, marker: string) => {
            if (await redis.get(key) !== marker) return 0;
            return redis.del(key);
        },
        quit: mock.fn(async () => {}),
        disconnect: mock.fn(),
    };
    const handle = setupAbortChecker({
        taskId: 'task-stop',
        plannerAbortKey: 'planner:abort:task-stop',
        child: child as never,
        state: { aborted: { value: false }, containerId: { value: 'abc123' }, teardownPromise: null },
        namedContainer: 'propr-agent-task-stop',
        attemptGeneration: 'gen-stop',
        redisFactory: () => redis,
        pollIntervalMs: 1,
        cessationTimeoutMs: 200,
        cessationPollIntervalMs: 1,
        onCessation: report => reports.push(report),
    });

    while (reports.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    await handle.close();

    assert.equal(abortSpawnedExecution.mock.calls.length, 1);
    assert.equal(reports[0].stopped, true);
    // The worker abort marker is consumed as part of the same termination.
    assert.ok(redis.del.mock.calls.some(call => call.arguments[0] === 'worker:abort:task-stop'));
});

test('the abort checker reports an unstopped container instead of claiming a stop', async () => {
    listOwnedExecutionContainers.mock.resetCalls();
    listOwnedExecutionContainers.mock.mockImplementation(async () => ['leftover99']);
    const reports: Array<{ stopped: boolean; reason?: string; recovery?: string; containersRemaining: string[] }> = [];
    const child = { kill: mock.fn(), exitCode: null as number | null, signalCode: null };
    const redis = {
        get: mock.fn(async (key: string) => (key === 'worker:abort:task-orphan' ? 'abort' : null)),
        del: mock.fn(async (_key: string) => 1),
        // f730c101: model the compare-delete operation, retaining the deletion assertion.
        eval: async (_script: string, _keyCount: number, key: string, marker: string) => {
            if (await redis.get(key) !== marker) return 0;
            return redis.del(key);
        },
        quit: mock.fn(async () => {}),
        disconnect: mock.fn(),
    };
    const handle = setupAbortChecker({
        taskId: 'task-orphan',
        plannerAbortKey: 'planner:abort:task-orphan',
        child: child as never,
        state: { aborted: { value: false }, containerId: { value: 'leftover99' }, teardownPromise: null },
        namedContainer: null,
        attemptGeneration: 'gen-orphan',
        redisFactory: () => redis,
        pollIntervalMs: 1,
        cessationTimeoutMs: 30,
        cessationPollIntervalMs: 1,
        onCessation: report => reports.push(report),
    });

    while (reports.length === 0) await new Promise(resolve => setTimeout(resolve, 5));
    await handle.close();

    assert.equal(reports[0].stopped, false);
    assert.deepEqual(reports[0].containersRemaining, ['leftover99']);
    assert.match(reports[0].reason!, /still existed/);
    assert.ok(reports[0].recovery);
});

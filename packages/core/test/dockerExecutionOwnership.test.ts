import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { DockerExecutionTeardownOptions } from '../src/claude/docker/dockerContainerControl.js';

const teardownDockerExecution = mock.fn(async (_options: DockerExecutionTeardownOptions) => {});

await mock.module('../src/claude/docker/dockerContainerControl.js', {
    namedExports: { teardownDockerExecution },
});

const {
    abortSpawnedExecution,
    killWorkerProcessGroup,
    WORKER_PROCESS_GROUP_SPAWN_OPTIONS,
} = await import('../src/claude/docker/dockerExecutionOwnership.js');

/**
 * A killed process whose parent died too is reparented to PID 1 and stays
 * visible as a zombie until something reaps it, so `process.kill(pid, 0)` alone
 * reports it as alive. Read the real state and count `Z` as dead.
 */
function isProcessAlive(pid: number): boolean {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }
}

async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) return true;
        await delay(25);
    }
    return false;
}

/**
 * Start a worker that forks a long-lived child and reports its PID, so a test
 * can observe what survives termination rather than assert on the signal call.
 */
async function spawnWorkerLeavingAChild(detached: boolean): Promise<{ worker: ChildProcess; leftBehindPid: number }> {
    const worker = spawn('sh', ['-c', 'sleep 45 & echo "$!"; wait'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(detached ? WORKER_PROCESS_GROUP_SPAWN_OPTIONS : {}),
    });
    const leftBehindPid = await new Promise<number>((resolve, reject) => {
        worker.stdout!.once('data', chunk => resolve(Number(String(chunk).trim())));
        worker.once('error', reject);
    });
    assert.ok(Number.isInteger(leftBehindPid) && leftBehindPid > 0, 'worker did not report its child PID');
    assert.ok(isProcessAlive(leftBehindPid), 'left-behind child should start alive');
    return { worker, leftBehindPid };
}

test('runs a final generation-fenced teardown after fallback child termination', async () => {
    const kill = mock.fn(() => true);
    const scheduleForceKill = mock.fn();
    const childState = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill,
    });
    const child = childState as unknown as ChildProcess;
    const state = {
        aborted: { value: false },
        containerId: { value: 'container-one' },
        teardownPromise: null,
    };

    const teardown = abortSpawnedExecution(child, state, {
        namedContainer: 'propr-agent-task-1748',
        scheduleForceKill,
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
    });

    assert.deepEqual(kill.mock.calls[0]?.arguments, ['SIGTERM']);
    assert.equal(scheduleForceKill.mock.calls.length, 1);
    assert.equal(teardownDockerExecution.mock.calls.length, 1);

    childState.signalCode = 'SIGKILL';
    childState.emit('exit', null, 'SIGKILL');
    await teardown;

    assert.equal(teardownDockerExecution.mock.calls.length, 2);
    assert.deepEqual(teardownDockerExecution.mock.calls[1]?.arguments[0], {
        taskId: 'task-1748',
        attemptGeneration: 'generation-hash',
        containerId: 'container-one',
        containerName: 'propr-agent-task-1748',
    });
});

test('terminating an owned worker kills the process group and the child it left behind', async () => {
    const { worker, leftBehindPid } = await spawnWorkerLeavingAChild(true);
    const state = {
        aborted: { value: false },
        containerId: { value: null as string | null },
        teardownPromise: null,
    };

    await abortSpawnedExecution(worker, state, {
        namedContainer: null,
        scheduleForceKill: () => {},
        taskId: 'task-s16',
        attemptGeneration: 'generation-s16',
    });

    assert.ok(await waitUntilDead(worker.pid!), 'worker process should be dead');
    assert.ok(
        await waitUntilDead(leftBehindPid),
        'child left behind by the worker should be dead once its process group is terminated',
    );
});

test('without process-group ownership the same child survives, so the ownership is what kills it', async () => {
    const { worker, leftBehindPid } = await spawnWorkerLeavingAChild(false);
    try {
        worker.kill('SIGTERM');
        assert.ok(await waitUntilDead(worker.pid!), 'worker process should be dead');
        await delay(250);
        assert.ok(isProcessAlive(leftBehindPid), 'child should outlive a bare single-process kill');
    } finally {
        try { process.kill(leftBehindPid, 'SIGKILL'); } catch { /* already gone */ }
    }
});

test('killWorkerProcessGroup falls back to the direct child when no group is owned', () => {
    const kill = mock.fn(() => true);
    const child = Object.assign(new EventEmitter(), { pid: 4321, kill }) as unknown as ChildProcess;
    const killProcess = mock.fn(() => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); });

    assert.equal(killWorkerProcessGroup(child, 'SIGTERM', killProcess), false);
    assert.deepEqual(killProcess.mock.calls[0]?.arguments, [-4321, 'SIGTERM']);
    assert.deepEqual(kill.mock.calls[0]?.arguments, ['SIGTERM']);
});

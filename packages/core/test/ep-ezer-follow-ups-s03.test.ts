/**
 * EP-ezer-follow-ups-S03 — TC-007 at the execution layer.
 *
 * These tests drive the real production stack: `ExecutionControlRegistry`,
 * `abortSpawnedExecution` with its generation fence, `teardownDockerExecution`
 * and the container observation/suspension helpers all run unmodified. Only
 * the `docker` binary itself is replaced, by a scripted in-memory daemon, so
 * marker/child/container cessation, cancellation races and refusal paths are
 * exercised against actual code rather than a simulation of it.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as nodeChildProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { beforeEach, describe, mock, test } from 'node:test';

interface FakeContainer {
    id: string;
    labels: Record<string, string>;
    paused: boolean;
    /** Simulates a container the daemon refuses to remove. */
    undeletable?: boolean;
}

const docker = {
    containers: new Map<string, FakeContainer>(),
    calls: [] as string[][],
    /** When true, every `docker ps` query fails (daemon unreachable). */
    failPs: false,
    reset(): void {
        docker.containers.clear();
        docker.calls.length = 0;
        docker.failPs = false;
    },
    add(id: string, labels: Record<string, string>, extra: Partial<FakeContainer> = {}): void {
        docker.containers.set(id, { id, labels, paused: false, ...extra });
    },
    callsOf(command: string): string[][] {
        return docker.calls.filter(args => args[0] === command);
    },
};

function matchesLabelFilters(container: FakeContainer, args: string[]): boolean {
    const filters = args.filter((value, index) => args[index - 1] === '--filter');
    return filters.every(filter => {
        const [key, expected] = filter.replace(/^label=/, '').split('=');
        return container.labels[key] === expected;
    });
}

/** Scripted stand-in for `/usr/bin/docker`, faithful to the messages the real
 *  CLI produces for the cases the production code branches on. */
function runFakeDocker(args: string[]): { stdout: string; stderr: string } {
    const [command] = args;
    if (command === 'ps') {
        if (docker.failPs) throw new Error('Cannot connect to the Docker daemon');
        const matching = [...docker.containers.values()].filter(container => matchesLabelFilters(container, args));
        return { stdout: `${matching.map(container => container.id).join('\n')}\n`, stderr: '' };
    }
    const reference = args[args.length - 1];
    const container = docker.containers.get(reference);
    if (command === 'inspect') {
        if (!container) throw new Error(`Error: No such object: ${reference}`);
        return { stdout: `${container.id}\n`, stderr: '' };
    }
    if (command === 'rm') {
        if (!container) throw new Error(`Error: No such container: ${reference}`);
        if (container.undeletable) throw new Error(`Error response from daemon: cannot remove container ${reference}: device busy`);
        docker.containers.delete(reference);
        return { stdout: `${reference}\n`, stderr: '' };
    }
    if (command === 'pause' || command === 'unpause') {
        if (!container) throw new Error(`Error: No such container: ${reference}`);
        const shouldBePaused = command === 'pause';
        if (container.paused === shouldBePaused) {
            throw new Error(`Error response from daemon: Container ${reference} is `
                + (shouldBePaused ? 'already paused' : 'not paused'));
        }
        if (container.undeletable) throw new Error(`Error response from daemon: cannot ${command} container ${reference}`);
        container.paused = shouldBePaused;
        return { stdout: `${reference}\n`, stderr: '' };
    }
    throw new Error(`Error: unsupported fake docker command: ${args.join(' ')}`);
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const execFile = mock.fn((
    _file: string,
    args: string[],
    _options: unknown,
    callback: ExecFileCallback,
) => {
    docker.calls.push([...args]);
    let result: { stdout: string; stderr: string };
    try {
        result = runFakeDocker(args);
    } catch (error) {
        queueMicrotask(() => callback(error as Error, '', (error as Error).message));
        return new EventEmitter() as unknown as ChildProcess;
    }
    queueMicrotask(() => callback(null, result.stdout, result.stderr));
    return new EventEmitter() as unknown as ChildProcess;
});

await mock.module('node:child_process', {
    namedExports: { ...nodeChildProcess, execFile },
});

const { observeExecutionContainers } = await import('../src/claude/docker/dockerContainerControl.js');
const { ExecutionControlRegistry } = await import('../src/claude/docker/ep-ezer-follow-ups-s03.js');
const { createDockerExecutionState } = await import('../src/claude/docker/dockerExecutionOwnership.js');

const TASK_ID = 'task-2301';
const GENERATION = 'generation-a1b2';
const EXECUTION_ID = 'execution-7';
const ATTEMPT_A = 'attempt-a';
const ATTEMPT_B = 'attempt-b';

interface FakeChild extends EventEmitter {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killCalls: NodeJS.Signals[];
    kill(signal?: NodeJS.Signals): boolean;
}

/** A child that ends on SIGTERM, or one that hangs when `exitsOnSignal` is false. */
function createFakeChild(exitsOnSignal = true): FakeChild {
    const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        killCalls: [] as NodeJS.Signals[],
        kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
            child.killCalls.push(signal);
            if (!exitsOnSignal) return true;
            setTimeout(() => {
                child.signalCode = signal;
                child.emit('exit', null, signal);
            }, 0);
            return true;
        },
    });
    return child as FakeChild;
}

interface Harness {
    registry: InstanceType<typeof ExecutionControlRegistry>;
    child: FakeChild;
    markerPublications: string[];
    /** The worker consumes the marker once its child has ended. */
    markerPresent: () => boolean;
}

function createHarness(options: {
    child?: FakeChild | null;
    pauseCapability?: 'suspend' | 'checkpoint' | 'none';
    checkpoint?: () => Promise<{ saved: boolean; detail: string }>;
    deliverSteer?: (delivery: { version: number }) => Promise<void>;
    confirmationTimeoutMs?: number;
    readMarker?: boolean;
} = {}): Harness {
    const child = options.child === undefined ? createFakeChild() : options.child;
    const markerPublications: string[] = [];
    let markerWritten = false;
    const markerPresent = (): boolean => markerWritten
        && !(child !== null && (child.exitCode !== null || child.signalCode !== null));
    const registry = new ExecutionControlRegistry({
        publishAbortMarker: async taskId => {
            markerPublications.push(taskId);
            markerWritten = true;
            return true;
        },
        ...(options.readMarker === false ? {} : { readAbortMarker: async () => markerPresent() }),
        // Deterministic force-kill: the real 5s timer would outlive the test.
        scheduleForceKill: () => undefined,
        confirmationTimeoutMs: options.confirmationTimeoutMs ?? 400,
        pollIntervalMs: 5,
    });
    registry.register({
        executionId: EXECUTION_ID,
        attemptId: ATTEMPT_A,
        taskId: TASK_ID,
        attemptGeneration: GENERATION,
        containerName: 'propr-agent-task-2301',
        child: child as unknown as ChildProcess | null,
        state: child ? createDockerExecutionState() : null,
        pauseCapability: options.pauseCapability ?? 'none',
        ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
        ...(options.deliverSteer
            ? { deliverSteer: options.deliverSteer as (delivery: { version: number }) => Promise<void> }
            : {}),
    });
    return { registry, child: child as FakeChild, markerPublications, markerPresent };
}

beforeEach(() => {
    docker.reset();
    execFile.mock.resetCalls();
});

describe('AC-S03-1 cancellation reaches the real attempt and proves cessation', () => {
    test('confirms a stop only from observed marker, child and container evidence', async () => {
        docker.add('container-one', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        docker.add('container-two', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        // A container owned by a different attempt generation must survive.
        docker.add('container-other', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': 'generation-other' });
        const harness = createHarness();

        const result = await harness.registry.cancel(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'stopped');
        assert.equal(result.joinedInFlight, false);
        assert.deepEqual(result.evidence, {
            markerPublished: true,
            markerCleared: true,
            childExited: true,
            containersRemaining: [],
            containersObserved: true,
            elapsedMs: result.evidence.elapsedMs,
        });
        assert.deepEqual(harness.child.killCalls, ['SIGTERM']);
        assert.deepEqual(harness.markerPublications, [TASK_ID]);
        // The ownership fence, not a blanket task sweep, selected the containers.
        const psArgs = docker.callsOf('ps')[0];
        assert.ok(psArgs.includes(`label=propr.task.id=${TASK_ID}`));
        assert.ok(psArgs.includes(`label=propr.task.attempt-generation=${GENERATION}`));
        const removed = docker.callsOf('rm').map(args => args[args.length - 1]);
        assert.deepEqual([...new Set(removed)].sort(), ['container-one', 'container-two']);
        assert.ok(docker.containers.has('container-other'), 'another generation must not be torn down');
        assert.equal(harness.registry.isFenced(EXECUTION_ID, ATTEMPT_A), true);
    });

    test('reports still-running with reason and recovery when a container survives', async () => {
        docker.add('container-stuck', {
            'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION,
        }, { undeletable: true });
        const harness = createHarness({ confirmationTimeoutMs: 120 });

        const result = await harness.registry.cancel(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'still-running');
        assert.deepEqual(result.evidence.containersRemaining, ['container-stuck']);
        assert.equal(result.evidence.containersObserved, true);
        assert.match(result.reason!, /container\(s\) still present: container-stuck/);
        assert.ok(result.recovery && result.recovery.length > 0);
        // A surviving container is never reported as a stop, and the attempt
        // stays fenced so it cannot publish while it is still dying.
        assert.equal(harness.registry.isFenced(EXECUTION_ID, ATTEMPT_A), true);
    });

    test('reports still-running when container state cannot be observed at all', async () => {
        docker.failPs = true;
        const harness = createHarness({ confirmationTimeoutMs: 120 });

        const result = await harness.registry.cancel(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'still-running');
        assert.equal(result.evidence.containersObserved, false);
        assert.match(result.reason!, /container state could not be observed/);
    });

    test('never claims a stop while the owned child is still alive', async () => {
        const harness = createHarness({ child: createFakeChild(false), confirmationTimeoutMs: 120 });

        const result = await harness.registry.cancel(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'still-running');
        assert.equal(result.evidence.childExited, false);
        assert.equal(result.evidence.containersRemaining.length, 0);
        assert.match(result.reason!, /the owned child process has not exited/);
        assert.match(result.reason!, /the abort marker has not been consumed/);
    });

    test('concurrent cancellations of one attempt propagate once and agree', async () => {
        docker.add('container-one', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        const harness = createHarness();

        const [first, second] = await Promise.all([
            harness.registry.cancel(EXECUTION_ID, ATTEMPT_A),
            harness.registry.cancel(EXECUTION_ID, ATTEMPT_A),
        ]);

        assert.equal(first.outcome, 'stopped');
        assert.equal(second.outcome, 'stopped');
        // One real propagation, one joined report — never two independent
        // teardowns and never a second, fabricated "stopped".
        assert.deepEqual(harness.markerPublications, [TASK_ID]);
        assert.deepEqual(harness.child.killCalls, ['SIGTERM']);
        assert.equal(first.joinedInFlight === false || second.joinedInFlight === false, true);
        assert.equal(first.joinedInFlight === true || second.joinedInFlight === true, true);
        assert.deepEqual(first.evidence.containersRemaining, second.evidence.containersRemaining);
    });

    test('a cancelled attempt is fenced before any replacement exists', async () => {
        docker.add('container-stuck', {
            'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION,
        }, { undeletable: true });
        const harness = createHarness({ confirmationTimeoutMs: 60 });

        const cancellation = harness.registry.cancel(EXECUTION_ID, ATTEMPT_A);
        // Synchronously after the call, with no replacement registered yet.
        assert.equal(harness.registry.isFenced(EXECUTION_ID, ATTEMPT_A), true);
        await cancellation;

        harness.registry.register({
            executionId: EXECUTION_ID,
            attemptId: ATTEMPT_B,
            taskId: TASK_ID,
            attemptGeneration: 'generation-replacement',
        });
        assert.equal(harness.registry.isFenced(EXECUTION_ID, ATTEMPT_A), true);
        assert.equal(harness.registry.isFenced(EXECUTION_ID, ATTEMPT_B), false);
        assert.equal(harness.registry.getActiveAttemptId(EXECUTION_ID), ATTEMPT_B);
    });

    test('a command for a superseded attempt is refused, not redirected', async () => {
        const harness = createHarness();
        harness.registry.register({
            executionId: EXECUTION_ID,
            attemptId: ATTEMPT_B,
            taskId: TASK_ID,
            attemptGeneration: 'generation-replacement',
            pauseCapability: 'suspend',
        });

        const pause = await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);
        const cancel = await harness.registry.cancel(EXECUTION_ID, ATTEMPT_A);

        for (const outcome of [pause, cancel]) {
            assert.equal(outcome.outcome, 'refused');
            assert.equal((outcome as { reason: string }).reason, 'attempt-not-active');
            assert.equal((outcome as { activeAttemptId: string }).activeAttemptId, ATTEMPT_B);
        }
        // The replacement was named for diagnostics only: nothing touched it.
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_B), 'running');
        assert.equal(docker.callsOf('pause').length, 0);
        assert.equal(docker.callsOf('rm').length, 0);
        assert.deepEqual(harness.markerPublications, []);
    });

    test('a completed attempt is not re-cancelled and claims no stop', async () => {
        const harness = createHarness();
        harness.registry.complete(EXECUTION_ID, ATTEMPT_A);

        const result = await harness.registry.cancel(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'attempt-completed');
        assert.deepEqual(harness.markerPublications, []);
    });
});

describe('AC-S03-1 pause refusal, safe checkpoint and one-only resume', () => {
    test('refuses to pause an execution that supports neither suspend nor checkpoint', async () => {
        docker.add('container-one', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        const harness = createHarness({ pauseCapability: 'none' });

        const result = await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'pause-unsupported');
        assert.match((result as { detail: string }).detail, /still running and was not paused/);
        assert.ok((result as { recovery: string }).recovery.length > 0);
        // No paused claim and no container was touched.
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_A), 'running');
        assert.equal(docker.callsOf('pause').length, 0);
    });

    test('suspends every owned container in place and resumes exactly once', async () => {
        docker.add('container-one', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        docker.add('container-two', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        const harness = createHarness({ pauseCapability: 'suspend' });

        const paused = await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);

        assert.equal(paused.outcome, 'suspended');
        assert.deepEqual((paused as { suspendedContainers: string[] }).suspendedContainers,
            ['container-one', 'container-two']);
        assert.ok((paused as { caveat?: string }).caveat, 'a suspension must disclose what it does not stop');
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_A), 'suspended');
        assert.equal(docker.containers.get('container-one')!.paused, true);
        assert.equal(docker.containers.get('container-two')!.paused, true);

        // Steering a suspended attempt is accepted-but-not-applied, never applied.
        const steered = await harness.registry.steer(EXECUTION_ID, ATTEMPT_A, 1, { instruction: 'focus tests' });
        assert.equal(steered.outcome, 'refused');
        assert.equal((steered as { reason: string }).reason, 'attempt-suspended');

        const resumed = await harness.registry.resume(EXECUTION_ID, ATTEMPT_A);
        assert.equal(resumed.outcome, 'resumed');
        assert.equal((resumed as { mode: string }).mode, 'unpaused');
        assert.equal(docker.containers.get('container-one')!.paused, false);
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_A), 'running');

        const second = await harness.registry.resume(EXECUTION_ID, ATTEMPT_A);
        assert.equal(second.outcome, 'refused');
        assert.equal((second as { reason: string }).reason, 'not-paused');
        // Exactly one unpause per container: no duplicate continuation.
        assert.equal(docker.callsOf('unpause').length, 2);
    });

    test('concurrent resumes of a suspended attempt thaw it once', async () => {
        docker.add('container-one', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        const harness = createHarness({ pauseCapability: 'suspend' });
        await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);

        const [first, second] = await Promise.all([
            harness.registry.resume(EXECUTION_ID, ATTEMPT_A),
            harness.registry.resume(EXECUTION_ID, ATTEMPT_A),
        ]);

        const outcomes = [first.outcome, second.outcome].sort();
        assert.deepEqual(outcomes, ['refused', 'resumed']);
        assert.equal(docker.callsOf('unpause').length, 1);
    });

    test('rolls back a partial suspension instead of claiming a pause', async () => {
        docker.add('container-one', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        docker.add('container-two', {
            'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION,
        }, { undeletable: true });
        const harness = createHarness({ pauseCapability: 'suspend' });

        const result = await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'suspend-failed');
        assert.match((result as { detail: string }).detail, /still running and was not paused/);
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_A), 'running');
        // The container frozen before the failure was thawed again.
        assert.equal(docker.containers.get('container-one')!.paused, false);
        assert.equal(docker.callsOf('unpause').length, 1);
    });

    test('refuses to suspend when the daemon cannot be queried', async () => {
        docker.failPs = true;
        const harness = createHarness({ pauseCapability: 'suspend' });

        const result = await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'no-container-to-suspend');
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_A), 'running');
    });

    test('checkpoints and stops, then yields exactly one continuation', async () => {
        docker.add('container-one', { 'propr.task.id': TASK_ID, 'propr.task.attempt-generation': GENERATION });
        const harness = createHarness({
            pauseCapability: 'checkpoint',
            checkpoint: async () => {
                // A real checkpoint saves state and lets the container stop.
                docker.containers.delete('container-one');
                return { saved: true, detail: 'Saved partial analysis at step 4 of 9.' };
            },
        });

        const paused = await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);

        assert.equal(paused.outcome, 'checkpointed');
        assert.equal((paused as { persistedState: string }).persistedState, 'Saved partial analysis at step 4 of 9.');
        assert.deepEqual((paused as { evidence: { containersRemaining: string[] } }).evidence.containersRemaining, []);
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_A), 'checkpointed');

        const first = await harness.registry.resume(EXECUTION_ID, ATTEMPT_A);
        assert.equal(first.outcome, 'resumed');
        assert.equal((first as { mode: string }).mode, 'continuation');
        assert.ok((first as { continuationToken?: string }).continuationToken);

        const second = await harness.registry.resume(EXECUTION_ID, ATTEMPT_A);
        assert.equal(second.outcome, 'refused');
        assert.equal((second as { reason: string }).reason, 'already-resumed');
    });

    test('refuses the pause when the owner saved no checkpoint', async () => {
        const harness = createHarness({
            pauseCapability: 'checkpoint',
            checkpoint: async () => ({ saved: false, detail: 'no safe checkpoint before step 2' }),
        });

        const result = await harness.registry.pause(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'checkpoint-failed');
        assert.equal(harness.registry.getStatus(EXECUTION_ID, ATTEMPT_A), 'running');
    });

    test('refuses to resume an attempt that was never paused', async () => {
        const harness = createHarness();

        const result = await harness.registry.resume(EXECUTION_ID, ATTEMPT_A);

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'not-paused');
    });
});

describe('AC-S03-2 steering delivery at the execution layer', () => {
    test('delivers a revision to the running attempt in version order', async () => {
        const delivered: number[] = [];
        const harness = createHarness({
            deliverSteer: async delivery => { delivered.push(delivery.version); },
        });

        const first = await harness.registry.steer(EXECUTION_ID, ATTEMPT_A, 1, { instruction: 'a' });
        const second = await harness.registry.steer(EXECUTION_ID, ATTEMPT_A, 2, { instruction: 'b' });

        assert.equal(first.outcome, 'delivered');
        assert.equal(second.outcome, 'delivered');
        assert.deepEqual(delivered, [1, 2]);
    });

    test('reports a revision as not applied when the attempt has no steering transport', async () => {
        const harness = createHarness();

        const result = await harness.registry.steer(EXECUTION_ID, ATTEMPT_A, 1, { instruction: 'a' });

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'steer-unsupported');
        assert.match((result as { detail: string }).detail, /accepted but not applied/);
    });

    test('reports a rejected delivery instead of claiming it was applied', async () => {
        const harness = createHarness({
            deliverSteer: async () => { throw new Error('agent stdin closed'); },
        });

        const result = await harness.registry.steer(EXECUTION_ID, ATTEMPT_A, 1, { instruction: 'a' });

        assert.equal(result.outcome, 'refused');
        assert.equal((result as { reason: string }).reason, 'steer-delivery-failed');
        assert.match((result as { detail: string }).detail, /agent stdin closed/);
    });
});

describe('container observation cannot manufacture an absence', () => {
    test('reports the state as unobserved when nothing identifies the containers', async () => {
        const observation = await observeExecutionContainers({ taskId: TASK_ID });

        assert.equal(observation.observed, false);
        assert.deepEqual(observation.present, []);
        assert.match(observation.error!, /No container identifiers/);
    });

    test('observes a named container directly when no generation fence exists', async () => {
        docker.add('propr-agent-task-2301', {});

        const present = await observeExecutionContainers({ containerName: 'propr-agent-task-2301' });
        docker.containers.delete('propr-agent-task-2301');
        const absent = await observeExecutionContainers({ containerName: 'propr-agent-task-2301' });

        assert.deepEqual(present, { observed: true, present: ['propr-agent-task-2301'] });
        assert.deepEqual(absent, { observed: true, present: [] });
    });
});

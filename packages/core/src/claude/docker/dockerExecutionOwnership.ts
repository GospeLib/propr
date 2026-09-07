import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { teardownDockerExecution } from './dockerContainerControl.js';

interface ExecutionOwnershipContext {
    signal: AbortSignal;
    /** One-way identifier for the PR attempt that owns this container. */
    attemptGeneration?: string;
}

export interface SpawnedExecutionState {
    aborted: { value: boolean };
    containerId: { value: string | null };
    teardownPromise: Promise<void> | null;
}

export interface DockerExecutionState extends SpawnedExecutionState {
    timedOut: boolean;
    sessionIdDetected: boolean;
    containerIdDetected: boolean;
}

export class ExecutionAbortedError extends Error {
    constructor(message: string = 'Execution aborted by user request') {
        super(message);
        this.name = 'ExecutionAbortedError';
    }
}

export function createDockerExecutionState(): DockerExecutionState {
    return {
        timedOut: false,
        aborted: { value: false },
        sessionIdDetected: false,
        containerIdDetected: false,
        containerId: { value: null },
        teardownPromise: null,
    };
}

export function getExecutionAbortError(signal?: AbortSignal): Error | null {
    if (!signal?.aborted) return null;
    return signal.reason instanceof Error ? signal.reason : new ExecutionAbortedError();
}

interface AbortSpawnedExecutionOptions {
    namedContainer: string | null;
    scheduleForceKill: (child: ChildProcess) => void;
    taskId?: string;
    attemptGeneration?: string;
}

const executionOwnershipContext = new AsyncLocalStorage<ExecutionOwnershipContext>();

function waitForChildTermination(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
        child.once('exit', () => resolve());
    });
}

/**
 * Spawn options that make the worker its own process-group leader.
 *
 * Without this, signalling the `docker` CLI leaves anything it forked — and
 * anything the agent forked through it — reparented to init and still running.
 * Owning the group is what lets {@link killWorkerProcessGroup} take the whole
 * tree down and lets the caller observe a left-behind child die.
 */
export const WORKER_PROCESS_GROUP_SPAWN_OPTIONS = { detached: true } as const;

/**
 * Signal the worker's whole process group, falling back to the single process
 * when the group is already gone or was never created.
 *
 * Returns true when the group signal landed, so callers can tell group
 * ownership from a bare child kill.
 */
export function killWorkerProcessGroup(
    child: ChildProcess,
    signal: NodeJS.Signals,
    killProcess: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): boolean {
    const pid = child.pid;
    if (typeof pid === 'number' && pid > 0) {
        try {
            // Negative PID addresses the process group led by `pid`.
            killProcess(-pid, signal);
            return true;
        } catch {
            // ESRCH: the group is already gone. Anything else: fall through to
            // the direct kill below so termination still happens.
        }
    }
    child.kill(signal);
    return false;
}

/** Milliseconds between the group SIGTERM and the group SIGKILL. */
export const WORKER_PROCESS_GROUP_FORCE_KILL_MS = 5000;

/**
 * SIGKILL the whole group if a graceful stop left anything behind.
 *
 * The caller-supplied force kill only reaches the direct child, so a grandchild
 * the agent forked would survive it. This sweep is what makes the
 * left-behind-child observation hold.
 */
export function scheduleWorkerProcessGroupForceKill(
    child: ChildProcess,
    delayMs: number = WORKER_PROCESS_GROUP_FORCE_KILL_MS,
): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => killWorkerProcessGroup(child, 'SIGKILL'), delayMs);
    timer.unref();
    return timer;
}

export function runWithExecutionAbortSignal<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
    attemptGeneration?: string,
): Promise<T> {
    return executionOwnershipContext.run({ signal, attemptGeneration }, operation);
}

export function getExecutionOwnershipContext(): ExecutionOwnershipContext | undefined {
    return executionOwnershipContext.getStore();
}

export function abortSpawnedExecution(
    child: ChildProcess,
    state: SpawnedExecutionState,
    options: AbortSpawnedExecutionOptions,
): Promise<void> {
    if (state.aborted.value) return state.teardownPromise ?? Promise.resolve();
    state.aborted.value = true;
    const teardownOptions = {
        taskId: options.taskId,
        attemptGeneration: options.attemptGeneration,
        containerId: state.containerId.value,
        containerName: options.namedContainer,
    };
    const hasGenerationFence = Boolean(options.taskId && options.attemptGeneration);
    const childTermination = hasGenerationFence ? waitForChildTermination(child) : null;
    killWorkerProcessGroup(child, 'SIGTERM');
    options.scheduleForceKill(child);
    scheduleWorkerProcessGroupForceKill(child);
    state.teardownPromise = (async () => {
        await teardownDockerExecution(teardownOptions);
        if (childTermination) {
            await childTermination;
            // Once SIGTERM or the fallback SIGKILL has ended `docker run`, use
            // a fresh observation window to catch its last creation-race work.
            await teardownDockerExecution(teardownOptions);
        }
    })();
    return state.teardownPromise;
}

export function addTaskAttemptLabelsToDockerArgs(
    args: string[],
    taskId: string | undefined,
    attemptGeneration: string | undefined,
): string[] {
    if (args[0] !== 'run' || !taskId) return args;
    return [
        'run',
        '--label', `propr.task.id=${taskId}`,
        ...(attemptGeneration
            ? ['--label', `propr.task.attempt-generation=${attemptGeneration}`]
            : []),
        ...args.slice(1),
    ];
}

export function resolveExecutionArgs(
    command: string,
    args: string[],
    taskId: string | undefined,
    attemptGeneration: string | undefined,
): string[] {
    return command === 'docker'
        ? addTaskAttemptLabelsToDockerArgs(args, taskId, attemptGeneration)
        : args;
}

export function getDockerRunContainerName(args: string[]): string | null {
    const nameIndex = args.indexOf('--name');
    return nameIndex >= 0 && args[nameIndex + 1] ? args[nameIndex + 1] : null;
}

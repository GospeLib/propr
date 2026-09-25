import { execFile } from 'node:child_process';
import logger from '../../utils/logger.js';

const DOCKER_PATH = '/usr/bin/docker';
const CONTAINER_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MAX_STOP_TIMEOUT_SECONDS = 300;
const RETAINED_CONTAINER_STOP_TIMEOUT = '0';
const DEFAULT_CREATION_RACE_ATTEMPTS = 10;
const DEFAULT_CREATION_RACE_RETRY_MS = 250;
const DEFAULT_TEARDOWN_DEADLINE_MS = 4000;
const MAX_TEARDOWN_DEADLINE_MS = 10000;
const STOPPED_CONTAINER_STATUSES = new Set(['exited', 'dead']);
const STOP_INSPECTION_FORMAT = '{"id":{{json .Id}},"autoRemove":{{json .HostConfig.AutoRemove}},"state":{{json .State}}}';
const STOP_COMMAND_SLACK_SECONDS = 5;
const MILLISECONDS_PER_SECOND = 1000;

export interface DockerStopResult {
    success: boolean;
    error?: string;
    cessation?: DockerExecutionCessation;
}
interface DockerStopInspection { id: string; autoRemove: boolean; state: DockerContainerTerminalState }

function validateStopInspection(before: DockerStopInspection): void {
    if (!CONTAINER_IDENTIFIER_PATTERN.test(before.id) || typeof before.autoRemove !== 'boolean' ||
        typeof before.state?.Running !== 'boolean' || typeof before.state?.Status !== 'string')
        throw Error('Incomplete Docker stop inspection');
}

export function isStoppedDockerContainerState(state: Pick<DockerContainerTerminalState, 'Running' | 'Status'>): boolean {
    return !state.Running && STOPPED_CONTAINER_STATUSES.has(state.Status);
}

function validateStopRequest(containerId: string, timeoutSeconds: number): string | undefined {
    if (!containerId) return 'No container ID provided';
    if (!CONTAINER_IDENTIFIER_PATTERN.test(containerId)) return 'Invalid Docker container identifier';
    if (!Number.isInteger(timeoutSeconds)
        || timeoutSeconds < 0
        || timeoutSeconds > MAX_STOP_TIMEOUT_SECONDS) {
        return `Docker stop timeout must be an integer between 0 and ${MAX_STOP_TIMEOUT_SECONDS} seconds`;
    }
    return undefined;
}

function runDocker(args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            DOCKER_PATH,
            args,
            { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve(stdout);
                    return;
                }
                const detail = (stderr || stdout || error.message).trim();
                reject(new Error(detail || error.message, { cause: error }));
            },
        );
    });
}

function waitForRetry(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function removeStoppedContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
    try {
        await runDocker(['rm', '-f', containerId], 10000);
        return { success: true };
    } catch (error) {
        const message = (error as Error).message;
        if (message.includes('No such container') || message.includes('No such object')) {
            return { success: true };
        }
        return { success: false, error: message };
    }
}

async function forceRemoveContainer(containerId: string): Promise<{ success: boolean; error?: string }> {
    try {
        await runDocker(['kill', containerId], 10000);
        const removed = await removeStoppedContainer(containerId);
        if (removed.success) logger.info({ containerId }, 'Docker container force killed and removed');
        else logger.error({ containerId, error: removed.error }, 'Docker container was killed but could not be removed');
        return removed;
    } catch (killError) {
        const message = (killError as Error).message;
        if (message.includes('No such container')) {
            logger.info({ containerId }, 'Container already removed');
            return { success: true };
        }
        if (message.includes('is not running')) {
            const removed = await removeStoppedContainer(containerId);
            if (removed.success) logger.info({ containerId }, 'Removed container that stopped during termination');
            return removed;
        }
        logger.error({ containerId, error: message }, 'Failed to force kill Docker container');
        return { success: false, error: message };
    }
}

export interface DockerExecutionTeardownOptions {
    preserveTerminalEvidence?: boolean;
    taskId?: string;
    attemptGeneration?: string;
    containerId?: string | null;
    containerName?: string | null;
    attempts?: number;
    retryDelayMs?: number;
    deadlineMs?: number;
}
export type DockerExecutionCessation = 'stopped' | 'running' | 'absent' | 'unavailable' | 'not-applicable';
export interface DockerContainerTerminalState {
    Running: boolean;
    Status: string;
    ExitCode: number;
    OOMKilled: boolean;
    Error: string;
    FinishedAt: string;
}

export async function inspectDockerTerminalState(identifier: string): Promise<DockerContainerTerminalState> {
    if (!CONTAINER_IDENTIFIER_PATTERN.test(identifier)) throw new Error('Invalid Docker container identifier');
    const output = await runDocker(['inspect', '--format', '{{json .State}}', identifier], DEFAULT_TEARDOWN_DEADLINE_MS);
    const state = JSON.parse(output) as DockerContainerTerminalState;
    if (typeof state.Running !== 'boolean' || typeof state.Status !== 'string'
        || !Number.isInteger(state.ExitCode) || typeof state.OOMKilled !== 'boolean'
        || typeof state.Error !== 'string' || typeof state.FinishedAt !== 'string')
        throw new Error('Docker terminal state is incomplete');
    return state;
}

/** Remove only after the caller has durably checkpointed observed terminal state. */
export async function removeDockerTerminalContainer(identifier: string): Promise<void> {
    if (!CONTAINER_IDENTIFIER_PATTERN.test(identifier)) throw new Error('Invalid Docker container identifier');
    await runDocker(['rm', identifier], DEFAULT_TEARDOWN_DEADLINE_MS);
}

/** Absence is evidence only when the daemon query itself succeeds. */
async function observeContainer(identifier: string): Promise<DockerExecutionCessation | 'removing'> {
    try {
        const state = await inspectDockerTerminalState(identifier);
        return state.Running ? 'running' : isStoppedDockerContainerState(state) ? 'stopped'
            : state.Status === 'removing' ? 'removing' : 'unavailable';
    } catch (error) {
        return /No such (container|object)/.test((error as Error).message) ? 'absent' : 'unavailable';
    }
}

export async function observeDockerExecutionCessation(options: DockerExecutionTeardownOptions): Promise<DockerExecutionCessation> {
    if (!options.containerName && !options.containerId) return 'not-applicable';
    try {
        if (options.taskId && options.attemptGeneration) {
            const output = await runDocker(['ps', '-aq',
                '--filter', `label=propr.task.id=${options.taskId}`,
                '--filter', `label=propr.task.attempt-generation=${options.attemptGeneration}`,
            ], DEFAULT_TEARDOWN_DEADLINE_MS);
            const identifiers = output.trim().split('\n').filter(Boolean);
            if (!identifiers.length) return 'absent';
            const observations = await Promise.all(identifiers.map(observeContainer));
            if (observations.includes('running')) return 'running';
            if (observations.includes('unavailable') || observations.includes('removing')) return 'unavailable';
            return observations.includes('stopped') ? 'stopped' : 'absent';
        }
        const observed = await observeContainer(options.containerId ?? options.containerName!);
        return observed === 'removing' ? 'unavailable' : observed;
    } catch {
        return 'unavailable';
    }
}

async function findExecutionContainers(
    options: DockerExecutionTeardownOptions,
    timeoutMs: number,
): Promise<Set<string> | null> {
    const containers = new Set<string>();
    if (options.taskId && options.attemptGeneration) {
        try {
            const output = await runDocker([
                'ps', '-aq',
                '--filter', `label=propr.task.id=${options.taskId}`,
                '--filter', `label=propr.task.attempt-generation=${options.attemptGeneration}`,
            ], timeoutMs);
            for (const id of output.split('\n').map(value => value.trim()).filter(Boolean)) {
                containers.add(id);
            }
            return containers;
        } catch (error) {
            logger.debug({
                taskId: options.taskId,
                attemptGeneration: options.attemptGeneration,
                error: (error as Error).message,
            }, 'Could not inspect Docker containers while closing an aborted execution');
            return null;
        }
    }
    if (options.containerId) containers.add(options.containerId);
    if (options.containerName) containers.add(options.containerName);
    return containers;
}

interface ContainerRemovalResult {
    failed: Set<string>;
    notFound: Set<string>;
}

function hasCompletedContainerRemoval(
    options: DockerExecutionTeardownOptions,
    removal: ContainerRemovalResult,
): boolean {
    if (removal.failed.size > 0) return false;
    const hasGenerationFence = Boolean(options.taskId && options.attemptGeneration);
    // A successful generation-fenced batch does not prove that `docker run`
    // cannot publish another owned container on a later observation.
    if (hasGenerationFence) return false;
    const onlyContainerNameAvailable = !hasGenerationFence && !options.containerId && Boolean(options.containerName);
    return !onlyContainerNameAvailable
        || !options.containerName
        || !removal.notFound.has(options.containerName);
}

async function removeExecutionContainers(containers: Set<string>, deadline: number, preserveTerminalEvidence = false): Promise<ContainerRemovalResult> {
    const failed = new Set<string>();
    const notFound = new Set<string>();
    for (const container of containers) {
        if (!CONTAINER_IDENTIFIER_PATTERN.test(container)) continue;
        const removalBudgetMs = Math.min(2000, deadline - Date.now());
        if (removalBudgetMs <= 0) {
            failed.add(container);
            continue;
        }
        try {
            await runDocker(preserveTerminalEvidence ? ['stop', '-t', RETAINED_CONTAINER_STOP_TIMEOUT, container] : ['rm', '-f', container], removalBudgetMs);
        } catch (error) {
            const message = (error as Error).message;
            if (message.includes('No such container') || message.includes('No such object')) {
                notFound.add(container);
            } else {
                failed.add(container);
                logger.warn({ containerId: container, error: message }, 'Failed to remove Docker container after execution ownership loss');
            }
        }
    }
    return { failed, notFound };
}

async function retryExecutionContainerRemoval(
    options: DockerExecutionTeardownOptions,
    attempts: number,
    retryDelayMs: number,
    deadline: number,
): Promise<void> {
    let discoveryAttempts = 0;
    let failedRemovals = new Set<string>();
    while (Date.now() < deadline
        && (discoveryAttempts < attempts || failedRemovals.size > 0)) {
        const containers = new Set(failedRemovals);
        if (discoveryAttempts < attempts) {
            const inspectionBudgetMs = Math.min(1000, deadline - Date.now());
            if (inspectionBudgetMs <= 0) break;
            const discovered = await findExecutionContainers(options, inspectionBudgetMs);
            discoveryAttempts++;
            // A failed daemon query cannot discover a creation race. Known
            // failed removals remain directly retryable by identifier.
            if (!discovered && containers.size === 0) break;
            for (const container of discovered ?? []) containers.add(container);
        }

        if (containers.size > 0) {
            const removal = await removeExecutionContainers(containers, deadline, options.preserveTerminalEvidence);
            failedRemovals = removal.failed;
            if (hasCompletedContainerRemoval(options, removal)) return;
        }

        if (discoveryAttempts < attempts || failedRemovals.size > 0) {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            const failureRetryDelayMs = failedRemovals.size > 0
                ? Math.max(50, retryDelayMs)
                : retryDelayMs;
            if (failureRetryDelayMs > 0) {
                await waitForRetry(Math.min(failureRetryDelayMs, remainingMs));
            }
        }
    }
    if (failedRemovals.size > 0) {
        logger.error({
            containerIds: [...failedRemovals],
            taskId: options.taskId,
            attemptGeneration: options.attemptGeneration,
        }, 'Docker execution teardown deadline expired before all containers were removed');
    }
}

/**
 * Lists the containers that still exist for an owned execution so a stop can be
 * confirmed against real daemon state instead of assumed from the stop command.
 *
 * Returns `null` when the daemon could not be queried: an unobservable daemon
 * must never be read as "no containers remain", because that would let a caller
 * claim a false stop or miss an orphan (EP-ezer-follow-ups-S03).
 */
export async function listOwnedExecutionContainers(
    options: DockerExecutionTeardownOptions,
    timeoutMs = 2000,
): Promise<string[] | null> {
    const selectors: string[][] = [];
    if (options.taskId && options.attemptGeneration) {
        selectors.push([
            '--filter', `label=propr.task.id=${options.taskId}`,
            '--filter', `label=propr.task.attempt-generation=${options.attemptGeneration}`,
        ]);
    }
    if (options.containerId && CONTAINER_IDENTIFIER_PATTERN.test(options.containerId)) {
        selectors.push(['--filter', `id=${options.containerId}`]);
    }
    if (options.containerName && CONTAINER_IDENTIFIER_PATTERN.test(options.containerName)) {
        selectors.push(['--filter', `name=^${options.containerName}$`]);
    }
    if (selectors.length === 0) return [];
    const remaining = new Set<string>();
    for (const selector of selectors) {
        try {
            const output = await runDocker(['ps', '-aq', ...selector], Math.max(250, timeoutMs));
            for (const id of output.split('\n').map(value => value.trim()).filter(Boolean)) {
                remaining.add(id);
            }
        } catch (error) {
            logger.debug({
                taskId: options.taskId,
                attemptGeneration: options.attemptGeneration,
                error: (error as Error).message,
            }, 'Could not observe Docker containers while confirming execution cessation');
            return null;
        }
    }
    return [...remaining];
}

/**
 * Removes every container belonging to an aborted execution, retrying long
 * enough to cover the window in which `docker run` has reached the daemon but
 * the container has not appeared in `docker ps` yet.
 */
export async function teardownDockerExecution(
    options: DockerExecutionTeardownOptions,
): Promise<void> {
    const attempts = Math.max(1, Math.min(20, options.attempts ?? DEFAULT_CREATION_RACE_ATTEMPTS));
    const retryDelayMs = Math.max(0, Math.min(1000, options.retryDelayMs ?? DEFAULT_CREATION_RACE_RETRY_MS));
    const deadlineMs = Math.max(100, Math.min(
        MAX_TEARDOWN_DEADLINE_MS,
        options.deadlineMs ?? DEFAULT_TEARDOWN_DEADLINE_MS,
    ));
    const deadline = Date.now() + deadlineMs;
    const hasGenerationFence = Boolean(options.taskId && options.attemptGeneration);
    if (!hasGenerationFence && !options.containerId && !options.containerName) return;
    await retryExecutionContainerRemoval(options, attempts, retryDelayMs, deadline);
}

/** Reclamation cannot negate a terminal observation or claim an unstarted run executed. */
async function reclaimObservedContainer(identifier: string, cessation: 'stopped' | 'absent'): Promise<DockerStopResult> {
    try {
        await removeDockerTerminalContainer(identifier);
        return { success: true, cessation };
    } catch (error) {
        const message = (error as Error).message;
        if (/No such (container|object)/.test(message)) return { success: true, cessation };
        if (cessation === 'stopped') return { success: true, cessation,
            ...(/removal .*already in progress/.test(message) ? {} : { error: message }) };
        return { success: false, cessation: 'unavailable', error: message };
    }
}

function acknowledgedAutoRemoval(before: DockerStopInspection,
    observed: DockerExecutionCessation | 'removing', stopAcknowledged: boolean): boolean {
    return before.autoRemove && before.state.Running && stopAcknowledged && (observed === 'absent' || observed === 'removing');
}

/** Observe the exact execution separately from its later non-force reclamation. */
async function stopObservedContainer(containerId: string, timeoutSeconds: number, preserveTerminalEvidence: boolean): Promise<DockerStopResult> {
    let before: DockerStopInspection;
    try {
        before = JSON.parse(await runDocker(['inspect', '--format', STOP_INSPECTION_FORMAT, containerId], DEFAULT_TEARDOWN_DEADLINE_MS));
        validateStopInspection(before);
    } catch (error) {
        const absent = /No such (container|object)/.test((error as Error).message);
        return { success: absent && !preserveTerminalEvidence, cessation: absent ? 'absent' : 'unavailable', error: (error as Error).message };
    }
    if (!preserveTerminalEvidence && !before.state.Running && before.state.Status === 'created')
        return reclaimObservedContainer(before.id, 'absent');
    if (!before.state.Running && !isStoppedDockerContainerState(before.state))
        return { success: false, cessation: 'unavailable', error: `Container has not reached a running or terminal state: ${before.state.Status}` };
    let stopAcknowledged = false;
    if (before.state.Running) {
        try {
            await runDocker(['stop', '-t', String(timeoutSeconds), before.id],
                (timeoutSeconds + STOP_COMMAND_SLACK_SECONDS) * MILLISECONDS_PER_SECOND);
            stopAcknowledged = true;
        } catch (error) { logger.warn({ containerId: before.id, error: (error as Error).message }, 'Docker stop command did not acknowledge cessation'); }
    }
    const observed = await observeContainer(before.id);
    // Auto-remove destroys State. Only a pre-observed running exact ID plus the
    // daemon's successful stop acknowledgement proves we stopped that execution.
    const stopped = observed === 'stopped' || (!preserveTerminalEvidence && acknowledgedAutoRemoval(before, observed, stopAcknowledged));
    if (!stopped) return { success: observed === 'absent' && !preserveTerminalEvidence,
        cessation: observed === 'removing' ? 'unavailable' : observed, error: `Observed container cessation is ${observed}` };
    if (!preserveTerminalEvidence && observed === 'stopped') return reclaimObservedContainer(before.id, 'stopped');
    return { success: true, cessation: 'stopped' };
}

export async function stopDockerContainer(
    containerId: string,
    timeoutSeconds: number = 10,
    options: Pick<DockerExecutionTeardownOptions, 'preserveTerminalEvidence'> & { requireObservedCessation?: boolean } = {},
): Promise<DockerStopResult> {
    const validationError = validateStopRequest(containerId, timeoutSeconds);
    if (validationError) return { success: false, error: validationError };
    if (options.preserveTerminalEvidence || options.requireObservedCessation) {
        return stopObservedContainer(containerId, timeoutSeconds, options.preserveTerminalEvidence === true);
    }

    logger.info({ containerId, timeoutSeconds }, 'Attempting to stop Docker container');
    try {
        let statusOutput: string | undefined;
        try {
            statusOutput = (await runDocker([
                'inspect', '--type', 'container', '--format', '{{.State.Status}}', containerId,
            ], 5000)).trim();
        } catch (checkError) {
            if ((checkError as Error).message.includes('No such')) {
                logger.info({ containerId }, 'Container no longer exists');
                return { success: true };
            }
            logger.debug({ containerId, error: (checkError as Error).message }, 'Could not check container status, attempting stop anyway');
        }
        // Restarting and paused containers are still live resources. Remove
        // terminal/non-started containers so deterministic names are reusable.
        if (statusOutput && /^(exited|dead|created)$/iu.test(statusOutput)) {
            const removed = await removeStoppedContainer(containerId);
            if (removed.success) {
                logger.info({ containerId, status: statusOutput }, 'Removed abandoned non-running container');
                return { success: true };
            }
            logger.error({ containerId, status: statusOutput, error: removed.error }, 'Failed to remove abandoned non-running container');
            return removed;
        }

        try {
            await runDocker(
                ['stop', '-t', String(timeoutSeconds), containerId],
                (timeoutSeconds + 5) * 1000,
            );
            const removed = await removeStoppedContainer(containerId);
            if (removed.success) logger.info({ containerId }, 'Docker container stopped and removed gracefully');
            else logger.error({ containerId, error: removed.error }, 'Docker container stopped but could not be removed');
            return removed;
        } catch (stopError) {
            logger.warn({ containerId, error: (stopError as Error).message }, 'Graceful stop failed, attempting force kill');
            return await forceRemoveContainer(containerId);
        }
    } catch (error) {
        const message = (error as Error).message;
        logger.error({ containerId, error: message }, 'Error stopping Docker container');
        return { success: false, error: message };
    }
}

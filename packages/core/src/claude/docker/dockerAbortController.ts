import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Redis } from 'ioredis';
import logger from '../../utils/logger.js';
import {
    abortSpawnedExecution,
    type SpawnedExecutionState,
} from './dockerExecutionOwnership.js';

export interface AbortCheckerOptions {
    taskId: string;
    plannerAbortKey: string;
    child: ChildProcess;
    state: SpawnedExecutionState;
    namedContainer: string | null;
    attemptGeneration?: string;
    redisFactory?: AbortRedisFactory;
    pollIntervalMs?: number;
    closeTimeoutMs?: number;
}

export interface AbortCheckerHandle {
    close(): Promise<void>;
}

interface PlannerAbortContext {
    draftId: string;
    runId: string;
}

export interface AbortRedisClient {
    get(key: string): Promise<string | null>;
    del(key: string): Promise<unknown>;
    quit(): Promise<unknown>;
    disconnect(): void;
    eval?(script: string, keyCount: number, ...args: string[]): Promise<unknown>;
}

export type AbortRedisFactory = () => AbortRedisClient;

const plannerAbortContext = new AsyncLocalStorage<PlannerAbortContext>();
const PLANNER_ABORT_LOOKUP_FAILURE_LIMIT = 2;
const DEFAULT_ABORT_REDIS_TIMEOUT_MS = 5000;
const CONSUME_EXACT_WORKER_ABORT = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('del', KEYS[1])
`;

export function buildPlannerAbortSignalKey(draftId: string, runId?: string): string {
    return runId ? `planner:abort:${draftId}:run:${runId}` : `planner:abort:${draftId}`;
}

export function runWithPlannerAbortContext<T>(
    draftId: string,
    runId: string,
    operation: () => Promise<T>
): Promise<T> {
    return plannerAbortContext.run({ draftId, runId }, operation);
}

export function plannerAbortSignalKeyForTask(taskId: string): string {
    const context = plannerAbortContext.getStore();
    return context
        ? buildPlannerAbortSignalKey(context.draftId, context.runId)
        : buildPlannerAbortSignalKey(taskId);
}

export function buildPlannerAbortRedisOptions() {
    return {
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        connectTimeout: DEFAULT_ABORT_REDIS_TIMEOUT_MS,
        commandTimeout: DEFAULT_ABORT_REDIS_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        retryStrategy: (attempts: number) => attempts <= 1 ? 100 : null,
    };
}

function createAbortRedis(): AbortRedisClient {
    return new Redis(buildPlannerAbortRedisOptions());
}

async function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            operation.then(() => true, () => false),
            new Promise<false>(resolve => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export async function closeAbortRedis(
    redis: AbortRedisClient,
    timeoutMs = DEFAULT_ABORT_REDIS_TIMEOUT_MS,
): Promise<void> {
    if (await settlesWithin(Promise.resolve().then(() => redis.quit()), timeoutMs)) return;
    try { redis.disconnect(); } catch { /* best-effort fallback */ }
}

async function readAbortSignal(
    redis: AbortRedisClient,
    taskId: string,
    plannerAbortKey: string,
    containerId?: string | null,
): Promise<boolean> {
    const [workerAbort, plannerAbort, containerAbort] = await Promise.all([
        redis.get(`worker:abort:${taskId}`),
        redis.get(plannerAbortKey),
        containerId ? redis.get(buildPlannerAbortSignalKey(taskId, containerId)) : Promise.resolve(null),
    ]);
    return (workerAbort !== null && workerAbortTargetsContainer(workerAbort, containerId)) || plannerAbort !== null || containerAbort !== null;
}

/** Legacy worker markers stop the task; admitted markers stop only the named execution. */
function workerAbortContainer(marker: string): string | undefined {
    try {
        const payload = JSON.parse(marker) as { containerId?: unknown };
        return typeof payload?.containerId === 'string' ? payload.containerId : undefined;
    } catch { return undefined; }
}

function workerAbortTargetsContainer(marker: string, containerId?: string | null): boolean {
    const target = workerAbortContainer(marker);
    return target === undefined || target === containerId;
}

export async function checkAbortSignal(
    taskId: string,
    plannerAbortKey: string,
    factory: AbortRedisFactory = createAbortRedis
): Promise<boolean> {
    const redis = factory();
    try {
        return await readAbortSignal(redis, taskId, plannerAbortKey);
    } catch (error) {
        throw new Error(`Abort state unavailable for task ${taskId}`, { cause: error });
    } finally {
        await closeAbortRedis(redis);
    }
}

/** Consumes only the worker abort signal; planner markers remain until expiry. */
export async function clearWorkerAbortSignal(
    taskId: string,
    factory: AbortRedisFactory = createAbortRedis
): Promise<void> {
    const redis = factory();
    try {
        await clearWorkerAbortSignalWithClient(taskId, redis);
        logger.debug({ taskId }, 'Cleared worker abort signal from Redis');
    } catch (err) {
        logger.warn({ taskId, error: (err as Error).message }, 'Failed to clear worker abort signal from Redis');
    } finally {
        await closeAbortRedis(redis);
    }
}

export async function clearWorkerAbortSignalWithClient(taskId: string, redis: Pick<AbortRedisClient, 'get' | 'eval'>,
    expectedMarker?: string): Promise<void> {
    try {
        const marker = await redis.get(`worker:abort:${taskId}`);
        if (expectedMarker !== undefined && marker !== expectedMarker) return;
        // Scoped markers expire naturally. Neither a stale executor nor an API stop
        // may delete a newer execution's signal; they are not task-global mailboxes.
        if (marker !== null && workerAbortContainer(marker) !== undefined) return;
        if (marker === null) return;
        if (!redis.eval) throw Error('Atomic worker abort consumption unavailable');
        await redis.eval(CONSUME_EXACT_WORKER_ABORT, 1, `worker:abort:${taskId}`, marker);
        logger.debug({ taskId }, 'Cleared worker abort signal from Redis');
    } catch (err) {
        logger.warn({ taskId, error: (err as Error).message }, 'Failed to clear worker abort signal from Redis');
    }
}

export function scheduleForceKill(child: ChildProcess): void {
    const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
    timer.unref();
}

/** Fails closed after sustained planner cancellation lookup failures. */
export function shouldTerminateAfterAbortLookupFailure(
    plannerAbortKey: string,
    consecutiveFailures: number,
): boolean {
    return plannerAbortKey.includes(':run:')
        && consecutiveFailures >= PLANNER_ABORT_LOOKUP_FAILURE_LIMIT;
}

export function setupAbortChecker({
    taskId,
    plannerAbortKey,
    child,
    state,
    namedContainer,
    attemptGeneration,
    redisFactory = createAbortRedis,
    pollIntervalMs = 2000,
    closeTimeoutMs = DEFAULT_ABORT_REDIS_TIMEOUT_MS,
}: AbortCheckerOptions): AbortCheckerHandle {
    const redis = redisFactory();
    let pollInFlight = false;
    let active = true;
    let consecutiveLookupFailures = 0;
    let closePromise: Promise<void> | null = null;
    let pollPromise: Promise<void> | null = null;
    const terminateExecution = async (message: string): Promise<void> => {
        if (state.aborted.value) return;
        logger.info({ taskId, containerId: state.containerId.value || namedContainer }, message);
        await abortSpawnedExecution(
            child,
            state,
            { namedContainer, scheduleForceKill, taskId, attemptGeneration },
        );
        await clearWorkerAbortSignalWithClient(taskId, redis);
    };
    const interval = setInterval(() => {
        if (pollInFlight) return;
        pollInFlight = true;
        pollPromise = (async () => {
            const shouldAbort = await readAbortSignal(redis, taskId, plannerAbortKey, state.containerId.value);
            if (!active) return;
            consecutiveLookupFailures = 0;
            if (shouldAbort) await terminateExecution('Abort signal detected, terminating execution');
        })().catch(async error => {
            if (!active) return;
            consecutiveLookupFailures += 1;
            logger.error({ taskId, plannerAbortKey, error: (error as Error).message }, 'Abort state unavailable; cancellation cannot be verified');
            if (shouldTerminateAfterAbortLookupFailure(plannerAbortKey, consecutiveLookupFailures)) {
                await terminateExecution('Planner abort state unavailable, terminating execution fail closed');
            }
        }).finally(() => {
            pollInFlight = false;
            pollPromise = null;
        });
    }, pollIntervalMs);
    return {
        close: async () => {
            closePromise ??= (async () => {
                active = false;
                clearInterval(interval);
                const pollSettled = !pollPromise || await settlesWithin(pollPromise, closeTimeoutMs);
                if (!pollSettled) {
                    logger.warn({ taskId, closeTimeoutMs }, 'Abort checker Redis poll did not settle before shutdown');
                    try { redis.disconnect(); } catch { /* best-effort fallback */ }
                    return;
                }
                await closeAbortRedis(redis, closeTimeoutMs);
            })();
            await closePromise;
        }
    };
}

import { Redis } from 'ioredis';
import logger, { generateCorrelationId } from './logger.js';
import { db } from '../db/connection.js';
import type { Logger } from 'pino';
import {
    TaskStates, type TaskState, type IssueRef, type TaskStateData, type UpdateMetadata,
    type ResumableTaskInfo, type TaskStateExpectation,
    type NonTerminalTaskScanResult,
    type TaskStateUpdateResult,
    type WorkerStateManagerOptions
} from './workerStateManager.types.js';
import { getEventPublisher } from './eventPublisher.js';
import {
    buildTaskStateTransition,
    buildTaskStateMutation,
    compareAndSetTaskStateData,
    compareAndSetTaskState,
    publishAndReconcileTaskTransition,
    publishTaskTransitionEvent,
    cancellationMetadata,
    MAX_ATOMIC_UPDATE_ATTEMPTS,
    waitForAtomicUpdateRetry,
} from './workerStateTransition.js';
import { scanNonTerminalTaskStates } from './workerStateScan.js';
import { persistHistoryMetadata } from './workerStateHistoryMetadata.js';
import { persistTaskAdmission } from './workerStateAdmission.js';
import { certifyDurableCompletion } from './durableCompletionBarrier.js';

const TERMINAL_TASK_STATES = new Set<TaskState>([
    TaskStates.COMPLETED,
    TaskStates.FAILED,
    TaskStates.CANCELLED,
]);

export { TaskStates, type TaskState, type IssueRef };

/**
 * Worker state manager for persistent task state tracking
 */
export class WorkerStateManager {
    private redis: InstanceType<typeof Redis>;
    private keyPrefix: string;
    private stateExpiry: number;

    constructor(options: WorkerStateManagerOptions = {}) {
        this.redis = new Redis({
            host: process.env.REDIS_HOST ?? '127.0.0.1',
            port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            ...options.redis
        });
        this.keyPrefix = options.keyPrefix ?? 'worker:state:';
        this.stateExpiry = options.stateExpiry ?? 7 * 24 * 3600;
        this.redis.on('error', (error: Error) => {
            logger.error({ error: error.message }, 'Redis error in WorkerStateManager');
        });
    }

    /**
     * Creates a task state entry
     * @param taskId - Unique task identifier
     * @param issueRef - GitHub issue reference
     * @param correlationId - Correlation ID for tracking
     * @returns Task state data
     */
    async createTaskState(taskId: string, issueRef: IssueRef, correlationId: string | null = null,
        policy: Pick<UpdateMetadata, 'requireDurableHistory'> = {}): Promise<TaskStateData> {
        const timestamp = new Date().toISOString();
        const state: TaskStateData = {
            taskId, issueRef, correlationId: correlationId ?? generateCorrelationId(),
            state: TaskStates.PENDING, createdAt: timestamp,
            updatedAt: timestamp, version: 1, attempts: 0,
            history: [{ state: TaskStates.PENDING, timestamp, reason: 'Task created' }]
        };
        const key = this.getTaskKey(taskId);
        if (!policy.requireDurableHistory)
            await this.redis.setex(key, this.stateExpiry, JSON.stringify(state));
        const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
        correlatedLogger.info({
            taskId, issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`, state: TaskStates.PENDING
        }, 'Task state created');

        let databasePersisted = false;
        try {
            const repository = await persistTaskAdmission(state, policy.requireDurableHistory
                ? () => this.redis.setex(key, this.stateExpiry, JSON.stringify(state)) : undefined);
            databasePersisted = true;
            correlatedLogger.debug({ taskId }, 'Task state persisted to database');

            // Publish real-time event for task creation
            const eventPublisher = getEventPublisher();
            await eventPublisher.publishTaskUpdate({
                taskId,
                state: TaskStates.PENDING,
                repository,
                issueNumber: issueRef.number,
                timestamp: state.updatedAt,
                version: state.version,
            });
        } catch (error) {
            correlatedLogger.error({ error: (error as Error).message, taskId }, 'Failed to persist task state to database');
            if (policy.requireDurableHistory && !databasePersisted) throw error;
        }
        return state;
    }

    /**
     * Updates task state
     * @param taskId - Task identifier
     * @param newState - New state
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async updateTaskState(taskId: string, newState: TaskState, metadata: UpdateMetadata = {}): Promise<TaskStateData> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

            const current = JSON.parse(stateJson) as TaskStateData;
            const isExplicitFailedRetry = current.state === TaskStates.FAILED
                && newState === TaskStates.PROCESSING
                && metadata.isRetry === true;
            if (TERMINAL_TASK_STATES.has(current.state)
                && current.state !== newState
                && !isExplicitFailedRetry) {
                logger.warn({ taskId, currentState: current.state, requestedState: newState },
                    'Ignored state transition from a terminal task');
                if (metadata.requireDurableHistory) throw Error('Durable transition from terminal task refused');
                return current;
            }

            const transition = buildTaskStateTransition(current, newState, metadata);
            const updated = await compareAndSetTaskStateData(this.redis, {
                key,
                stateExpiry: this.stateExpiry,
                currentJson: stateJson,
                state: transition.state,
            });
            if (updated) {
                await publishAndReconcileTaskTransition(this.redis, {
                    taskId, key, stateExpiry: this.stateExpiry, current, transition, metadata,
                });
                return transition.state;
            }
            await waitForAtomicUpdateRetry(attempt);
        }
        throw new Error(`Task state update conflicted ${MAX_ATOMIC_UPDATE_ATTEMPTS} times for taskId: ${taskId}`);
    }

    /**
     * Updates task state only if it has not changed since it was read.
     * @returns Updated state, or null when the expectation no longer matches
     */
    async updateTaskStateIfCurrent(
        taskId: string,
        expectation: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata = {},
    ): Promise<TaskStateData | null> {
        const result = await this.updateTaskStateIfCurrentDetailed(
            taskId,
            expectation,
            newState,
            metadata,
        );
        return result?.state ?? null;
    }

    /**
     * Conditional state update with explicit database/event publication status.
     */
    async updateTaskStateIfCurrentDetailed(
        taskId: string,
        expectation: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata = {},
    ): Promise<TaskStateUpdateResult | null> {
        const mutation = await compareAndSetTaskState(this.redis, {
            key: this.getTaskKey(taskId),
            stateExpiry: this.stateExpiry,
            expectation,
            newState,
            metadata,
        });
        if (!mutation) return null;
        const { current, transition } = mutation;
        const publication = await publishAndReconcileTaskTransition(this.redis, {
            taskId, key: this.getTaskKey(taskId), stateExpiry: this.stateExpiry, current, transition, metadata,
        });
        return { state: transition.state, publication };
    }

    /**
     * Catches the projection up to a completion the durable history ALREADY proves.
     *
     * This publishes no completion of its own: it re-reads the completed row for the caller's
     * exact transition identity and can only proceed with the capability that read mints, so a
     * caller that did not run the execution — a reconciliation, a queue-event finalizer — can
     * relay a completion but never assert one. Nothing is appended to `task_history`; only the
     * Redis snapshot and the realtime event are brought into line.
     *
     * An evidence-free completion appended here is the exact defect this replaces: the barrier's
     * re-published transition was rejected by the unique index, the rejection was swallowed,
     * Redis stayed nonterminal, and the next finalizer read that as "unsettled" and wrote a
     * second, unkeyed completed row whose metadata carried no execution evidence at all.
     */
    async projectDurableCompletion(taskId: string, options: {
        transitionId: string;
        reason?: string;
        historyMetadata?: Record<string, unknown>;
    }): Promise<'projected' | 'already_completed' | 'terminal_conflict' | 'task_missing'> {
        const completionGuard = await certifyDurableCompletion(taskId, options.transitionId);
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) return 'task_missing';
            const current = JSON.parse(stateJson) as TaskStateData;
            if (current.state === TaskStates.COMPLETED) return 'already_completed';
            if (TERMINAL_TASK_STATES.has(current.state)) {
                logger.error({ taskId, currentState: current.state, transitionId: options.transitionId },
                    'A durable completion cannot be projected over a different terminal state');
                return 'terminal_conflict';
            }
            const metadata: UpdateMetadata = {
                completionGuard,
                transitionId: options.transitionId,
                reason: options.reason,
                historyMetadata: options.historyMetadata,
            };
            const transition = buildTaskStateTransition(current, TaskStates.COMPLETED, metadata);
            const updated = await compareAndSetTaskStateData(this.redis, {
                key, stateExpiry: this.stateExpiry, currentJson: stateJson, state: transition.state,
            });
            if (!updated) {
                await waitForAtomicUpdateRetry(attempt);
                continue;
            }
            await publishTaskTransitionEvent(taskId, transition, metadata,
                { historyPersisted: true, eventPublished: false, errors: [] });
            return 'projected';
        }
        throw new Error(`Durable completion projection conflicted ${MAX_ATOMIC_UPDATE_ATTEMPTS} times for taskId: ${taskId}`);
    }

    /**
     * Gets task state
     * @param taskId - Task identifier
     * @returns Task state or null if not found
     */
    async getTaskState(taskId: string): Promise<TaskStateData | null> {
        const key = this.getTaskKey(taskId);
        const stateJson = await this.redis.get(key);
        if (!stateJson) return null;
        return JSON.parse(stateJson) as TaskStateData;
    }

    /** Retained cancellation is authoritative for this exact task, including late job redelivery. */
    async getTaskCancellation(taskId: string): Promise<Record<string, unknown> | null> {
        const current = await this.getTaskState(taskId);
        if (current?.state === TaskStates.CANCELLED) return { ...current.history.at(-1) };
        const recorded = await db('task_history').where({ task_id: taskId, state: TaskStates.CANCELLED })
            .orderBy('timestamp', 'desc').first();
        if (!recorded) return null;
        return { ...recorded, metadata: typeof recorded.metadata === 'string' ? JSON.parse(recorded.metadata) : recorded.metadata };
    }

    /**
     * Updates issue reference metadata without changing the task state.
     * @param taskId - Task identifier
     * @param issueRefPatch - Issue reference fields to merge
     * @returns Updated state, or null if no state exists
     */
    async updateIssueRef(taskId: string, issueRefPatch: Partial<IssueRef>): Promise<TaskStateData | null> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) return null;

            const current = JSON.parse(stateJson) as TaskStateData;
            const state = buildTaskStateMutation(current, next => {
                next.issueRef = { ...next.issueRef, ...issueRefPatch };
            });
            const updated = await compareAndSetTaskStateData(this.redis, {
                key,
                stateExpiry: this.stateExpiry,
                currentJson: stateJson,
                state,
            });
            if (!updated) {
                await waitForAtomicUpdateRetry(attempt);
                continue;
            }

            const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
            correlatedLogger.info({
                taskId,
                issueNumber: state.issueRef.number,
                repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                updatedFields: Object.keys(issueRefPatch),
                version: state.version,
            }, 'Task issue reference updated');

            try {
                await getEventPublisher().publishTaskUpdate({
                    taskId,
                    state: state.state,
                    repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                    issueNumber: state.issueRef.number,
                    timestamp: state.updatedAt,
                    version: state.version,
                    metadata: {
                        issueRefUpdated: true,
                        updatedFields: Object.keys(issueRefPatch)
                    }
                });
            } catch (error) {
                correlatedLogger.warn({ error: (error as Error).message, taskId }, 'Failed to publish issue reference update event');
            }
            return state;
        }
        throw new Error(`Task issue reference update conflicted ${MAX_ATOMIC_UPDATE_ATTEMPTS} times for taskId: ${taskId}`);
    }

    /**
     * Checks if task can be resumed after worker restart
     * @param taskId - Task identifier
     * @returns Resumable task info or null
     */
    async getResumableTask(taskId: string): Promise<ResumableTaskInfo | null> {
        const state = await this.getTaskState(taskId);
        if (!state) return null;

        const resumableStates: TaskState[] = [TaskStates.PROCESSING, TaskStates.CLAUDE_EXECUTION, TaskStates.POST_PROCESSING];
        if (!resumableStates.includes(state.state)) return null;

        const staleThreshold = 30 * 60 * 1000;
        const updatedAt = new Date(state.updatedAt).getTime();
        const now = Date.now();

        if (now - updatedAt > staleThreshold) {
            logger.warn({
                taskId, correlationId: state.correlationId, issueNumber: state.issueRef.number,
                state: state.state, lastUpdate: state.updatedAt, staleDuration: now - updatedAt
            }, 'Found stale task that may need recovery');
            return { ...state, isStale: true, staleDuration: now - updatedAt };
        }
        return { ...state, isStale: false };
    }

    /**
     * Updates metadata for a specific history entry
     * @param taskId - Task identifier
     * @param historyState - State name to find in history
     * @param metadata - Metadata to merge
     * @returns Updated state
     */
    async updateHistoryMetadata(taskId: string, historyState: TaskState, metadata: Record<string, unknown> = {},
        policy: Pick<UpdateMetadata, 'requireDurableHistory'> = {}): Promise<TaskStateData> {
        const key = this.getTaskKey(taskId);
        for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_ATTEMPTS; attempt++) {
            const stateJson = await this.redis.get(key);
            if (!stateJson) throw new Error(`Task state not found for taskId: ${taskId}`);

            const current = JSON.parse(stateJson) as TaskStateData;
            const historyIndex = current.history.findLastIndex(h => h.state === historyState);
            if (historyIndex < 0) {
                if (policy.requireDurableHistory) throw Error('Durable history entry required for metadata checkpoint');
                logger.warn({ taskId, historyState }, 'Could not find history entry to update metadata');
                return current;
            }

            const state = buildTaskStateMutation(current, next => {
                next.history[historyIndex].metadata = {
                    ...next.history[historyIndex].metadata,
                    ...metadata,
                };
            });
            const updated = await compareAndSetTaskStateData(this.redis, {
                key,
                stateExpiry: this.stateExpiry,
                currentJson: stateJson,
                state,
            });
            if (!updated) {
                await waitForAtomicUpdateRetry(attempt);
                continue;
            }

            const correlatedLogger: Logger = logger.withCorrelation(state.correlationId);
            correlatedLogger.debug({ taskId, historyState, metadata, version: state.version }, 'Updated history metadata');

            try {
                const persisted = await persistHistoryMetadata(
                    {
                        taskId,
                        historyState,
                        historyTimestamp: state.history[historyIndex].timestamp,
                        metadata,
                    },
                    {
                        maxAttempts: MAX_ATOMIC_UPDATE_ATTEMPTS,
                        waitForRetry: waitForAtomicUpdateRetry,
                    },
                );
                if (!persisted) {
                    if (policy.requireDurableHistory) throw Error('Durable database history entry required for metadata checkpoint');
                    correlatedLogger.warn({ taskId, historyState }, 'Could not find database history entry to update metadata');
                }
            } catch (error) {
                correlatedLogger.warn({ error: (error as Error).message, taskId, historyState }, 'Failed to persist history metadata update');
                if (policy.requireDurableHistory) throw error;
            }

            // Publish real-time event for metadata update so UI can refresh
            try {
                await getEventPublisher().publishTaskUpdate({
                    taskId,
                    state: state.state,
                    repository: `${state.issueRef.repoOwner}/${state.issueRef.repoName}`,
                    issueNumber: state.issueRef.number,
                    timestamp: state.updatedAt,
                    version: state.version,
                    metadata: {
                        metadataUpdate: true,
                        updatedFields: Object.keys(metadata)
                    }
                });
            } catch (error) {
                correlatedLogger.warn({ error: (error as Error).message, taskId }, 'Failed to publish metadata update event');
            }
            return state;
        }
        throw new Error(`Task history metadata update conflicted ${MAX_ATOMIC_UPDATE_ATTEMPTS} times for taskId: ${taskId}`);
    }

    /**
     * Marks task as failed
     * @param taskId - Task identifier
     * @param error - Error that caused failure
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async markTaskFailed(taskId: string, error: Error, metadata: UpdateMetadata = {}): Promise<TaskStateData> {
        const errorMetadata: UpdateMetadata = {
            ...metadata,
            error: { message: error.message, category: metadata.errorCategory ?? 'unknown' },
            reason: `Task failed: ${error.message}`
        };
        return await this.updateTaskState(taskId, TaskStates.FAILED, errorMetadata);
    }

    /**
     * Marks task as cancelled (stopped by user request)
     * @param taskId - Task identifier
     * @param cancelledBy - Who/what cancelled the task (e.g., 'user', 'system', username)
     * @param metadata - Additional metadata
     * @returns Updated state
     */
    async markTaskCancelled(taskId: string, cancelledBy: string = 'user', metadata: UpdateMetadata = {}): Promise<TaskStateData> {
        return await this.updateTaskState(taskId, TaskStates.CANCELLED, cancellationMetadata(cancelledBy, metadata));
    }

    /** Returns null on ownership mismatch; throws if strict durable settlement fails. */
    async markTaskCancelledIfCurrent(taskId: string, expectation: TaskStateExpectation,
        cancelledBy: string = 'user', metadata: UpdateMetadata = {}): Promise<TaskStateData | null> {
        if (TERMINAL_TASK_STATES.has(expectation.state) && expectation.state !== TaskStates.CANCELLED) return null;
        const result = await this.updateTaskStateIfCurrentDetailed(taskId, expectation, TaskStates.CANCELLED,
            cancellationMetadata(cancelledBy, { ...metadata, requireDurableHistory: true }));
        return result?.state ?? null;
    }

    /*
     * `markTaskCompleted` is deliberately absent.
     *
     * It was a keyless, evidence-free completion writer on the public state-manager API: anything
     * holding a state manager could publish the signal a consumer re-dispatches on, with no
     * execution evidence and no idempotency key. Completions are published through the durability
     * barrier (`publishCompletedWithDurableExecutionEvidence`), and a path that genuinely ran no
     * model execution publishes with `nonExecutingCompletionGuard`. Do not reintroduce it.
     */

    /**
     * Gets all tasks in processing states (for recovery)
     * @returns Array of processing tasks
     */
    async getProcessingTasks(): Promise<TaskStateData[]> {
        const pattern = `${this.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        const processingTasks: TaskStateData[] = [];

        for (const key of keys) {
            try {
                const stateJson = await this.redis.get(key);
                if (!stateJson) continue;
                const state: TaskStateData = JSON.parse(stateJson);
                const processingStates: TaskState[] = [TaskStates.PROCESSING, TaskStates.CLAUDE_EXECUTION, TaskStates.POST_PROCESSING];
                if (processingStates.includes(state.state)) processingTasks.push(state);
            } catch (error) {
                logger.warn({ key, error: (error as Error).message }, 'Failed to parse task state during recovery scan');
            }
        }
        return processingTasks;
    }

    /**
     * Reads one bounded Redis SCAN page for crash recovery without blocking
     * Redis with KEYS. Callers retain nextCursor between reconciliation runs.
     */
    async scanNonTerminalTasks(cursor = '0', count = 100): Promise<NonTerminalTaskScanResult> {
        return scanNonTerminalTaskStates(this.redis, this.keyPrefix, cursor, count);
    }

    /**
     * Clears completed and failed tasks older than specified time
     * @param maxAge - Maximum age in seconds (default: 24 hours)
     * @returns Number of tasks cleaned up
     */
    async cleanupOldTasks(maxAge: number = 24 * 3600): Promise<number> {
        const pattern = `${this.keyPrefix}*`;
        const keys = await this.redis.keys(pattern);
        let cleanedCount = 0;
        const cutoffTime = Date.now() - (maxAge * 1000);

        for (const key of keys) {
            try {
                const stateJson = await this.redis.get(key);
                if (!stateJson) continue;
                const state: TaskStateData = JSON.parse(stateJson);
                const cleanupStates: TaskState[] = [TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED];
                if (cleanupStates.includes(state.state)) {
                    const updatedAt = new Date(state.updatedAt).getTime();
                    if (updatedAt < cutoffTime) {
                        await this.redis.del(key);
                        cleanedCount++;
                        logger.debug({ taskId: state.taskId, state: state.state, age: Date.now() - updatedAt }, 'Cleaned up old task state');
                    }
                }
            } catch (error) {
                logger.warn({ key, error: (error as Error).message }, 'Failed to cleanup task state');
            }
        }
        logger.info({ cleanedCount, totalKeys: keys.length, maxAge }, 'Task state cleanup completed');
        return cleanedCount;
    }

    /**
     * Generates task key
     * @param taskId - Task identifier
     * @returns Redis key
     */
    getTaskKey(taskId: string): string {
        return `${this.keyPrefix}${taskId}`;
    }

    /**
     * Closes Redis connection
     */
    async close(): Promise<void> {
        this.redis.disconnect();
    }
}

/**
 * Creates a singleton instance of WorkerStateManager
 */
let stateManagerInstance: WorkerStateManager | null = null;

export function getStateManager(options: WorkerStateManagerOptions = {}): WorkerStateManager {
    if (!stateManagerInstance) stateManagerInstance = new WorkerStateManager(options);
    return stateManagerInstance;
}

export async function closeStateManager(): Promise<void> {
    if (stateManagerInstance) {
        await stateManagerInstance.close();
        stateManagerInstance = null;
    }
}

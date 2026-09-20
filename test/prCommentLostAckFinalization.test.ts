/**
 * The lost-ack path, end to end: barrier read-back, Redis rollback, the BullMQ `completed` event,
 * and the finalizer that runs on it.
 *
 * The failure this reproduces is the one that re-dispatched a delivered story six times. The
 * completed history row COMMITS and its acknowledgement is lost, so the strict write rolls the
 * Redis projection back and throws. The barrier reads the row back by its claimed identity and
 * correctly concludes the task is completed — but the projection it then tries to catch up fails
 * (a transient Redis error is enough), so Redis is still nonterminal when the job's `completed`
 * event reaches the finalizer.
 *
 * The finalizer used to treat that as "nothing has settled this task yet" and append a SECOND
 * completed row: no transition key, and history metadata with no execution evidence on it at all.
 * A value-only consumer reading the latest entry sees a completion that proves nothing and
 * re-dispatches the work.
 *
 * What must hold instead: exactly ONE completed history row for the run, carrying the execution
 * evidence, with the projection relayed — never minted — from the identity the executing path
 * durably claimed.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';

const TASK_STATES = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    CLAUDE_EXECUTION: 'claude_execution',
    POST_PROCESSING: 'post_processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
} as const;

const ERROR_CATEGORIES = { POST_PROCESSING: 'post_processing', UNKNOWN: 'unknown' } as const;

const TASK_ID = 'pr-comment-4711-lost-ack';
const TASK_KEY = `worker:state:${TASK_ID}`;
const JOB_ID = TASK_ID;
const OPERATION_IDENTITY = `pr-comment-job:${JOB_ID}`;
const EXECUTION_TIME_MS = 4_321;

// ---------------------------------------------------------------- Redis double

const redisStore = new Map<string, string>();
/** 1-based indices of `get` calls that reject, to inject a transient Redis failure precisely. */
const failingGetCalls = new Set<number>();
let getCalls = 0;
const redis = {
    get: async (key: string) => {
        getCalls++;
        if (failingGetCalls.has(getCalls)) throw new Error('redis is momentarily unavailable');
        return redisStore.get(key) ?? null;
    },
    setex: async (key: string, _expiry: number, value: string) => { redisStore.set(key, value); return 'OK'; },
    eval: async (_script: string, _keyCount: number, key: string, currentJson: string, _expiry: number, nextJson: string) => {
        if (redisStore.get(key) !== currentJson) return 0;
        redisStore.set(key, nextJson);
        return 1;
    },
    on: () => undefined,
    quit: async () => undefined,
    disconnect: () => undefined,
};
await mock.module('ioredis', { namedExports: { Redis: function Redis() { return redis; } } });

// ------------------------------------------------------------------- DB double

interface HistoryRow {
    history_id: number;
    task_id: string;
    state: string;
    timestamp: string;
    reason?: string;
    metadata: string | null;
    transition_id?: string | null;
}
const historyRows: HistoryRow[] = [];
let nextHistoryId = 1;
/** States whose insert COMMITS and then rejects: the row is durable, the client is told it failed. */
const ambiguousCommitStates = new Set<string>();

interface ClaimRow { transition_id: string; task_id: string; state: string; operation_id: string; claimed_at: string }
const claimRows: ClaimRow[] = [];

function lazyResult<T>(run: () => Promise<T>) {
    return {
        then: (resolve?: (value: T) => unknown, reject?: (error: unknown) => unknown) => run().then(resolve, reject),
        catch: (reject?: (error: unknown) => unknown) => run().catch(reject),
        finally: (settled?: () => void) => run().finally(settled),
    };
}

function terminalTransitionClaimQuery() {
    let criteria: Record<string, unknown> = {};
    const appendClaim = async (row: ClaimRow) => {
        if (!claimRows.some(candidate => candidate.transition_id === row.transition_id)) claimRows.push(row);
        return [claimRows.length];
    };
    const query = {
        insert: (row: ClaimRow) => Object.assign(lazyResult(() => appendClaim(row)), {
            onConflict: (_column: string) => ({ ignore: () => lazyResult(() => appendClaim(row)) }),
        }),
        where: (value: Record<string, unknown>) => { criteria = { ...criteria, ...value }; return query; },
        first: async () => {
            const row = claimRows.find(candidate =>
                Object.entries(criteria).every(([key, value]) => candidate[key as keyof ClaimRow] === value));
            return row ? { ...row } : undefined;
        },
    };
    return query;
}

function taskHistoryQuery() {
    let criteria: Record<string, unknown> = {};
    const query = {
        insert: async (row: Omit<HistoryRow, 'history_id'>) => {
            if (row.transition_id != null && historyRows.some(existing => existing.transition_id === row.transition_id)) {
                throw new Error('UNIQUE constraint failed: task_history.transition_id');
            }
            historyRows.push({ history_id: nextHistoryId++, ...row });
            if (ambiguousCommitStates.has(row.state)) {
                throw new Error(`connection lost after committing a ${row.state} history row`);
            }
            return [nextHistoryId - 1];
        },
        select: (..._columns: string[]) => query,
        where: (value: Record<string, unknown>) => { criteria = { ...criteria, ...value }; return query; },
        orderBy: (_column: string, _direction?: string) => query,
        first: async () => {
            const row = historyRows.find(candidate =>
                Object.entries(criteria).every(([key, value]) => candidate[key as keyof HistoryRow] === value));
            return row ? { ...row } : undefined;
        },
        whereNull: () => query,
        andWhere: () => query,
        update: async () => 1,
    };
    return query;
}

const databaseTable = (table: string) =>
    table === 'task_terminal_transitions' ? terminalTransitionClaimQuery() : taskHistoryQuery();

await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: databaseTable } });
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...silent, withCorrelation: () => silent },
    namedExports: { generateCorrelationId: () => 'correlation-lost-ack' },
});

// The real capability, claim and transition modules: a stub would let an unguarded or unkeyed
// completion through, and this whole test is about which key a completion is written under.
const { durableExecutionCompletionGuard, nonExecutingCompletionGuard, isCompletionGuard, assertCompletionGuarded } =
    await import('../packages/core/src/utils/completionGuard.js');
const { claimTerminalTransition, terminalTransitionId, durableOperationIdentity } =
    await import('../packages/core/src/utils/terminalTransitionClaim.js');
const { taskStateExpectation } = await import('../packages/core/src/utils/workerStateTransition.js');
// The outcome module is dependency-free, so the real one is safe to hand the barrel double —
// and a stub would let a settled `failed` past the guard that exists to refuse it.
const { COMPLETION_DURABILITY_UNVERIFIABLE, CompletionDurabilityUnverifiableError, isCompletionDurabilityUnverifiable } =
    await import('../packages/core/src/utils/completionDurabilityOutcome.js');

await mock.module('@propr/core', {
    namedExports: {
        TaskStates: TASK_STATES,
        ErrorCategories: ERROR_CATEGORIES,
        logger: { ...silent, withCorrelation: () => silent },
        db: databaseTable,
        durableExecutionCompletionGuard, nonExecutingCompletionGuard, isCompletionGuard, assertCompletionGuarded,
        claimTerminalTransition, terminalTransitionId, durableOperationIdentity,
        taskStateExpectation,
        redactSecrets: (value: string) => value,
        COMPLETION_DURABILITY_UNVERIFIABLE, CompletionDurabilityUnverifiableError, isCompletionDurabilityUnverifiable,
    },
});

const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');
const { publishCompletedWithDurableExecutionEvidence } =
    await import('../packages/core/src/utils/durableCompletionBarrier.js');
const { attachPRCommentTaskStateFinalizers } = await import('../src/jobs/prCommentTaskStateFinalizers.js');

// ------------------------------------------------------------------- Fixtures

const COMPLETED_TRANSITION_ID = terminalTransitionId(TASK_ID, TASK_STATES.COMPLETED, OPERATION_IDENTITY);

function seedPostProcessingTask(): void {
    const timestamp = '2026-09-20T10:00:00.000Z';
    redisStore.set(TASK_KEY, JSON.stringify({
        taskId: TASK_ID,
        issueRef: { number: 4711, repoOwner: 'GospeLib', repoName: 'main', type: 'pr_comment' },
        correlationId: 'correlation-lost-ack',
        state: TASK_STATES.POST_PROCESSING,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        attempts: 0,
        history: [{ state: TASK_STATES.POST_PROCESSING, timestamp, reason: 'Publishing results', metadata: {} }],
    }));
}

function completedRows(): HistoryRow[] {
    return historyRows.filter(row => row.task_id === TASK_ID && row.state === TASK_STATES.COMPLETED);
}

function currentState(): string {
    return JSON.parse(redisStore.get(TASK_KEY) as string).state;
}

/** An emitter standing in for the BullMQ worker, so the real listener wiring is exercised. */
function workerDouble() {
    const listeners = new Map<string, ((...args: never[]) => void)[]>();
    return {
        worker: {
            on(event: string, listener: (...args: never[]) => void) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
            off(event: string, listener: (...args: never[]) => void) {
                listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener));
            },
        },
        emit(event: string, ...args: unknown[]) { for (const listener of listeners.get(event) ?? []) listener(...args as never[]); },
    };
}

const workerHandle = workerDouble();

beforeEach(() => {
    redisStore.clear();
    historyRows.length = 0;
    claimRows.length = 0;
    nextHistoryId = 1;
    ambiguousCommitStates.clear();
    failingGetCalls.clear();
    getCalls = 0;
    seedPostProcessingTask();
});

describe('a completion whose acknowledgement was lost is relayed, never re-minted', () => {
    test('the BullMQ completed event leaves exactly one completed row, carrying execution evidence', async () => {
        // The completed insert commits and then rejects; the strict write rolls Redis back.
        ambiguousCommitStates.add(TASK_STATES.COMPLETED);
        // The projection the barrier then tries to catch up hits a transient Redis failure, so
        // Redis is STILL nonterminal when the job's completed event arrives. (Call 1 is the
        // terminal write's own read; call 2 is the reconciliation's.)
        failingGetCalls.add(2);

        const stateManager = new WorkerStateManager();
        const completion = await publishCompletedWithDurableExecutionEvidence({
            stateManager,
            taskId: TASK_ID,
            operationId: OPERATION_IDENTITY,
            metadata: {
                reason: 'PR comment processing completed successfully',
                historyMetadata: { agentOutcome: { success: true, executionTimeMs: EXECUTION_TIME_MS } },
            },
        });
        assert.equal(completion.transitionId, COMPLETED_TRANSITION_ID,
            'the completion is claimed under the identity derived from the durable operation');
        assert.equal(currentState(), TASK_STATES.POST_PROCESSING,
            'the rolled-back projection is what makes this the dangerous state to finalize from');
        assert.equal(completedRows().length, 1, 'the committed row is durable despite the lost acknowledgement');

        // The job reports success, carrying the identity the barrier claimed for it.
        const finalizers = attachPRCommentTaskStateFinalizers(workerHandle.worker as never, stateManager);
        workerHandle.emit('completed',
            { name: 'processPullRequestComment', id: JOB_ID },
            { status: 'complete', pullRequestNumber: 4711, terminalTransitionId: COMPLETED_TRANSITION_ID });
        await finalizers.close();

        const completed = completedRows();
        assert.equal(completed.length, 1,
            `the finalizer must relay the durable completion, not append another (saw ${JSON.stringify(completed)})`);
        assert.equal(completed[0].transition_id, COMPLETED_TRANSITION_ID, 'and the one row keeps its claimed key');
        const metadata = JSON.parse(completed[0].metadata as string);
        assert.equal(metadata.agentOutcome?.success, true, 'the surviving completion carries its execution evidence');
        assert.equal(currentState(), TASK_STATES.COMPLETED, 'and the projection is caught up to it');
    });

    test('a completed job result with no claimed identity is refused, not settled', async () => {
        const stateManager = new WorkerStateManager();
        const finalizers = attachPRCommentTaskStateFinalizers(workerHandle.worker as never, stateManager);
        workerHandle.emit('completed',
            { name: 'processPullRequestComment', id: JOB_ID },
            { status: 'complete', pullRequestNumber: 4711 });
        await finalizers.close();

        assert.deepEqual(completedRows(), [], 'an unkeyed completion is exactly what must never be written');
        assert.equal(currentState(), TASK_STATES.POST_PROCESSING, 'and nothing terminal is projected on a guess');
    });

    test('a completed job result whose claimed row is not durable is refused too', async () => {
        const stateManager = new WorkerStateManager();
        const finalizers = attachPRCommentTaskStateFinalizers(workerHandle.worker as never, stateManager);
        workerHandle.emit('completed',
            { name: 'processPullRequestComment', id: JOB_ID },
            { status: 'partial', pullRequestNumber: 4711, terminalTransitionId: COMPLETED_TRANSITION_ID });
        await finalizers.close();

        assert.deepEqual(completedRows(), [], 'there is no durable row for that identity, so there is nothing to relay');
        assert.equal(currentState(), TASK_STATES.POST_PROCESSING);
    });
});

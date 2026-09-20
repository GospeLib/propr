/**
 * One admitted native-analysis operation owns ONE task and ONE terminal transition identity,
 * across a crash and a retry.
 *
 * The route used to mint a random task id per request and fold it into the terminal transition
 * identity. That identity is supposed to survive exactly the failure it exists for: the process
 * dies after the completed history row commits, the caller retries the SAME admitted operation,
 * and the retry must recognise what already landed. A per-request id cannot — it addresses a
 * different task, derives a different key, finds nothing, and the route reports
 * `terminalRecorded: false` for a completion that is sitting in the database, which is an
 * invitation to repeat paid work.
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
const OPERATION_ID = 'admitted-operation-8f21';
const EXECUTION_TIME_MS = 1_234;

// ---------------------------------------------------------------- Redis double

const redisStore = new Map<string, string>();
const redis = {
    get: async (key: string) => redisStore.get(key) ?? null,
    setex: async (key: string, _expiry: number, value: string) => { redisStore.set(key, value); return 'OK'; },
    eval: async (_script: string, _keys: number, key: string, currentJson: string, _expiry: number, nextJson: string) => {
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

interface HistoryRow { history_id: number; task_id: string; state: string; timestamp: string; reason?: string; metadata: string | null; transition_id?: string | null }
const historyRows: HistoryRow[] = [];
let nextHistoryId = 1;
interface ClaimRow { transition_id: string; task_id: string; state: string; operation_id: string; claimed_at: string }
const claimRows: ClaimRow[] = [];
const taskRows: { task_id: string }[] = [];

function lazyResult<T>(run: () => Promise<T>) {
    return {
        then: (resolve?: (value: T) => unknown, reject?: (error: unknown) => unknown) => run().then(resolve, reject),
        catch: (reject?: (error: unknown) => unknown) => run().catch(reject),
        finally: (settled?: () => void) => run().finally(settled),
    };
}

function claimQuery() {
    let criteria: Record<string, unknown> = {};
    const append = async (row: ClaimRow) => {
        if (!claimRows.some(candidate => candidate.transition_id === row.transition_id)) claimRows.push(row);
        return [claimRows.length];
    };
    const query = {
        insert: (row: ClaimRow) => Object.assign(lazyResult(() => append(row)), {
            onConflict: () => ({ ignore: () => lazyResult(() => append(row)) }),
        }),
        where: (value: Record<string, unknown>) => { criteria = { ...criteria, ...value }; return query; },
        first: async () => {
            const row = claimRows.find(candidate => Object.entries(criteria)
                .every(([key, value]) => candidate[key as keyof ClaimRow] === value));
            return row ? { ...row } : undefined;
        },
    };
    return query;
}

function tasksQuery() {
    return {
        insert: (row: { task_id: string }) => Object.assign(lazyResult(async () => [1]), {
            onConflict: () => ({ ignore: () => lazyResult(async () => {
                if (!taskRows.some(existing => existing.task_id === row.task_id)) taskRows.push({ task_id: row.task_id });
                return [1];
            }) }),
        }),
        where: () => tasksQuery(),
        update: async () => 1,
        first: async () => undefined,
    };
}

function historyQuery() {
    let criteria: Record<string, unknown> = {};
    const query = {
        insert: async (row: Omit<HistoryRow, 'history_id'>) => {
            if (row.transition_id != null && historyRows.some(existing => existing.transition_id === row.transition_id)) {
                throw new Error('UNIQUE constraint failed: task_history.transition_id');
            }
            historyRows.push({ history_id: nextHistoryId++, ...row });
            return [nextHistoryId - 1];
        },
        select: () => query,
        where: (value: Record<string, unknown>) => { criteria = { ...criteria, ...value }; return query; },
        orderBy: () => query,
        whereNull: () => query,
        andWhere: () => query,
        first: async () => {
            const row = historyRows.find(candidate => Object.entries(criteria)
                .every(([key, value]) => candidate[key as keyof HistoryRow] === value));
            return row ? { ...row } : undefined;
        },
        update: async () => 1,
    };
    return query;
}

interface LeaseRow {
    lease_key: string; task_id: string; operation_id: string; lease_generation: string;
    acquired_at: string; expires_at: string; settled_at: string | null; settled_state: string | null;
}
const leaseRows: LeaseRow[] = [];

/**
 * The lease table, modelled on the statements the real one runs: an insert that admits one row
 * per key and is otherwise ignored, and conditional updates/deletes that report how many rows
 * they actually changed.
 */
function leaseQuery() {
    let criteria: Record<string, unknown> = {};
    const nullColumns: string[] = [];
    const comparisons: [string, string, string][] = [];
    const matches = (row: LeaseRow) =>
        Object.entries(criteria).every(([key, value]) => row[key as keyof LeaseRow] === value)
        && nullColumns.every(column => row[column as keyof LeaseRow] == null)
        && comparisons.every(([column, operator, value]) => operator === '<='
            ? String(row[column as keyof LeaseRow]) <= value : String(row[column as keyof LeaseRow]) > value);
    const append = async (row: LeaseRow) => {
        if (!leaseRows.some(existing => existing.lease_key === row.lease_key)) leaseRows.push({ ...row });
        return [leaseRows.length];
    };
    const query = {
        insert: (row: LeaseRow) => Object.assign(lazyResult(() => append(row)), {
            onConflict: () => ({ ignore: () => lazyResult(() => append(row)) }),
        }),
        where: (column: string | Record<string, unknown>, operator?: string, value?: string) => {
            if (typeof column === 'object') criteria = { ...criteria, ...column };
            else comparisons.push([column, operator as string, value as string]);
            return query;
        },
        whereNull: (column: string) => { nullColumns.push(column); return query; },
        first: async () => { const row = leaseRows.find(matches); return row ? { ...row } : undefined; },
        update: async (values: Partial<LeaseRow>) => {
            const affected = leaseRows.filter(matches);
            for (const row of affected) Object.assign(row, values);
            return affected.length;
        },
        delete: async () => {
            const affected = leaseRows.filter(matches);
            for (const row of affected) leaseRows.splice(leaseRows.indexOf(row), 1);
            return affected.length;
        },
    };
    return query;
}

interface ProofRow {
    lease_key: string; lease_generation: string; proof: string; recorded_by: string;
    recorded_at: string; consumed_at: string | null; consumed_by_generation: string | null;
}
const proofRows: ProofRow[] = [];

/** The stop-proof table: an insert that admits one row per (key, generation), consumed by update. */
function proofQuery() {
    let criteria: Record<string, unknown> = {};
    const nullColumns: string[] = [];
    const matches = (row: ProofRow) =>
        Object.entries(criteria).every(([key, value]) => row[key as keyof ProofRow] === value)
        && nullColumns.every(column => row[column as keyof ProofRow] == null);
    const append = async (row: ProofRow) => {
        if (!proofRows.some(existing => existing.lease_key === row.lease_key
            && existing.lease_generation === row.lease_generation)) proofRows.push({ ...row });
        return [proofRows.length];
    };
    const query = {
        insert: (row: ProofRow) => Object.assign(lazyResult(() => append(row)), {
            onConflict: () => ({ ignore: () => lazyResult(() => append(row)) }),
        }),
        where: (value: Record<string, unknown>) => { criteria = { ...criteria, ...value }; return query; },
        whereNull: (column: string) => { nullColumns.push(column); return query; },
        first: async () => { const row = proofRows.find(matches); return row ? { ...row } : undefined; },
        update: async (values: Partial<ProofRow>) => {
            const affected = proofRows.filter(matches);
            for (const row of affected) Object.assign(row, values);
            return affected.length;
        },
    };
    return query;
}

const tableDouble = (table: string) => table === 'task_terminal_transitions' ? claimQuery()
    : table === 'task_execution_leases' ? leaseQuery()
    : table === 'task_execution_lease_stop_proofs' ? proofQuery()
    : table === 'tasks' ? tasksQuery() : historyQuery();
/**
 * The connection double, with the two things the route's settlement now needs of it: a clock read
 * from the database rather than the process, and a transaction the terminal write and the lease
 * settlement can share. The transaction here runs its body against the same tables — the ATOMICITY
 * of that pair is asserted against real SQLite in `nativeAnalysisTerminalLeaseAtomicity.test.ts`,
 * which is where a statement-level property belongs.
 */
const databaseTable = Object.assign(tableDouble, {
    raw: async () => [{ now: new Date().toISOString() }],
    transaction: async (run: (transaction: typeof databaseTable) => Promise<void>) => run(databaseTable),
});

await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: databaseTable } });
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...silent, withCorrelation: () => silent },
    namedExports: { generateCorrelationId: () => 'correlation-native-identity' },
});

const { claimTerminalTransition, terminalTransitionId, durableOperationIdentity, durableTerminalTransitionRecorded } =
    await import('../packages/core/src/utils/terminalTransitionClaim.js');
const { durableExecutionCompletionGuard, nonExecutingCompletionGuard, isCompletionGuard, assertCompletionGuarded } =
    await import('../packages/core/src/utils/completionGuard.js');
const { COMPLETION_DURABILITY_UNVERIFIABLE, CompletionDurabilityUnverifiableError, isCompletionDurabilityUnverifiable } =
    await import('../packages/core/src/utils/completionDurabilityOutcome.js');
const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');
const { publishCompletedWithDurableExecutionEvidence, certifyDurableCompletion, isDurableCompletionAbsent,
    COMPLETION_PERSISTENCE_FAILED_SUFFIX } =
    await import('../packages/core/src/utils/durableCompletionBarrier.js');
const { acquireExecutionLease, recordExecutorStopProof, releaseExecutionLease, renewExecutionLease,
    settleExecutionLease, startExecutionLeaseRenewal } =
    await import('../packages/core/src/utils/executionLease.js');

class SyntheticAgent {}

await mock.module('@propr/core', {
    namedExports: {
        TaskStates: TASK_STATES,
        ErrorCategories: ERROR_CATEGORIES,
        SyntheticAgent,
        logger: { ...silent, withCorrelation: () => silent },
        db: databaseTable,
        getStateManager: () => { throw new Error('the test supplies its own state manager'); },
        runWithExecutionAbortSignal: async <T>(_signal: AbortSignal, run: () => Promise<T>) => run(),
        runWithPlannerAbortContext: async <T>(_taskId: string, _generation: string, run: () => Promise<T>) => run(),
        durableOperationIdentity, claimTerminalTransition, terminalTransitionId, durableTerminalTransitionRecorded,
        COMPLETION_PERSISTENCE_FAILED_SUFFIX, recordExecutorStopProof,
        durableExecutionCompletionGuard, nonExecutingCompletionGuard, isCompletionGuard, assertCompletionGuarded,
        publishCompletedWithDurableExecutionEvidence, certifyDurableCompletion, isDurableCompletionAbsent,
        acquireExecutionLease, releaseExecutionLease, renewExecutionLease, settleExecutionLease, startExecutionLeaseRenewal,
        COMPLETION_DURABILITY_UNVERIFIABLE, CompletionDurabilityUnverifiableError, isCompletionDurabilityUnverifiable,
        buildPlannerAbortSignalKey: (draftId: string) => `planner:abort:${draftId}`,
        buildPlannerAbortRedisOptions: () => ({}),
    },
});

// The route only needs this module's abort-signal writer, and the test injects its own; the real
// module drags the whole planner/auth chain in behind it.
await mock.module('../packages/api/routes/plannerAbortHandlers.js', {
    namedExports: { setAbortSignal: async () => undefined },
});

const { nativeAnalysis } = await import('../packages/api/routes/nativeAnalysis.js');

// ------------------------------------------------------------------- Fixtures

const { createHash } = await import('node:crypto');
const binding = (prompt: string) => ({
    requestId: 'request-native-identity',
    operationId: OPERATION_ID,
    inputDigest: `sha256:${'a'.repeat(64)}`,
    repository: 'GospeLib/main',
    providerInputDigest: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
});

function claudeAgent(onAnalyze: () => void | Promise<void>) {
    return {
        config: { type: 'claude', id: 'claude-native', alias: 'native' },
        async analyze() {
            await onAnalyze();
            return { success: true, response: 'plan', modelUsed: 'fixture', executionTimeMs: EXECUTION_TIME_MS };
        },
    } as never;
}

function failingAgent(onAnalyze: () => void) {
    return {
        config: { type: 'claude', id: 'claude-native', alias: 'native' },
        async analyze() { onAnalyze(); throw new Error('provider unavailable'); },
    } as never;
}

async function runAnalysis(onAnalyze: () => void | Promise<void>, stateManager: unknown) {
    return nativeAnalysis(claudeAgent(onAnalyze), 'prompt', {
        options: {} as never,
        signal: new AbortController().signal,
        binding: binding('prompt'),
        dependencies: { stateManager: stateManager as never, setAbortSignal: async () => undefined },
    });
}

function completedRows(): HistoryRow[] {
    return historyRows.filter(row => row.state === TASK_STATES.COMPLETED);
}

beforeEach(() => {
    redisStore.clear();
    historyRows.length = 0;
    claimRows.length = 0;
    leaseRows.length = 0;
    proofRows.length = 0;
    taskRows.length = 0;
    nextHistoryId = 1;
});

describe('a retried native analysis operation keeps one identity', () => {
    test('a crash that loses the projection refuses the retry from the durable history, and pays once', async () => {
        let analyses = 0;
        const first = await runAnalysis(() => { analyses++; }, new WorkerStateManager());
        const firstTaskId = (first.execution as { taskId: string }).taskId;
        assert.equal(completedRows().length, 1);
        assert.equal((first.execution as { terminalRecorded: boolean }).terminalRecorded, true);
        assert.equal((first.execution as { terminalTransitionId?: string }).terminalTransitionId,
            terminalTransitionId(firstTaskId, TASK_STATES.COMPLETED, durableOperationIdentity('native-analysis', OPERATION_ID)),
            'under the identity derived from the admitted operation, not from the attempt');

        // The process dies: the durable history survives, the Redis projection does not.
        redisStore.clear();

        await assert.rejects(() => runAnalysis(() => { analyses++; }, new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_ALREADY_SETTLED/,
            'the projection is not what decides whether paid work runs; the durable history is');
        assert.equal(analyses, 1, 'a durably settled operation never receives a second paid execution');
        assert.equal(claimRows.filter(row => row.state === TASK_STATES.COMPLETED).length, 1,
            'and there is still one terminal transition identity, not a second one');
        assert.equal(completedRows().length, 1,
            `one logical completion is one durable row (saw ${JSON.stringify(completedRows())})`);
    });

    test('a projection that missed the terminal transition is restored from the durable history', async () => {
        let analyses = 0;
        const first = await runAnalysis(() => { analyses++; }, new WorkerStateManager());
        const taskId = (first.execution as { taskId: string }).taskId;
        // The history committed but the process died before the projection caught up: Redis is
        // present and nonterminal, which reads exactly like an operation that never settled.
        const [key, projected] = [...redisStore.entries()][0];
        redisStore.set(key, JSON.stringify({ ...JSON.parse(projected), state: TASK_STATES.CLAUDE_EXECUTION }));

        await assert.rejects(() => runAnalysis(() => { analyses++; }, new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_ALREADY_SETTLED/);
        assert.equal(analyses, 1, 'a stale projection cannot buy a second paid execution');
        assert.equal(JSON.parse(redisStore.get(key) as string).state, TASK_STATES.COMPLETED,
            'and the projection is restored from the durable evidence rather than re-earned');
        assert.equal(completedRows().length, 1);
        assert.ok(taskId);
    });

    test('two simultaneous requests for one operation produce exactly one paid execution', async () => {
        let analyses = 0;
        let admit!: () => void;
        const inProvider = new Promise<void>(resolve => { admit = resolve; });
        let released!: () => void;
        const release = new Promise<void>(resolve => { released = resolve; });
        const first = runAnalysis(async () => { analyses++; admit(); await release; }, new WorkerStateManager());
        // The second request arrives while the first is INSIDE the provider, which is the window
        // the old `getTaskState` check could not close: neither request has settled anything yet.
        await inProvider;
        await assert.rejects(() => runAnalysis(() => { analyses++; }, new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_EXECUTION_IN_PROGRESS/,
            'the second request must be refused by the lease, not admitted to a second paid run');
        assert.equal(analyses, 1, 'the non-atomic check let both requests pay; the lease admits one');
        released();
        const completed = await first;
        assert.equal((completed.execution as { terminalRecorded: boolean }).terminalRecorded, true,
            'and the request that held the lease still settles normally');
        assert.equal(completedRows().length, 1);
        assert.equal(claimRows.filter(row => row.state === TASK_STATES.COMPLETED).length, 1);
    });

    test('a retry of an operation that settled NOTHING is still allowed to run', async () => {
        let analyses = 0;
        const base = new WorkerStateManager();
        const terminal = new Set<string>([TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED]);
        // An attempt that dies without settling anything: its provider fails AND its terminal
        // write fails, so the operation is left genuinely unsettled.
        const crashing = {
            createTaskState: base.createTaskState.bind(base),
            updateHistoryMetadata: base.updateHistoryMetadata.bind(base),
            getTaskState: base.getTaskState.bind(base),
            markTaskFailed: base.markTaskFailed.bind(base),
            projectDurableCompletion: base.projectDurableCompletion.bind(base),
            updateTaskState: async (taskId: string, state: string, metadata?: unknown) => {
                if (terminal.has(state)) throw new Error('terminal history unavailable');
                return base.updateTaskState(taskId, state, metadata as never);
            },
        };
        await assert.rejects(() => nativeAnalysis(failingAgent(() => { analyses++; }), 'prompt', {
            options: {} as never, signal: new AbortController().signal, binding: binding('prompt'),
            dependencies: { stateManager: crashing as never, setAbortSignal: async () => undefined },
        }), /provider unavailable/);
        assert.equal(analyses, 1);
        assert.equal(leaseRows.length, 0, 'an attempt that settled nothing hands its lease straight back');

        const retry = await runAnalysis(() => { analyses++; }, new WorkerStateManager());
        assert.equal(analyses, 2, 'an unsettled operation may legitimately be retried; the fence is not a blanket refusal');
        assert.equal((retry.execution as { terminalRecorded: boolean }).terminalRecorded, true);
        assert.equal(completedRows().length, 1);
    });

    test('a retry that still sees the settled projection refuses to run the paid work again', async () => {
        let analyses = 0;
        await runAnalysis(() => { analyses++; }, new WorkerStateManager());
        await assert.rejects(() => runAnalysis(() => { analyses++; }, new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_ALREADY_SETTLED/);
        assert.equal(analyses, 1, 'an operation that already settled does not get a second paid execution');
        assert.equal(completedRows().length, 1);
    });
});

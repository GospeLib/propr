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

const databaseTable = (table: string) => table === 'task_terminal_transitions' ? claimQuery()
    : table === 'tasks' ? tasksQuery() : historyQuery();

await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: databaseTable } });
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...silent, withCorrelation: () => silent },
    namedExports: { generateCorrelationId: () => 'correlation-native-identity' },
});

const { claimTerminalTransition, terminalTransitionId, durableOperationIdentity } =
    await import('../packages/core/src/utils/terminalTransitionClaim.js');
const { durableExecutionCompletionGuard, nonExecutingCompletionGuard, isCompletionGuard, assertCompletionGuarded } =
    await import('../packages/core/src/utils/completionGuard.js');
const { COMPLETION_DURABILITY_UNVERIFIABLE, CompletionDurabilityUnverifiableError, isCompletionDurabilityUnverifiable } =
    await import('../packages/core/src/utils/completionDurabilityOutcome.js');
const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');
const { publishCompletedWithDurableExecutionEvidence, certifyDurableCompletion } =
    await import('../packages/core/src/utils/durableCompletionBarrier.js');

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
        durableOperationIdentity, claimTerminalTransition, terminalTransitionId,
        durableExecutionCompletionGuard, nonExecutingCompletionGuard, isCompletionGuard, assertCompletionGuarded,
        publishCompletedWithDurableExecutionEvidence, certifyDurableCompletion,
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

function claudeAgent(onAnalyze: () => void) {
    return {
        config: { type: 'claude', id: 'claude-native', alias: 'native' },
        async analyze() {
            onAnalyze();
            return { success: true, response: 'plan', modelUsed: 'fixture', executionTimeMs: EXECUTION_TIME_MS };
        },
    } as never;
}

async function runAnalysis(onAnalyze: () => void, stateManager: unknown) {
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
    taskRows.length = 0;
    nextHistoryId = 1;
});

describe('a retried native analysis operation keeps one identity', () => {
    test('a crash that loses the projection still leaves one task, one claim and one completed row', async () => {
        let analyses = 0;
        const first = await runAnalysis(() => { analyses++; }, new WorkerStateManager());
        const firstTaskId = (first.execution as { taskId: string }).taskId;
        assert.equal(completedRows().length, 1);
        assert.equal((first.execution as { terminalRecorded: boolean }).terminalRecorded, true);

        // The process dies: the durable history survives, the Redis projection does not.
        redisStore.clear();

        const second = await runAnalysis(() => { analyses++; }, new WorkerStateManager());
        const secondTaskId = (second.execution as { taskId: string }).taskId;

        assert.equal(secondTaskId, firstTaskId,
            'the retry of one admitted operation must address the task that operation already created');
        assert.equal(claimRows.filter(row => row.state === TASK_STATES.COMPLETED).length, 1,
            'and claim the one terminal transition identity, not a second one');
        assert.equal(completedRows().length, 1,
            `one logical completion is one durable row (saw ${JSON.stringify(completedRows())})`);
        assert.equal((second.execution as { terminalRecorded: boolean }).terminalRecorded, true,
            'a completion that is demonstrably durable must never be reported as unrecorded');
        assert.equal((second.execution as { terminalTransitionId?: string }).terminalTransitionId,
            terminalTransitionId(firstTaskId, TASK_STATES.COMPLETED, durableOperationIdentity('native-analysis', OPERATION_ID)),
            'under the identity derived from the admitted operation, not from the attempt');
        assert.equal(analyses, 2, 'the retry did re-run: this test is about identity, not about caching a result');
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

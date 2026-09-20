/**
 * A terminal outcome and the right to have produced it settle TOGETHER, against a real database.
 *
 * The lease is post-execution deduplication's opposite number: it has to stop the SECOND PAID RUN,
 * not tidy up after it. Two windows were still open, and both cost money.
 *
 * The first is a crash between the terminal write and the settlement. `failed` and `cancelled`
 * were written durably and the lease was settled in a SECOND statement, so a process that died in
 * between left a terminal operation whose lease was unsettled — and a transient settlement failure
 * was worse, because the route then handed that lease back although the terminal record had
 * already committed. With the Redis projection subsequently lost, the next delivery read an unrun
 * operation and paid again.
 *
 * The second is a lapsed heartbeat being read as a stopped provider. A suspended event loop, a
 * stalled write or a skewed clock all lapse a term while the execution keeps running.
 *
 * These run against real SQLite, applying the real migrations, because what is being asserted is
 * that one transaction carries both rows and that a conditional statement refuses a contender.
 * A double would assert this test's model of those statements.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir as readDirectory, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';

const TASK_STATES = {
    PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
    POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
} as const;
const ERROR_CATEGORIES = { POST_PROCESSING: 'post_processing', UNKNOWN: 'unknown' } as const;
const EXECUTION_TIME_MS = 1_234;

// A FILE, not `:memory:`: every pooled connection has to see the same database, or a transaction
// opened on a second connection would be opening a second, empty one — and the atomicity these
// tests are about would be untestable exactly where it matters.
const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'propr-lease-'));
const database: Knex = knex({
    client: 'better-sqlite3',
    connection: { filename: path.join(databaseDirectory, 'propr.test.sqlite') },
    useNullAsDefault: true,
    pool: {
        afterCreate: (connection: { pragma: (statement: string) => unknown },
            done: (error: Error | null, resource?: unknown) => void) => {
            connection.pragma('busy_timeout = 5000');
            connection.pragma('journal_mode = WAL');
            done(null, connection);
        },
    },
});

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
    on: () => undefined, quit: async () => undefined, disconnect: () => undefined,
};
await mock.module('ioredis', { namedExports: { Redis: function Redis() { return redis; } } });
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: database } });
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...silent, withCorrelation: () => silent },
    namedExports: { generateCorrelationId: () => 'correlation-native-lease' },
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
const executionLease = await import('../packages/core/src/utils/executionLease.js');

class SyntheticAgent {}

/** The history read the release rule depends on, with a seam for "the database would not answer". */
let historyReadFailure: string | undefined;
const readTerminalTransition = async (taskId: string, transitionId: string, state: string) => {
    if (historyReadFailure) throw new Error(historyReadFailure);
    return durableTerminalTransitionRecorded(taskId, transitionId, state);
};

await mock.module('@propr/core', {
    namedExports: {
        TaskStates: TASK_STATES, ErrorCategories: ERROR_CATEGORIES, SyntheticAgent,
        logger: { ...silent, withCorrelation: () => silent }, db: database,
        getStateManager: () => { throw new Error('the test supplies its own state manager'); },
        runWithExecutionAbortSignal: async <T>(_signal: AbortSignal, run: () => Promise<T>) => run(),
        runWithPlannerAbortContext: async <T>(_taskId: string, _generation: string, run: () => Promise<T>) => run(),
        durableOperationIdentity, claimTerminalTransition, terminalTransitionId,
        durableTerminalTransitionRecorded: readTerminalTransition,
        durableExecutionCompletionGuard, nonExecutingCompletionGuard, isCompletionGuard, assertCompletionGuarded,
        publishCompletedWithDurableExecutionEvidence, certifyDurableCompletion, isDurableCompletionAbsent,
        COMPLETION_PERSISTENCE_FAILED_SUFFIX,
        ...executionLease,
        COMPLETION_DURABILITY_UNVERIFIABLE, CompletionDurabilityUnverifiableError, isCompletionDurabilityUnverifiable,
        buildPlannerAbortSignalKey: (draftId: string) => `planner:abort:${draftId}`,
        buildPlannerAbortRedisOptions: () => ({}),
    },
});
await mock.module('../packages/api/routes/plannerAbortHandlers.js', {
    namedExports: { setAbortSignal: async () => undefined },
});

const { nativeAnalysis } = await import('../packages/api/routes/nativeAnalysis.js');
const { createHash, randomUUID } = await import('node:crypto');

// ------------------------------------------------------------------- Fixtures

let operationId = 'operation-placeholder';
const binding = (prompt: string) => ({
    requestId: 'request-native-lease', operationId,
    inputDigest: `sha256:${'b'.repeat(64)}`, repository: 'GospeLib/main',
    providerInputDigest: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
});

function agentThat(run: () => void | Promise<void>, succeed = true) {
    return {
        config: { type: 'claude', id: 'claude-native', alias: 'native' },
        async analyze() {
            await run();
            if (!succeed) throw new Error('provider unavailable');
            return { success: true, response: 'plan', modelUsed: 'fixture', executionTimeMs: EXECUTION_TIME_MS };
        },
    } as never;
}

function runAnalysis(agent: unknown, stateManager: unknown, signal = new AbortController().signal) {
    return nativeAnalysis(agent as never, 'prompt', {
        options: {} as never, signal, binding: binding('prompt'),
        dependencies: { stateManager: stateManager as never, setAbortSignal: async () => undefined },
    });
}

/**
 * A state manager whose terminal write COMMITS and whose caller then dies.
 *
 * This is the crash the two-statement settlement could not survive: the durable record of the
 * outcome is on disk, and nothing after it runs.
 */
function dyingAfterTerminalWrite(base: InstanceType<typeof WorkerStateManager>) {
    const terminal = new Set<string>([TASK_STATES.COMPLETED, TASK_STATES.FAILED, TASK_STATES.CANCELLED]);
    return {
        createTaskState: base.createTaskState.bind(base),
        updateHistoryMetadata: base.updateHistoryMetadata.bind(base),
        getTaskState: base.getTaskState.bind(base),
        markTaskFailed: base.markTaskFailed.bind(base),
        projectDurableCompletion: base.projectDurableCompletion.bind(base),
        updateTaskState: async (taskId: string, state: string, metadata?: unknown) => {
            const updated = await base.updateTaskState(taskId, state, metadata as never);
            if (terminal.has(state)) throw new Error('the process died after the terminal history committed');
            return updated;
        },
    };
}

const leaseKey = () => durableOperationIdentity('native-analysis', operationId);
const leaseRow = () => database('task_execution_leases').where({ lease_key: leaseKey() }).first();

before(async () => {
    const directory = fileURLToPath(new URL('../packages/core/src/db/migrations/', import.meta.url));
    for (const file of (await readDirectory(directory)).filter(name => name.endsWith('.js')).sort()) {
        const migration = await import(path.join(directory, file)) as { up: (connection: Knex) => Promise<void> };
        await migration.up(database);
    }
});

beforeEach(() => {
    redisStore.clear();
    historyReadFailure = undefined;
    operationId = `admitted-${randomUUID()}`;
});
afterEach(() => { historyReadFailure = undefined; });
after(async () => { await database.destroy(); await rm(databaseDirectory, { recursive: true, force: true }); });

/**
 * A state manager that fails BEFORE the provider is ever reached, and cannot record anything.
 *
 * The other half of the release rule: this attempt spent nothing, so refusing to let it retry
 * would turn every early crash into a permanent refusal for no gain at all.
 */
function dyingBeforeAnyWrite() {
    const fail = async () => { throw new Error('the task state could not be created'); };
    return {
        createTaskState: fail, updateTaskState: fail, updateHistoryMetadata: fail,
        getTaskState: async () => undefined, markTaskFailed: fail, projectDurableCompletion: fail,
    };
}

/** An attempt that reaches the provider and then cannot record anything terminal at all. */
function reachesProviderAndRecordsNothing(base: InstanceType<typeof WorkerStateManager>) {
    return { ...dyingAfterTerminalWrite(base),
        updateTaskState: async (taskId: string, state: string, metadata?: unknown) => {
            if (state === TASK_STATES.CLAUDE_EXECUTION) return base.updateTaskState(taskId, state, metadata as never);
            throw new Error('the terminal write never reached the database');
        } };
}

describe('a terminal native-analysis outcome and its execution lease settle together', () => {
    test('a crash straight after a durable failed write leaves an operation no retry can pay for again', async () => {
        let analyses = 0;
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }, false),
            dyingAfterTerminalWrite(new WorkerStateManager())), /provider unavailable/);
        const failedIdentity = terminalTransitionId(
            `native-analysis-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`,
            TASK_STATES.FAILED, leaseKey());
        const failed = await database('task_history').where({ transition_id: failedIdentity }).first();
        assert.ok(failed, 'the terminal write committed, which is the premise of this crash');
        const lease = await leaseRow();
        assert.ok(lease, 'the lease was NOT handed back over a terminal record that had committed');
        assert.equal(lease.settled_state, TASK_STATES.FAILED,
            'the settlement rode in on the same transaction as the terminal row, so the crash could not separate them');

        // The process died; the durable history survives, the Redis projection does not.
        redisStore.clear();
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_ALREADY_SETTLED/,
            'a settled failure is a settled operation; a lost projection does not make it payable again');
        assert.equal(analyses, 1, 'exactly one paid execution');
    });

    test('a crash straight after a durable cancelled write is equally unpayable', async () => {
        let analyses = 0;
        const aborting = new AbortController();
        await assert.rejects(() => runAnalysis(
            agentThat(() => { analyses++; aborting.abort(); throw new Error('cancelled mid-flight'); }, false),
            dyingAfterTerminalWrite(new WorkerStateManager()), aborting.signal), /cancelled mid-flight/);
        const lease = await leaseRow();
        assert.ok(lease, 'a cancelled operation keeps its lease; cancellation is a settlement');
        assert.equal(lease.settled_state, TASK_STATES.CANCELLED);

        redisStore.clear();
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_ALREADY_SETTLED/);
        assert.equal(analyses, 1);
    });

    test('a settlement that cannot be established keeps the lease rather than handing it back', async () => {
        let analyses = 0;
        const base = new WorkerStateManager();
        const dying = dyingAfterTerminalWrite(base);
        // The terminal record committed and the history can no longer be read, so whether anything
        // is durable is UNKNOWN. An unknown is not an absence.
        const failing = { ...dying, updateTaskState: async (taskId: string, state: string, metadata?: unknown) => {
            const result = await dying.updateTaskState(taskId, state, metadata).catch((error: Error) => error);
            historyReadFailure = 'the task history could not be read';
            if (result instanceof Error) throw result;
            return result;
        } };
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }, false), failing), /provider unavailable/);
        assert.ok(await leaseRow(), 'an ambiguous terminal durability never releases the right to execute');
        historyReadFailure = undefined;

        redisStore.clear();
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_ALREADY_SETTLED|NATIVE_ANALYSIS_OPERATION_EXECUTION/);
        assert.equal(analyses, 1);
    });

    test('a suspended holder is not replaced: an expired term is not proof the provider stopped', async () => {
        let analyses = 0;
        let admit!: () => void;
        const inProvider = new Promise<void>(resolve => { admit = resolve; });
        let release!: () => void;
        const released = new Promise<void>(resolve => { release = resolve; });
        const running = runAnalysis(agentThat(async () => { analyses++; admit(); await released; }),
            new WorkerStateManager());
        await inProvider;
        // The holder is alive and inside the provider, but its renewals are not reaching SQLite:
        // its term lapses while the execution — and the charge — continues.
        await database('task_execution_leases').where({ lease_key: leaseKey() })
            .update({ expires_at: new Date(Date.now() - 120_000).toISOString() });

        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_EXECUTION_UNRECONCILED/,
            'a lapsed heartbeat must not admit a second execution of live paid work');
        assert.equal(analyses, 1, 'the provider ran once, and is still running');

        release();
        const completed = await running;
        assert.equal((completed.execution as { terminalRecorded: boolean }).terminalRecorded, true,
            'and the live holder still settles its own operation normally');
        assert.equal((await leaseRow()).settled_state, TASK_STATES.COMPLETED);
    });

    test('an attempt that never reached the provider hands its lease straight back', async () => {
        let analyses = 0;
        // It fails before `analyze` is called, so nothing was invoked and nothing can have been
        // billed. Refusing this retry would cost a real operation and save nothing.
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), dyingBeforeAnyWrite()),
            /the task state could not be created/);
        assert.equal(analyses, 0, 'the premise: the provider was never reached');
        assert.equal(await leaseRow(), undefined, 'so the right to run goes back immediately');

        const retried = await runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager());
        assert.equal((retried.execution as { terminalRecorded: boolean }).terminalRecorded, true);
        assert.equal(analyses, 1, 'and the retry is the FIRST paid execution, not a second one');
    });

    test('an attempt that reached the provider and recorded nothing keeps its lease and says why', async () => {
        let analyses = 0;
        // The window the previous round released into. `agent.analyze` ran — it may already have
        // been billed — and then every terminal write failed, so the history holds nothing. The
        // old rule read that absence as "this operation never happened" and made it immediately
        // payable again. Proving the executor stopped would prevent two runs overlapping; it
        // would not prove no money changed hands.
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }, false),
            reachesProviderAndRecordsNothing(new WorkerStateManager())), /provider unavailable/);
        const retained = await leaseRow();
        assert.ok(retained, 'the lease is NOT handed back after a possibly billed invocation');
        assert.equal(retained.settled_at, null, 'and it is not settled either: nothing terminal is durable');
        assert.equal(Boolean(retained.provider_invocation_started), true,
            'the fact that decides this is on the row, written before the provider was called');
        assert.match(retained.reconciliation_reason, /may already have been billed/);
        assert.match(retained.reconciliation_reason, /reconcile-execution-lease/,
            'and it names the command that can release it, so a lapsed lease is not a dead end');

        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_EXECUTION_IN_PROGRESS/);
        await database('task_execution_leases').where({ lease_key: leaseKey() })
            .update({ expires_at: new Date(Date.now() - 120_000).toISOString() });
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_EXECUTION_UNRECONCILED/,
            'the lapsed term routes it to explicit reconciliation, never to an automatic retry');
        assert.equal(analyses, 1, 'exactly one paid execution, and no second one on any path');
    });

    test('durable proof that the executor stopped is what admits a successor, and only once', async () => {
        let analyses = 0;
        historyReadFailure = undefined;
        // Strand a lease deliberately, to exercise the reconciliation path itself.
        const stranded = randomUUID();
        assert.equal((await executionLease.acquireExecutionLease({
            leaseKey: leaseKey(), taskId: 'native-analysis-stranded', operationId, generation: stranded,
        })).outcome, 'acquired');
        await database('task_execution_leases').where({ lease_key: leaseKey() })
            .update({ expires_at: new Date(Date.now() - 120_000).toISOString() });
        await assert.rejects(() => runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager()),
            /NATIVE_ANALYSIS_OPERATION_EXECUTION_UNRECONCILED/);

        // Recorded through the checked operator path, which is the one a runbook can hand someone:
        // it refuses a live holder, a stale generation, an unconfirmed one and a settled lease, and
        // it records a fact rather than taking or settling the lease itself.
        assert.deepEqual(await executionLease.recordVerifiedExecutorStop({
            leaseKey: leaseKey(), generation: stranded, confirmGeneration: stranded,
            proof: 'docker ps shows no container for this task and the host was drained',
            recordedBy: 'operator:test',
        }), { recorded: true });
        const reconciled = await runAnalysis(agentThat(() => { analyses++; }), new WorkerStateManager());
        assert.equal((reconciled.execution as { terminalRecorded: boolean }).terminalRecorded, true);
        assert.equal(analyses, 1, 'the refused attempt paid nothing; only the admitted one ran');
    });
});

/**
 * Regressions for the durability barrier on a published `completed`.
 *
 * A partially persisted success used to be indistinguishable from a real failure: the durable
 * history kept the start-time `provisional success:false` record, the in-place rewrite and the
 * appended final `claude_execution` entry were both best effort, and `completed` was published
 * regardless. A consumer reading `[provisional false, completed]` by value concluded failure and
 * re-dispatched the work, forever.
 *
 * These tests drive the real WorkerStateManager over a Redis/DB double whose history writes can
 * be failed per state, so they assert what a reader holding only the durable history sees.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
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

const ERROR_CATEGORIES = {
    GITHUB_API: 'github_api',
    CLAUDE_EXECUTION: 'claude_execution',
    GIT_OPERATION: 'git_operation',
    DOCKER_OPERATION: 'docker_operation',
    REDIS_OPERATION: 'redis_operation',
    POST_PROCESSING: 'post_processing',
    AUTHENTICATION: 'authentication',
    NETWORK: 'network',
    VALIDATION: 'validation',
    UNKNOWN: 'unknown',
} as const;

const TASK_ID = 'task-completion-durability';
const TASK_KEY = `worker:state:${TASK_ID}`;
const SESSION_ID = 'session-completion-durability';
const CONVERSATION_ID = 'conversation-completion-durability';
const CONTAINER_ID = 'container-completion-durability';
const CONTAINER_NAME = 'propr-agent-completion-durability';
const WORKTREE_PATH = '/worktrees/completion-durability';
const ADMISSION_ID = 'admission-completion-durability';
const OPERATION_ID = 'operation-completion-durability';
const MODEL_NAME = 'claude-test';
const EXECUTION_TIME_MS = 8765;
const PR_NUMBER = 4711;
const PR_URL = 'https://github.com/GospeLib/main/pull/4711';
const COMMIT_HASH = 'c0ffee1234567890';

// ---------------------------------------------------------------- Redis double

const redisStore = new Map<string, string>();
const redis = {
    get: async (key: string) => redisStore.get(key) ?? null,
    setex: async (key: string, _expiry: number, value: string) => { redisStore.set(key, value); return 'OK'; },
    set: async (key: string, value: string) => { redisStore.set(key, value); return 'OK'; },
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
    /** The idempotency key the unique index in task_history is built on. */
    transition_id?: string | null;
}

const historyRows: HistoryRow[] = [];
let nextHistoryId = 1;
/** History states whose durable insert is refused, to reproduce a partially persisted success. */
const failedInsertStates = new Set<string>();
/** Refuses the in-place rewrite of an existing history entry's metadata. */
let failHistoryMetadataRewrite = false;
/**
 * History states whose insert COMMITS and then rejects, reproducing an ambiguous commit: the row
 * is durable and the client is told the write failed.
 */
const ambiguousCommitStates = new Set<string>();
/** Refuses the read-back, so whether a completion is durable cannot be established. */
let failHistoryReadBack = false;

function taskHistoryQuery() {
    let criteria: Record<string, unknown> = {};
    let expectedMetadata: string | null | undefined;
    let descending = false;
    const select = () => historyRows.filter(row =>
        Object.entries(criteria).every(([key, value]) => row[key as keyof HistoryRow] === value));
    const query = {
        insert: async (row: Omit<HistoryRow, 'history_id'>) => {
            if (row.transition_id != null && historyRows.some(existing => existing.transition_id === row.transition_id)) {
                throw new Error('UNIQUE constraint failed: task_history.transition_id');
            }
            if (failedInsertStates.has(row.state)) throw new Error(`database refused a ${row.state} history row`);
            historyRows.push({ history_id: nextHistoryId++, ...row });
            // Committed, then the acknowledgement is lost on the way back to the client.
            if (ambiguousCommitStates.has(row.state)) {
                throw new Error(`connection lost after committing a ${row.state} history row`);
            }
            return [nextHistoryId - 1];
        },
        select: (..._columns: string[]) => query,
        where: (value: Record<string, unknown>) => { criteria = { ...criteria, ...value }; return query; },
        orderBy: (_column: string, direction?: string) => { descending = direction === 'desc'; return query; },
        first: async () => {
            if (failHistoryReadBack) throw new Error('database refused the history read-back');
            const matched = [...select()].sort((a, b) => a.history_id - b.history_id);
            const row = descending ? matched.at(-1) : matched[0];
            return row ? { ...row } : undefined;
        },
        whereNull: (column: string) => { if (column === 'metadata') expectedMetadata = null; return query; },
        andWhere: (column: string, value: string) => { if (column === 'metadata') expectedMetadata = value; return query; },
        update: async (value: { metadata: string }) => {
            if (failHistoryMetadataRewrite) throw new Error('database refused the history metadata rewrite');
            const row = select()[0];
            if (!row) return 0;
            if (expectedMetadata !== undefined && row.metadata !== expectedMetadata) return 0;
            row.metadata = value.metadata;
            return 1;
        },
    };
    return query;
}

await mock.module('../packages/core/src/db/connection.js', {
    namedExports: { db: (_table: string) => taskHistoryQuery() },
});

await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});

const coreLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...coreLogger, withCorrelation: () => coreLogger },
    namedExports: { generateCorrelationId: () => 'correlation-completion-durability' },
});

// --------------------------------------------------- Barrel double for src/jobs

await mock.module('@propr/core', {
    namedExports: {
        TaskStates: TASK_STATES,
        ErrorCategories: ERROR_CATEGORIES,
        logger: { ...coreLogger, withCorrelation: () => coreLogger },
        db: (_table: string) => taskHistoryQuery(),
        redactSecrets: (value: string) => value,
        resolveAgentTerminationReason: () => undefined,
        filterCommentByAuthor: () => ({ shouldFilter: false }),
    },
});

await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment: () => '' },
});

await mock.module('fs-extra', {
    defaultExport: { ensureDir: async () => undefined, writeFile: async () => undefined },
});

const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');
const { createSessionIdCallback, createContainerIdCallback } = await import('../src/jobs/issueJobCallbacks.js');
const { recordFinalClaudeExecutionResult, finalClaudeExecutionResult, ClaudeResultPhases, provisionalClaudeExecutionResult } =
    await import('../src/jobs/claudeExecutionResult.js');
const { buildAgentOutcome } = await import('../src/jobs/executionOutcome.js');
const { markTaskTerminalState } = await import('../src/jobs/terminalTaskState.js');
const {
    publishCompletedWithDurableExecutionEvidence,
    carriesTerminalExecutionEvidence,
    terminalTransitionId,
    COMPLETION_WITHOUT_EXECUTION_EVIDENCE,
    COMPLETION_HISTORY_NOT_DURABLE,
    COMPLETION_DURABILITY_UNVERIFIABLE,
} = await import('../src/jobs/completedExecutionDurability.js');

// ------------------------------------------------------------------- Fixtures

const ISSUE_REF = { number: 4711, repoOwner: 'GospeLib', repoName: 'main' };
const CORRELATION = { admissionId: ADMISSION_ID, operationId: OPERATION_ID };
const jobLogger = { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined } as never;
const jobRedisClient = { set: async () => undefined } as never;

function successfulClaudeResult(success = true) {
    return {
        success,
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        executionTime: EXECUTION_TIME_MS,
        model: MODEL_NAME,
        summary: success ? 'Implemented the story' : undefined,
        error: success ? undefined : 'agent crashed',
    } as never;
}

const POST_PROCESSING_RESULT = { pr: { number: PR_NUMBER, url: PR_URL } } as never;
const COMMIT_RESULT = { commitHash: COMMIT_HASH, commitMessage: 'feat: land the story' } as never;

function seedProcessingTask(): void {
    const timestamp = '2026-09-20T10:00:00.000Z';
    redisStore.set(TASK_KEY, JSON.stringify({
        taskId: TASK_ID,
        issueRef: ISSUE_REF,
        correlationId: 'correlation-completion-durability',
        state: TASK_STATES.PROCESSING,
        createdAt: timestamp,
        updatedAt: timestamp,
        version: 1,
        attempts: 0,
        history: [{ state: TASK_STATES.PROCESSING, timestamp, reason: 'Task created', metadata: {} }],
    }));
}

function stateManager() {
    return new WorkerStateManager();
}

function rowsOf(state: string): HistoryRow[] {
    return historyRows.filter(row => row.state === state);
}

function durableRows(state: string): Array<Record<string, unknown>> {
    return historyRows.filter(row => row.state === state)
        .map(row => JSON.parse(row.metadata ?? '{}') as Record<string, unknown>);
}

function redisState() {
    return JSON.parse(redisStore.get(TASK_KEY) ?? '{}') as {
        state: string;
        history: Array<{ state: string; timestamp: string; metadata?: Record<string, unknown> }>;
    };
}

function claudeResultOf(metadata: Record<string, unknown>) {
    return metadata.claudeResult as { success?: boolean; resultPhase?: string } | undefined;
}

function agentOutcomeOf(metadata: Record<string, unknown>) {
    return metadata.agentOutcome as { success?: boolean } | undefined;
}

/** The invariant under test, read exactly as a consumer holding only the durable history would. */
function durableCompletionCarriesEvidence(): boolean {
    const completed = durableRows(TASK_STATES.COMPLETED);
    if (completed.length === 0) return true; // nothing was published, so nothing can be misread
    return completed.every(metadata =>
        claudeResultOf(metadata)?.resultPhase === ClaudeResultPhases.FINAL
        || typeof agentOutcomeOf(metadata)?.success === 'boolean');
}

async function startExecution(manager: InstanceType<typeof WorkerStateManager>): Promise<void> {
    await createSessionIdCallback(TASK_ID, ISSUE_REF as never, {
        modelName: MODEL_NAME,
        stateManager: manager as never,
        correlatedLogger: jobLogger,
        redisClient: jobRedisClient,
        verifiedExecutionCorrelation: CORRELATION,
    })(SESSION_ID, CONVERSATION_ID);
}

beforeEach(() => {
    redisStore.clear();
    historyRows.length = 0;
    nextHistoryId = 1;
    failedInsertStates.clear();
    ambiguousCommitStates.clear();
    failHistoryReadBack = false;
    failHistoryMetadataRewrite = false;
    seedProcessingTask();
});

describe('completed is never published without durable execution evidence', () => {
    test('a completion carrying neither a final model result nor the terminal agentOutcome is refused', async () => {
        const manager = stateManager();
        await startExecution(manager);

        await assert.rejects(
            () => publishCompletedWithDurableExecutionEvidence({
                stateManager: manager as never,
                taskId: TASK_ID,
                // Exactly what the paths used to publish: a reason and a GitHub comment, no outcome.
                metadata: { reason: 'Task completed successfully', historyMetadata: { githubComment: { url: PR_URL } } },
            }),
            new RegExp(COMPLETION_WITHOUT_EXECUTION_EVIDENCE),
        );

        assert.equal(durableRows(TASK_STATES.COMPLETED).length, 0, 'no completed row may be persisted');
        assert.equal(redisState().state, TASK_STATES.CLAUDE_EXECUTION, 'the task may not be moved to completed');
        await manager.close();
    });

    test('the provisional placeholder alone is not evidence and cannot carry a completion', async () => {
        const manager = stateManager();
        await startExecution(manager);
        const provisional = provisionalClaudeExecutionResult(SESSION_ID, CONVERSATION_ID);

        assert.equal(carriesTerminalExecutionEvidence({ claudeResult: provisional }), false);
        await assert.rejects(
            () => publishCompletedWithDurableExecutionEvidence({
                stateManager: manager as never, taskId: TASK_ID,
                metadata: { reason: 'Task completed successfully', claudeResult: provisional },
            }),
            new RegExp(COMPLETION_WITHOUT_EXECUTION_EVIDENCE),
        );
        assert.equal(durableRows(TASK_STATES.COMPLETED).length, 0);
        await manager.close();
    });

    test('the reachable partial-persistence sequence never yields a completed task without evidence', async () => {
        const manager = stateManager();
        // 1. The provisional record persists.
        await startExecution(manager);
        assert.equal(claudeResultOf(durableRows(TASK_STATES.CLAUDE_EXECUTION)[0])?.resultPhase,
            ClaudeResultPhases.PROVISIONAL);

        // 2. The in-place durable rewrite fails, and 3. the appended final entry fails too.
        failHistoryMetadataRewrite = true;
        failedInsertStates.add(TASK_STATES.CLAUDE_EXECUTION);
        failedInsertStates.add(TASK_STATES.COMPLETED);
        const claudeResult = successfulClaudeResult();
        const summary = await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS }, jobLogger);
        assert.equal(summary.resultPhase, ClaudeResultPhases.FINAL);
        await manager.updateTaskState(TASK_ID, TASK_STATES.CLAUDE_EXECUTION,
            { reason: 'agent execution completed', claudeResult: summary });
        const durableExecutionRows = durableRows(TASK_STATES.CLAUDE_EXECUTION);
        assert.equal(durableExecutionRows.length, 1, 'only the provisional row survived');
        assert.equal(claudeResultOf(durableExecutionRows[0])?.resultPhase, ClaudeResultPhases.PROVISIONAL);

        // 4. completed is attempted. The database still refuses; neither completed row nor the
        // fallback failed row can land, so the error surfaces instead of a silent completion.
        failedInsertStates.add(TASK_STATES.FAILED);
        await assert.rejects(() => markTaskTerminalState({
            stateManager: manager as never, taskId: TASK_ID, claudeResult,
            postProcessingResult: POST_PROCESSING_RESULT, commitResult: COMMIT_RESULT,
        }));

        assert.equal(durableRows(TASK_STATES.COMPLETED).length, 0,
            'a task whose execution evidence did not persist must not reach a durable completed');
        assert.notEqual(redisState().state, TASK_STATES.COMPLETED,
            'nor a published completed in Redis, which the rollback removes');
        assert.ok(durableCompletionCarriesEvidence());
        await manager.close();
    });

    test('a success whose completed entry will not persist settles as a durable failure keeping its evidence', async () => {
        const manager = stateManager();
        await startExecution(manager);
        failedInsertStates.add(TASK_STATES.COMPLETED);

        await markTaskTerminalState({
            stateManager: manager as never, taskId: TASK_ID, claudeResult: successfulClaudeResult(),
            postProcessingResult: POST_PROCESSING_RESULT, commitResult: COMMIT_RESULT,
        });

        assert.equal(durableRows(TASK_STATES.COMPLETED).length, 0);
        const failed = durableRows(TASK_STATES.FAILED);
        assert.equal(failed.length, 1, 'the work is not discarded: it settles as a durable failure');
        assert.equal(failed[0].completionPersistenceFailed, true, 'the record says why it is failed');
        assert.equal(agentOutcomeOf(failed[0])?.success, true, 'and still says the model succeeded');
        assert.deepEqual(failed[0].pr, { number: PR_NUMBER, url: PR_URL }, 'and names the work it produced');
        const failureError = failed[0].error as { message?: string; category?: string } | undefined;
        assert.match(String(failureError?.message), new RegExp(COMPLETION_HISTORY_NOT_DURABLE),
            'the failure names the bookkeeping barrier, not the agent');
        assert.equal(failureError?.category, ERROR_CATEGORIES.POST_PROCESSING);
        assert.equal(redisState().state, TASK_STATES.FAILED);
        assert.ok(durableCompletionCarriesEvidence());
        await manager.close();
    });

    test('a genuine failure still publishes a failed task and stays distinguishable', async () => {
        const manager = stateManager();
        await startExecution(manager);
        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: false, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS }, jobLogger);

        await markTaskTerminalState({
            stateManager: manager as never, taskId: TASK_ID, claudeResult: successfulClaudeResult(false),
            postProcessingResult: null, commitResult: null,
        });

        const executionMetadata = durableRows(TASK_STATES.CLAUDE_EXECUTION)[0];
        assert.equal(claudeResultOf(executionMetadata)?.success, false);
        assert.equal(claudeResultOf(executionMetadata)?.resultPhase, ClaudeResultPhases.FINAL,
            'only a final false may be read as a failure');
        const failed = durableRows(TASK_STATES.FAILED);
        assert.equal(failed.length, 1);
        assert.equal(agentOutcomeOf(failed[0])?.success, false);
        assert.equal(failed[0].completionPersistenceFailed, undefined,
            'a genuine failure is not a bookkeeping failure');
        assert.equal(durableRows(TASK_STATES.COMPLETED).length, 0);
        await manager.close();
    });

    test('a healthy success publishes completed carrying both the final result and the agent outcome', async () => {
        const manager = stateManager();
        await startExecution(manager);
        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS }, jobLogger);

        await markTaskTerminalState({
            stateManager: manager as never, taskId: TASK_ID, claudeResult: successfulClaudeResult(),
            postProcessingResult: POST_PROCESSING_RESULT, commitResult: COMMIT_RESULT,
        });

        const completed = durableRows(TASK_STATES.COMPLETED);
        assert.equal(completed.length, 1);
        assert.equal(claudeResultOf(completed[0])?.resultPhase, ClaudeResultPhases.FINAL);
        assert.equal(claudeResultOf(completed[0])?.success, true);
        assert.equal(agentOutcomeOf(completed[0])?.success, true);
        // The Redis projection carries the outcome too, for a reader that has only Redis.
        const redisCompleted = redisState().history.at(-1);
        assert.equal(redisCompleted?.state, TASK_STATES.COMPLETED);
        assert.equal(agentOutcomeOf(redisCompleted?.metadata ?? {})?.success, true);
        await manager.close();
    });

    test('correlation and container metadata survive a durable completion', async () => {
        const manager = stateManager();
        await startExecution(manager);
        await createContainerIdCallback(TASK_ID, manager as never, jobLogger, WORKTREE_PATH, CORRELATION)(
            CONTAINER_ID, CONTAINER_NAME);
        const executionEntryBefore = redisState().history.find(entry => entry.state === TASK_STATES.CLAUDE_EXECUTION);
        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS }, jobLogger);

        await markTaskTerminalState({
            stateManager: manager as never, taskId: TASK_ID, claudeResult: successfulClaudeResult(),
            postProcessingResult: POST_PROCESSING_RESULT, commitResult: COMMIT_RESULT,
        });

        const redisExecution = redisState().history.find(entry => entry.state === TASK_STATES.CLAUDE_EXECUTION);
        for (const metadata of [durableRows(TASK_STATES.CLAUDE_EXECUTION)[0], redisExecution?.metadata ?? {}]) {
            assert.equal(metadata.admissionId, ADMISSION_ID);
            assert.equal(metadata.operationId, OPERATION_ID);
            assert.equal(metadata.sessionId, SESSION_ID);
            assert.equal(metadata.containerId, CONTAINER_ID);
            assert.equal(metadata.containerName, CONTAINER_NAME);
            assert.equal(metadata.worktreePath, WORKTREE_PATH);
            assert.equal(metadata.model, MODEL_NAME);
            assert.equal(claudeResultOf(metadata)?.resultPhase, ClaudeResultPhases.FINAL);
        }
        assert.equal(redisExecution?.state, executionEntryBefore?.state, 'the entry state is untouched');
        assert.equal(redisExecution?.timestamp, executionEntryBefore?.timestamp, 'and so is its timestamp');
        await manager.close();
    });
});

describe('an ambiguous commit is established, never assumed', () => {
    test('a completed entry that commits and loses its acknowledgement is not overwritten by a failed fallback', async () => {
        const manager = stateManager();
        await startExecution(manager);
        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS }, jobLogger);
        // Every completed insert commits and then rejects; the failed fallback WOULD be acknowledged.
        ambiguousCommitStates.add(TASK_STATES.COMPLETED);

        await markTaskTerminalState({
            stateManager: manager as never, taskId: TASK_ID, claudeResult: successfulClaudeResult(),
            postProcessingResult: POST_PROCESSING_RESULT, commitResult: COMMIT_RESULT,
        });

        const completed = rowsOf(TASK_STATES.COMPLETED);
        assert.equal(completed.length, 1, 'the committed completion stands, and the key stops a duplicate landing');
        assert.equal(durableRows(TASK_STATES.FAILED).length, 0,
            'a durably completed task must never be settled as failed by a retry that could not see it');
        assert.equal(agentOutcomeOf(durableRows(TASK_STATES.COMPLETED)[0])?.success, true);
        assert.equal(redisState().state, TASK_STATES.COMPLETED,
            'and the rolled-back projection is caught up with the durable history');
        assert.ok(durableCompletionCarriesEvidence());
        await manager.close();
    });

    test('a completion whose durability cannot be read back settles nothing terminal', async () => {
        const manager = stateManager();
        await startExecution(manager);
        failedInsertStates.add(TASK_STATES.COMPLETED);
        failHistoryReadBack = true;

        await assert.rejects(() => publishCompletedWithDurableExecutionEvidence({
            stateManager: manager as never, taskId: TASK_ID,
            metadata: { reason: 'Task completed successfully', historyMetadata: { agentOutcome: { success: true } } },
        }), new RegExp(COMPLETION_DURABILITY_UNVERIFIABLE));

        assert.equal(durableRows(TASK_STATES.COMPLETED).length, 0);
        assert.equal(durableRows(TASK_STATES.FAILED).length, 0,
            'failed is written only after confirming the completion did not commit');
        await manager.close();
    });

    test('the idempotency key is stable across retries and never collides across transitions', async () => {
        assert.notEqual(terminalTransitionId(TASK_ID, TASK_STATES.COMPLETED), terminalTransitionId(TASK_ID, TASK_STATES.COMPLETED),
            'two genuinely different terminal transitions of one task get different keys');
        assert.notEqual(terminalTransitionId(TASK_ID, TASK_STATES.FAILED), terminalTransitionId(TASK_ID, TASK_STATES.COMPLETED));

        // At the database: a retry of ONE transition is rejected, two different ones both land.
        const first = terminalTransitionId(TASK_ID, TASK_STATES.COMPLETED);
        const second = terminalTransitionId(TASK_ID, TASK_STATES.COMPLETED);
        const row = (transitionId: string) => ({
            task_id: TASK_ID, state: TASK_STATES.COMPLETED, timestamp: '2026-09-20T10:05:00.000Z',
            reason: 'Task completed successfully', metadata: '{}', transition_id: transitionId,
        });
        await taskHistoryQuery().insert(row(first));
        await assert.rejects(() => taskHistoryQuery().insert(row(first)), /UNIQUE constraint failed/);
        await taskHistoryQuery().insert(row(second));
        assert.equal(rowsOf(TASK_STATES.COMPLETED).length, 2,
            'different transitions of the same task are not blocked by each other');
    });

    test('the failed settlement carries its own key, distinct from the completion it replaces', async () => {
        const manager = stateManager();
        await startExecution(manager);
        failedInsertStates.add(TASK_STATES.COMPLETED);

        await markTaskTerminalState({
            stateManager: manager as never, taskId: TASK_ID, claudeResult: successfulClaudeResult(),
            postProcessingResult: POST_PROCESSING_RESULT, commitResult: COMMIT_RESULT,
        });

        const failed = rowsOf(TASK_STATES.FAILED);
        assert.equal(failed.length, 1);
        assert.match(String(failed[0].transition_id), new RegExp(`^${TASK_STATES.FAILED}:${TASK_ID}:`),
            'the settlement is its own transition, keyed as such');
        await manager.close();
    });
});

/**
 * The publisher sweep.
 *
 * A hard-coded list of the paths known to publish `completed` can only ever check the paths
 * someone remembered; the task-import job published a model-executed completion for years while
 * such a list passed. These tests instead enumerate every source file, decide from the source
 * itself which ones publish a completion or run a model execution, and hold the whole set to the
 * invariant — so a new publisher fails this test the moment it is written, and can only pass by
 * using the barrier or by being entered, with a reason, in the ledger below (which is re-verified,
 * not trusted).
 */
const SOURCE_ROOT = new URL('../src/', import.meta.url);
const BARRIER_MODULE = 'jobs/completedExecutionDurability.ts';

/** Publishing a completion: the terminal helper, or a completed transition of the task state. */
const PUBLISHES_COMPLETED = /markTaskCompleted\(|state:\s*TaskStates\.COMPLETED|updateTaskState\w*\([^;]{0,240}?TaskStates\.COMPLETED/;
const USES_BARRIER = /publishCompletedWithDurableExecutionEvidence\(/;
const RUNS_MODEL_EXECUTION = /\.executeTask\(/;

/**
 * Completion publishers that run no model execution, so they have no execution evidence to make
 * durable. Each reason is re-checked below against the file it claims to describe.
 */
const NON_EXECUTING_COMPLETION_PATHS = new Map<string, string>([
    ['jobs/prCommentNoAuthorizedFindings.ts',
        'no authorized finding was selected, so no agent runs: the job posts a comment and completes'],
    ['jobs/prCommentReviewJob.ts',
        'the review workflow runs its own analysis, never the delivery placeholder path'],
    ['jobs/prCommentTaskFinalizer.ts',
        'reconciles a task from its BullMQ job outcome; it executes nothing itself'],
]);

async function sourceFiles(directory: URL = SOURCE_ROOT, prefix = ''): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        if (entry.isDirectory()) files.push(...await sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`));
        else if (entry.name.endsWith('.ts')) files.push(`${prefix}${entry.name}`);
    }
    return files;
}

async function classifiedSources(): Promise<Array<{ path: string; source: string }>> {
    const paths = await sourceFiles();
    return Promise.all(paths.map(async path => ({ path, source: await readFile(new URL(path, SOURCE_ROOT), 'utf8') })));
}

describe('every path that publishes completed after a model execution goes through the barrier', () => {
    test('the sweep sees the sources it is meant to police', async () => {
        const sources = await classifiedSources();
        assert.ok(sources.length > 50, 'the enumeration must actually walk the source tree');
        assert.ok(sources.some(({ path }) => path === BARRIER_MODULE), 'including the barrier itself');
        const publishers = sources.filter(({ path, source }) => path !== BARRIER_MODULE && PUBLISHES_COMPLETED.test(source))
            .map(({ path }) => path).sort();
        assert.deepEqual(publishers, [...NON_EXECUTING_COMPLETION_PATHS.keys()].sort(),
            'the publishers the sweep finds are exactly the documented non-executing ones');
        assert.ok(sources.some(({ source }) => RUNS_MODEL_EXECUTION.test(source)), 'and the model-executing paths');
    });

    test('no source publishes completed outside the barrier except a documented non-executing path', async () => {
        const sources = await classifiedSources();
        // A direct publication bypasses the barrier even in a file that also uses it, so using the
        // barrier is not an excuse here: publishing directly is allowed only for a ledger entry.
        const unguarded = sources
            .filter(({ path, source }) => path !== BARRIER_MODULE
                && PUBLISHES_COMPLETED.test(source)
                && !NON_EXECUTING_COMPLETION_PATHS.has(path))
            .map(({ path }) => path);
        assert.deepEqual(unguarded, [],
            'a path publishing completed must go through publishCompletedWithDurableExecutionEvidence, '
            + 'or be entered in NON_EXECUTING_COMPLETION_PATHS with a reason');
    });

    test('no documented exception runs a model execution, and none of them has gone stale', async () => {
        const sources = new Map((await classifiedSources()).map(({ path, source }) => [path, source]));
        for (const [path, reason] of NON_EXECUTING_COMPLETION_PATHS) {
            const source = sources.get(path);
            assert.ok(source, `${path} is listed as an exception but no longer exists: ${reason}`);
            assert.ok(PUBLISHES_COMPLETED.test(source), `${path} no longer publishes completed; remove its exception`);
            assert.doesNotMatch(source, RUNS_MODEL_EXECUTION,
                `${path} now runs a model execution, so it must publish through the barrier`);
        }
    });

    test('every model execution that completes its task completes through the barrier', async () => {
        const sources = await classifiedSources();
        const executing = sources.filter(({ source }) => RUNS_MODEL_EXECUTION.test(source));
        assert.ok(executing.length > 0, 'the sweep must find the model-executing paths');
        for (const { path, source } of executing) {
            if (!PUBLISHES_COMPLETED.test(source)) continue;
            assert.match(source, USES_BARRIER,
                `${path} runs a model execution and publishes completed, so it must use the barrier`);
        }
    });

    test('every barrier caller records the terminal agent outcome on the completion', async () => {
        const callers = (await classifiedSources())
            .filter(({ path, source }) => path !== BARRIER_MODULE && USES_BARRIER.test(source));
        assert.ok(callers.length >= 4, 'the issue, PR-comment, merge-conflict and task-import paths all use it');
        for (const { path, source } of callers) {
            assert.match(source, /agentOutcome/, `${path} must carry the terminal outcome on its completion`);
        }
    });

    test("each path's completion metadata satisfies the barrier", () => {
        const claudeResult = successfulClaudeResult();
        const finalResult = finalClaudeExecutionResult({ success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS });
        // issue job: agentOutcome in historyMetadata plus the final result on the task.
        assert.ok(carriesTerminalExecutionEvidence({
            claudeResult: finalResult,
            historyMetadata: { pr: { number: PR_NUMBER, url: PR_URL }, agentOutcome: buildAgentOutcome(claudeResult) },
        }));
        // PR comment: the completion comment plus both pieces of evidence.
        assert.ok(carriesTerminalExecutionEvidence({
            claudeResult: finalResult,
            historyMetadata: { commandMode: 'default', agentOutcome: buildAgentOutcome(claudeResult) },
        }));
        // merge conflict: the merge completion metadata plus both pieces of evidence.
        assert.ok(carriesTerminalExecutionEvidence({
            claudeResult: finalResult,
            historyMetadata: { baseBranch: 'stage', agentOutcome: buildAgentOutcome(claudeResult) },
        }));
        // Either piece alone is enough; neither is not.
        assert.ok(carriesTerminalExecutionEvidence({ historyMetadata: { agentOutcome: { success: false } } }));
        assert.ok(carriesTerminalExecutionEvidence({ claudeResult: finalResult }));
        assert.equal(carriesTerminalExecutionEvidence({ historyMetadata: { commandMode: 'default' } }), false);
    });

    test('the durability failure constant names the barrier it belongs to', () => {
        assert.equal(COMPLETION_HISTORY_NOT_DURABLE, 'COMPLETION_HISTORY_NOT_DURABLE');
    });
});

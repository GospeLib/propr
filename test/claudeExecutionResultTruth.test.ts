/**
 * Regressions for the truthfulness of the `claude_execution` task-history entry.
 *
 * The session callback writes a start-time placeholder whose `success: false` means "no result
 * yet". Before this was fixed, nothing ever corrected that entry, so a consumer reading the
 * history saw a successful execution as a failure and re-dispatched the work. These tests drive
 * the real WorkerStateManager over a Redis/DB double, so they assert what a reader holding only
 * the history actually sees.
 */
import assert from 'node:assert/strict';
import { ClaudeResultPhases as CORE_RESULT_PHASES } from '../packages/core/src/utils/workerStateManager.types.js';
import { readFile } from 'node:fs/promises';
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
const CLAUDE_EXECUTION = TASK_STATES.CLAUDE_EXECUTION;

const TASK_ID = 'task-execution-truth';
const TASK_KEY = `worker:state:${TASK_ID}`;
const SESSION_ID = 'session-execution-truth';
const CONVERSATION_ID = 'conversation-execution-truth';
const CONTAINER_ID = 'container-execution-truth';
const CONTAINER_NAME = 'propr-agent-execution-truth';
const WORKTREE_PATH = '/worktrees/execution-truth';
const ADMISSION_ID = 'admission-execution-truth';
const OPERATION_ID = 'operation-execution-truth';
const MODEL_NAME = 'claude-test';
const EXECUTION_TIME_MS = 4321;

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
}

const historyRows: HistoryRow[] = [];
let nextHistoryId = 1;

function taskHistoryQuery() {
    let criteria: Record<string, unknown> = {};
    let expectedMetadata: string | null | undefined;
    let descending = false;
    const select = () => historyRows.filter(row =>
        Object.entries(criteria).every(([key, value]) => row[key as keyof HistoryRow] === value));
    const query = {
        insert: async (row: Omit<HistoryRow, 'history_id'>) => {
            historyRows.push({ history_id: nextHistoryId++, ...row });
            return [nextHistoryId - 1];
        },
        select: (..._columns: string[]) => query,
        where: (value: Record<string, unknown>) => { criteria = { ...criteria, ...value }; return query; },
        orderBy: (_column: string, direction?: string) => { descending = direction === 'desc'; return query; },
        first: async () => {
            const matched = [...select()].sort((a, b) => a.history_id - b.history_id);
            const row = descending ? matched.at(-1) : matched[0];
            return row ? { ...row } : undefined;
        },
        whereNull: (column: string) => { if (column === 'metadata') expectedMetadata = null; return query; },
        andWhere: (column: string, value: string) => { if (column === 'metadata') expectedMetadata = value; return query; },
        update: async (value: { metadata: string }) => {
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
    namedExports: { db: (table: string) => table === 'task_history' ? taskHistoryQuery() : taskHistoryQuery() },
});

await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});

const coreLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...coreLogger, withCorrelation: () => coreLogger },
    namedExports: { generateCorrelationId: () => 'correlation-execution-truth' },
});

// --------------------------------------------------- Barrel double for src/jobs

// The durability barrier and the unverifiable outcome live in core now, so the barrel double has
// to carry them. They are the real modules, reading through the database double installed above.
const barrier = await import('../packages/core/src/utils/durableCompletionBarrier.js');
const durabilityOutcome = await import('../packages/core/src/utils/completionDurabilityOutcome.js');

await mock.module('@propr/core', {
    namedExports: {
        ...barrier,
        ...durabilityOutcome,
        TaskStates: TASK_STATES,
        ClaudeResultPhases: CORE_RESULT_PHASES,
        logger: { ...coreLogger, withCorrelation: () => coreLogger },
        db: (table: string) => table === 'task_history' ? taskHistoryQuery() : taskHistoryQuery(),
        filterCommentByAuthor: () => ({ shouldFilter: false }),
    },
});

// prCommentJobHelpers re-exports the completion comment builder, which drags in the whole
// PR-comment job graph; the execution callbacks under test do not use it.
await mock.module('../src/jobs/prCompletionComment.js', {
    namedExports: { buildCompletionComment: () => '' },
});

await mock.module('fs-extra', {
    defaultExport: { ensureDir: async () => undefined, writeFile: async () => undefined },
});

const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');
const { createSessionIdCallback, createContainerIdCallback } = await import('../src/jobs/issueJobCallbacks.js');
const { createSessionIdCallbackForPR } = await import('../src/jobs/prCommentJobHelpers.js');
const { recordFinalClaudeExecutionResult, ClaudeResultPhases } = await import('../src/jobs/claudeExecutionResult.js');

// ------------------------------------------------------------------- Fixtures

const ISSUE_REF = { number: 2291, repoOwner: 'GospeLib', repoName: 'main' };
const CORRELATION = { admissionId: ADMISSION_ID, operationId: OPERATION_ID };
const jobLogger = { info: () => undefined, warn: () => undefined, debug: () => undefined } as never;
const jobRedisClient = { set: async () => undefined } as never;

function seedProcessingTask(): void {
    const timestamp = '2026-09-20T10:00:00.000Z';
    redisStore.set(TASK_KEY, JSON.stringify({
        taskId: TASK_ID,
        issueRef: ISSUE_REF,
        correlationId: 'correlation-execution-truth',
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

/** What a reader holding only the durable history sees for the execution entry. */
function durableExecutionMetadata(): Record<string, unknown> {
    const rows = historyRows.filter(row => row.state === CLAUDE_EXECUTION);
    assert.ok(rows.length > 0, 'expected a claude_execution history row');
    return JSON.parse(rows[0].metadata ?? '{}') as Record<string, unknown>;
}

function redisExecutionMetadata(): Record<string, unknown> {
    const state = JSON.parse(redisStore.get(TASK_KEY) ?? '{}') as {
        history: Array<{ state: string; metadata?: Record<string, unknown> }>;
    };
    const entry = state.history.find(item => item.state === CLAUDE_EXECUTION);
    assert.ok(entry, 'expected a claude_execution history entry in Redis');
    return entry.metadata ?? {};
}

function claudeResultOf(metadata: Record<string, unknown>) {
    return metadata.claudeResult as { success?: boolean; resultPhase?: string; sessionId?: string } | undefined;
}

beforeEach(() => {
    redisStore.clear();
    historyRows.length = 0;
    nextHistoryId = 1;
    seedProcessingTask();
});

describe('claude_execution history truthfulness', () => {
    test('a successful execution replaces the provisional start-time record with a final successful one', async () => {
        const manager = stateManager();
        await createSessionIdCallback(TASK_ID, ISSUE_REF as never, {
            modelName: MODEL_NAME,
            stateManager: manager as never,
            correlatedLogger: jobLogger,
            redisClient: jobRedisClient,
            verifiedExecutionCorrelation: CORRELATION,
        })(SESSION_ID, CONVERSATION_ID);

        // The start-time record says so about itself: provisional, not a failure.
        const started = claudeResultOf(durableExecutionMetadata());
        assert.equal(started?.success, false);
        assert.equal(started?.resultPhase, ClaudeResultPhases.PROVISIONAL);

        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, conversationId: CONVERSATION_ID, executionTime: EXECUTION_TIME_MS });

        for (const metadata of [durableExecutionMetadata(), redisExecutionMetadata()]) {
            const settled = claudeResultOf(metadata);
            assert.equal(settled?.success, true, 'the entry describing the execution must carry its real result');
            assert.equal(settled?.resultPhase, ClaudeResultPhases.FINAL);
        }
        await manager.close();
    });

    test('a genuinely failed execution still records a failure, distinguishable from the provisional record', async () => {
        const manager = stateManager();
        await createSessionIdCallback(TASK_ID, ISSUE_REF as never, {
            modelName: MODEL_NAME,
            stateManager: manager as never,
            correlatedLogger: jobLogger,
            redisClient: jobRedisClient,
            verifiedExecutionCorrelation: CORRELATION,
        })(SESSION_ID, CONVERSATION_ID);
        assert.equal(claudeResultOf(durableExecutionMetadata())?.resultPhase, ClaudeResultPhases.PROVISIONAL);

        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: false, sessionId: SESSION_ID, conversationId: CONVERSATION_ID, executionTime: EXECUTION_TIME_MS });

        const settled = claudeResultOf(durableExecutionMetadata());
        assert.equal(settled?.success, false);
        assert.equal(settled?.resultPhase, ClaudeResultPhases.FINAL,
            'a real failure is final; only a final false may be read as a failure');
        await manager.close();
    });

    test('container-first ordering: the completion write lands although no placeholder was written', async () => {
        const manager = stateManager();
        await createContainerIdCallback(TASK_ID, manager as never, jobLogger, WORKTREE_PATH, CORRELATION)(
            CONTAINER_ID, CONTAINER_NAME);

        // Container discovery creates the entry with no claudeResult at all.
        assert.equal(claudeResultOf(durableExecutionMetadata()), undefined);

        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS });

        for (const metadata of [durableExecutionMetadata(), redisExecutionMetadata()]) {
            const settled = claudeResultOf(metadata);
            assert.equal(settled?.success, true);
            assert.equal(settled?.resultPhase, ClaudeResultPhases.FINAL);
        }
        await manager.close();
    });

    test('correlation and container metadata survive the completion write', async () => {
        const manager = stateManager();
        await createSessionIdCallback(TASK_ID, ISSUE_REF as never, {
            modelName: MODEL_NAME,
            stateManager: manager as never,
            correlatedLogger: jobLogger,
            redisClient: jobRedisClient,
            verifiedExecutionCorrelation: CORRELATION,
        })(SESSION_ID, CONVERSATION_ID);
        await createContainerIdCallback(TASK_ID, manager as never, jobLogger, WORKTREE_PATH, CORRELATION)(
            CONTAINER_ID, CONTAINER_NAME);

        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS });

        for (const metadata of [durableExecutionMetadata(), redisExecutionMetadata()]) {
            // taskHelpers durable-correlation lookup and taskWatcherLookup read these.
            assert.equal(metadata.admissionId, ADMISSION_ID);
            assert.equal(metadata.operationId, OPERATION_ID);
            assert.equal(metadata.sessionId, SESSION_ID);
            assert.equal(metadata.containerId, CONTAINER_ID);
            assert.equal(metadata.containerName, CONTAINER_NAME);
            assert.equal(metadata.worktreePath, WORKTREE_PATH);
            assert.equal(metadata.model, MODEL_NAME);
            assert.equal(claudeResultOf(metadata)?.success, true);
        }
        await manager.close();
    });

    test('the PR-comment path writes the same self-declared provisional record', async () => {
        const manager = stateManager();
        await createSessionIdCallbackForPR(TASK_ID, { pullRequestNumber: 2291, repoOwner: 'GospeLib', repoName: 'main' } as never, {
            llm: MODEL_NAME,
            stateManager: manager as never,
            correlatedLogger: jobLogger,
            redisClient: jobRedisClient,
            verifiedExecutionCorrelation: CORRELATION,
        } as never)(SESSION_ID, CONVERSATION_ID);

        const started = claudeResultOf(durableExecutionMetadata());
        assert.equal(started?.success, false);
        assert.equal(started?.resultPhase, ClaudeResultPhases.PROVISIONAL);

        await recordFinalClaudeExecutionResult(manager as never, TASK_ID,
            { success: true, sessionId: SESSION_ID, executionTime: EXECUTION_TIME_MS });
        assert.equal(claudeResultOf(durableExecutionMetadata())?.success, true);
        await manager.close();
    });
});

describe('every completion path settles its execution entry', () => {
    const paths = [
        '../src/jobs/issueJob/agent.ts',
        '../src/jobs/processPullRequestCommentJob.ts',
        '../src/jobs/mergeConflictAgentRunner.ts',
    ];

    for (const path of paths) {
        test(`${path} records the final result on the claude_execution entry`, async () => {
            const source = await readFile(new URL(path, import.meta.url), 'utf8');
            assert.match(source, /recordFinalClaudeExecutionResult\(/,
                'the completion write must supersede the provisional record');
            assert.match(source, /claudeResult: executionSummary,/,
                'the task must record the same labelled final result');
        });
    }

    test('no start-time write records an unlabelled failure placeholder', async () => {
        for (const path of ['../src/jobs/issueJobCallbacks.ts', '../src/jobs/prCommentJobHelpers.ts']) {
            const source = await readFile(new URL(path, import.meta.url), 'utf8');
            assert.doesNotMatch(source, /claudeResult: \{ success: false/,
                'a start-time placeholder must declare itself provisional');
            assert.match(source, /provisionalClaudeExecutionResult\(sessionId, conversationId\)/);
        }
    });
});

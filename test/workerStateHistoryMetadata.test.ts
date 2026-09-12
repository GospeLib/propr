import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const HISTORY_TIMESTAMP = '2026-09-11T12:00:00.000Z';
const TASK_ID = 'task-container-first';
const HISTORY_ID = 17;
const CLAUDE_EXECUTION = 'claude_execution';
const CONTAINER_ID = 'container-17';
const SESSION_ID = 'session-17';
const ADMISSION_ID = 'admission-17';
const OPERATION_ID = 'operation-17';

const redisState = {
    taskId: TASK_ID,
    issueRef: { number: 2291, repoOwner: 'GospeLib', repoName: 'main' },
    correlationId: 'correlation-17',
    state: CLAUDE_EXECUTION,
    createdAt: HISTORY_TIMESTAMP,
    updatedAt: HISTORY_TIMESTAMP,
    version: 1,
    attempts: 0,
    history: [{
        state: CLAUDE_EXECUTION,
        timestamp: HISTORY_TIMESTAMP,
        reason: 'Docker container started',
        metadata: { containerId: CONTAINER_ID },
    }],
};

const redis = {
    get: mock.fn(async () => JSON.stringify(redisState)),
    eval: mock.fn(async () => 1),
    on: mock.fn(),
    quit: mock.fn(async () => undefined),
    disconnect: mock.fn(),
};

await mock.module('ioredis', {
    namedExports: { Redis: function Redis() { return redis; } },
});

const historyRow = {
    history_id: HISTORY_ID,
    task_id: TASK_ID,
    state: CLAUDE_EXECUTION,
    timestamp: HISTORY_TIMESTAMP,
    metadata: JSON.stringify({ containerId: CONTAINER_ID }),
};

function matches(criteria: Record<string, unknown>): boolean {
    return Object.entries(criteria).every(([key, value]) => historyRow[key as keyof typeof historyRow] === value);
}

function historyQuery() {
    let criteria: Record<string, unknown> = {};
    let expectedMetadata: string | null | undefined;
    const query = {
        select: (..._columns: string[]) => query,
        where: (value: Record<string, unknown>) => {
            criteria = { ...criteria, ...value };
            return query;
        },
        orderBy: (..._order: string[]) => query,
        first: async () => matches(criteria) ? { ...historyRow } : undefined,
        whereNull: (column: string) => {
            if (column === 'metadata') expectedMetadata = null;
            return query;
        },
        andWhere: (column: string, value: string) => {
            if (column === 'metadata') expectedMetadata = value;
            return query;
        },
        update: async (value: { metadata: string }) => {
            if (!matches(criteria) || (expectedMetadata !== undefined && historyRow.metadata !== expectedMetadata)) return 0;
            historyRow.metadata = value.metadata;
            return 1;
        },
    };
    return query;
}

await mock.module('../packages/core/src/db/connection.js', {
    namedExports: {
        db: (table: string) => table === 'task_history' ? historyQuery() : {},
    },
});

const publishTaskUpdate = mock.fn(async () => undefined);
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate }) },
});

const correlatedLogger = {
    debug: mock.fn(),
    warn: mock.fn(),
};
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: {
        error: mock.fn(),
        warn: mock.fn(),
        withCorrelation: () => correlatedLogger,
    },
    namedExports: { generateCorrelationId: () => 'generated-correlation-id' },
});

const { WorkerStateManager } = await import('../packages/core/src/utils/workerStateManager.js');

test('container-first session metadata is merged into the same DB history row', async () => {
    const stateManager = new WorkerStateManager();

    await stateManager.updateHistoryMetadata(TASK_ID, CLAUDE_EXECUTION, {
        sessionId: SESSION_ID,
        admissionId: ADMISSION_ID,
        operationId: OPERATION_ID,
    });

    assert.deepEqual(JSON.parse(historyRow.metadata), {
        containerId: CONTAINER_ID,
        sessionId: SESSION_ID,
        admissionId: ADMISSION_ID,
        operationId: OPERATION_ID,
    });
    assert.equal(redis.eval.mock.callCount(), 1);
    assert.equal(publishTaskUpdate.mock.callCount(), 1);
    assert.equal(correlatedLogger.warn.mock.callCount(), 0);

    await stateManager.close();
});

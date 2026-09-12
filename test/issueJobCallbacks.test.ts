import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, mock, test } from 'node:test';

const TASK_STATES = {
    CLAUDE_EXECUTION: 'claude_execution',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
} as const;

const ensureDir = mock.fn(async () => undefined);
const writeFile = mock.fn(async () => undefined);

await mock.module('@propr/core', {
    namedExports: { TaskStates: TASK_STATES },
});

await mock.module('fs-extra', {
    defaultExport: { ensureDir, writeFile },
});

const {
    createSessionIdCallback,
    deriveVerifiedExecutionCorrelation,
} = await import('../src/jobs/issueJobCallbacks.js');

const TASK_ID = 'task-ezb-p1-03';
const SESSION_ID = 'session-ezb-p1-03';
const CONVERSATION_ID = 'conversation-ezb-p1-03';
const MODEL_NAME = 'codex-test';
const ADMISSION_ID = 'admission-ezb-p1-03';
const OPERATION_ID = 'operation-ezb-p1-03';
const RECEIPT = {
    admissionId: ADMISSION_ID,
    operationId: OPERATION_ID,
    receiptKey: 'receipt-ezb-p1-03',
};
const ISSUE_REF = {
    repoOwner: 'GospeLib',
    repoName: 'main',
    number: 2291,
    executionAdmissionReceipt: RECEIPT,
};

function createLogger() {
    return {
        info: mock.fn(),
        warn: mock.fn(),
    };
}

function createRedisClient() {
    return { set: mock.fn(async () => undefined) };
}

function createStateManager(state?: string) {
    return {
        getTaskState: mock.fn(async () => state ? { state } : undefined),
        updateHistoryMetadata: mock.fn(async () => undefined),
        updateTaskState: mock.fn(async () => undefined),
    };
}

function createCallback(state?: string, ezerAdmissionVerified = true) {
    const stateManager = createStateManager(state);
    const redisClient = createRedisClient();
    const correlatedLogger = createLogger();
    const verifiedExecutionCorrelation = deriveVerifiedExecutionCorrelation(
        ezerAdmissionVerified,
        RECEIPT,
    );
    const callback = createSessionIdCallback(TASK_ID, ISSUE_REF, {
        modelName: MODEL_NAME,
        stateManager: stateManager as never,
        correlatedLogger: correlatedLogger as never,
        redisClient: redisClient as never,
        verifiedExecutionCorrelation,
    });
    return { callback, stateManager, redisClient };
}

describe('issue execution session correlation', () => {
    test('writes verified admission and operation IDs when entering claude_execution', async () => {
        const { callback, stateManager } = createCallback();

        await callback(SESSION_ID, CONVERSATION_ID);

        assert.equal(stateManager.updateTaskState.mock.callCount(), 1);
        const [, state, update] = stateManager.updateTaskState.mock.calls[0].arguments;
        assert.equal(state, TASK_STATES.CLAUDE_EXECUTION);
        assert.deepEqual(update.historyMetadata, {
            sessionId: SESSION_ID,
            conversationId: CONVERSATION_ID,
            model: MODEL_NAME,
            admissionId: ADMISSION_ID,
            operationId: OPERATION_ID,
        });
    });

    test('writes verified admission and operation IDs to an existing claude_execution entry', async () => {
        const { callback, stateManager } = createCallback(TASK_STATES.CLAUDE_EXECUTION);

        await callback(SESSION_ID, CONVERSATION_ID);

        assert.equal(stateManager.updateHistoryMetadata.mock.callCount(), 1);
        const [, state, metadata] = stateManager.updateHistoryMetadata.mock.calls[0].arguments;
        assert.equal(state, TASK_STATES.CLAUDE_EXECUTION);
        assert.deepEqual(metadata, {
            sessionId: SESSION_ID,
            conversationId: CONVERSATION_ID,
            model: MODEL_NAME,
            admissionId: ADMISSION_ID,
            operationId: OPERATION_ID,
        });
    });

    test('does not publish raw receipt correlation for an unprotected or unverified job', async () => {
        const { callback, stateManager } = createCallback(undefined, false);

        await callback(SESSION_ID, CONVERSATION_ID);

        assert.equal(deriveVerifiedExecutionCorrelation(false, RECEIPT), undefined);
        assert.equal(deriveVerifiedExecutionCorrelation(true, undefined), undefined);
        const update = stateManager.updateTaskState.mock.calls[0].arguments[2];
        assert.equal('admissionId' in update.historyMetadata, false);
        assert.equal('operationId' in update.historyMetadata, false);
    });

    test('leaves a terminal task untouched', async () => {
        const { callback, stateManager, redisClient } = createCallback(TASK_STATES.COMPLETED);

        await callback(SESSION_ID, CONVERSATION_ID);

        assert.equal(stateManager.updateTaskState.mock.callCount(), 0);
        assert.equal(stateManager.updateHistoryMetadata.mock.callCount(), 0);
        assert.equal(redisClient.set.mock.callCount(), 0);
    });

    test('composes callback correlation from the verified result and queued receipt together', async () => {
        const source = await readFile(
            new URL('../src/jobs/issueJob/agent.ts', import.meta.url),
            'utf8',
        );

        assert.match(
            source,
            /deriveVerifiedExecutionCorrelation\(\s*context\.ezerAdmissionVerified,\s*issueRef\.executionAdmissionReceipt,\s*\)/,
        );
        assert.match(source, /verifiedExecutionCorrelation,/);
    });
});

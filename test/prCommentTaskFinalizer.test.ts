import { test, mock } from 'node:test';
import { completionCoreExports } from './helpers/completionCoreDoubles.js';
import assert from 'node:assert/strict';
import {
    TaskStates,
    type TaskState,
    type TaskStateData,
    type TaskStateExpectation,
    type UpdateMetadata,
} from '../packages/core/src/utils/workerStateManager.types.js';

await mock.module('@propr/core', {
    namedExports: {
        ...completionCoreExports,
        TaskStates,
        taskStateExpectation: (task: TaskStateData): TaskStateExpectation => ({
            state: task.state,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            correlationId: task.correlationId,
            version: task.version,
        }),
    },
});

const {
    finalizeCompletedPRCommentTask,
    finalizeFailedPRCommentTask,
} = await import('../src/jobs/prCommentTaskFinalizer.js');

function makeTask(state: TaskState = TaskStates.PROCESSING): TaskStateData {
    const timestamp = '2026-08-05T12:00:00.000Z';
    return {
        taskId: 'task-123',
        issueRef: { number: 1748, repoOwner: 'integry', repoName: 'propr' },
        correlationId: 'correlation-123',
        state,
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 0,
        history: [{ state, timestamp, reason: 'Test state' }],
    };
}

const DURABLE_TRANSITION_ID = 'completed:durable-key';

function createStore(
    initialState: TaskStateData,
    failedCasAttempts = 0,
    publication = { historyPersisted: true, eventPublished: true, errors: [] as string[] },
    /** The transition identities this store's durable history can certify. */
    durableCompletions: string[] = [DURABLE_TRANSITION_ID],
) {
    let current = structuredClone(initialState);
    let remainingFailedCasAttempts = failedCasAttempts;
    const getTaskState = mock.fn(async () => structuredClone(current));
    const updateTaskStateIfCurrentDetailed = mock.fn(async (
        _taskId: string,
        expectation: TaskStateExpectation,
        newState: TaskState,
        metadata: UpdateMetadata,
    ) => {
        if (remainingFailedCasAttempts > 0) {
            remainingFailedCasAttempts--;
            current.updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
            return null;
        }
        if (expectation.state !== current.state
            || expectation.createdAt !== current.createdAt
            || expectation.updatedAt !== current.updatedAt
            || expectation.correlationId !== current.correlationId
            || (expectation.version ?? 0) !== (current.version ?? 0)) return null;
        current.state = newState;
        current.updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
        current.history.push({
            state: newState,
            timestamp: current.updatedAt,
            reason: metadata.reason ?? 'Finalized',
            metadata: metadata.historyMetadata,
        });
        if (metadata.error) {
            current.lastError = {
                message: metadata.error.message,
                category: metadata.error.category ?? 'unknown',
                timestamp: current.updatedAt,
            };
        }
        return {
            state: structuredClone(current),
            publication,
        };
    });
    // Stands in for the real projection: it refuses anything the durable history does not hold,
    // and it appends no history row — the two properties the finalizer depends on.
    const projectDurableCompletion = mock.fn(async (_taskId: string, options: { transitionId: string }) => {
        if (!durableCompletions.includes(options.transitionId)) {
            throw new Error(`DURABLE_COMPLETION_ABSENT: no completed history row for ${options.transitionId}`);
        }
        if (current.state === TaskStates.COMPLETED) return 'already_completed' as const;
        if (current.state === TaskStates.FAILED || current.state === TaskStates.CANCELLED) return 'terminal_conflict' as const;
        current.state = TaskStates.COMPLETED;
        current.updatedAt = new Date(Date.parse(current.updatedAt) + 1).toISOString();
        return 'projected' as const;
    });
    return { getTaskState, updateTaskStateIfCurrentDetailed, projectDurableCompletion, current: () => current };
}

test('completed PR comment results close nonterminal task states', async (t) => {
    const cases = [
        { status: 'cancelled', expected: TaskStates.CANCELLED },
        { status: 'requeued', expected: TaskStates.CANCELLED },
        { status: 'rescheduled', expected: TaskStates.CANCELLED },
        { status: 'failed', expected: TaskStates.FAILED },
    ] as const;

    for (const testCase of cases) {
        await t.test(testCase.status, async () => {
            const store = createStore(makeTask());
            const result = await finalizeCompletedPRCommentTask(
                'task-123',
                { status: testCase.status, reason: 'test reason' },
                store,
            );
            assert.equal(result.outcome, 'finalized');
            assert.equal(store.current().state, testCase.expected);
        });
    }
});

/**
 * An executed outcome is the report of a job that RAN a model execution. The finalizer runs none
 * of its own, so it has no standing to certify one: it may only relay the completion the durable
 * history already holds, under the identity the executing path claimed. Everything else is a
 * refusal — never a completion minted here with a non-executing capability, which is precisely
 * the evidence-free row a value-only consumer re-dispatches on.
 */
test('an executed outcome is relayed from the durable history, never minted here', async (t) => {
    for (const status of ['complete', 'completed', 'partial'] as const) {
        await t.test(`${status} is projected from its claimed identity`, async () => {
            const store = createStore(makeTask());
            const result = await finalizeCompletedPRCommentTask(
                'task-123',
                { status, terminalTransitionId: DURABLE_TRANSITION_ID },
                store,
            );
            assert.equal(result.outcome, 'projection_reconciled');
            assert.equal(result.stateChanged, true);
            assert.equal(store.current().state, TaskStates.COMPLETED);
            assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 0,
                'nothing may be appended to the history for a completion this module did not run');
        });

        await t.test(`${status} without a claimed identity is refused`, async () => {
            const store = createStore(makeTask());
            const result = await finalizeCompletedPRCommentTask('task-123', { status }, store);
            assert.equal(result.outcome, 'unverifiable_completion');
            assert.equal(result.stateChanged, false);
            assert.equal(store.current().state, TaskStates.PROCESSING);
            assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 0);
        });

        await t.test(`${status} whose claimed row is not durable is refused`, async () => {
            const store = createStore(makeTask());
            const result = await finalizeCompletedPRCommentTask(
                'task-123',
                { status, terminalTransitionId: 'completed:never-written' },
                store,
            );
            assert.equal(result.outcome, 'unverifiable_completion');
            assert.match(result.unverifiableReason ?? '', /DURABLE_COMPLETION_ABSENT/);
            assert.equal(store.current().state, TaskStates.PROCESSING);
        });
    }
});

test('a skip settles here only when the result proves it preceded any execution', async (t) => {
    await t.test('a proven pre-execution skip completes', async () => {
        const store = createStore(makeTask());
        const result = await finalizeCompletedPRCommentTask(
            'task-123',
            { status: 'skipped', reason: 'no_authorized_review_findings', preExecutionSkip: true },
            store,
        );
        assert.equal(result.outcome, 'finalized');
        assert.equal(store.current().state, TaskStates.COMPLETED);
    });

    await t.test('an unproven skip is refused rather than completed', async () => {
        const store = createStore(makeTask());
        const result = await finalizeCompletedPRCommentTask('task-123', { status: 'skipped' }, store);
        assert.equal(result.outcome, 'unverifiable_completion');
        assert.equal(store.current().state, TaskStates.PROCESSING);
    });
});

test('unknown completed results are recorded as failures', async () => {
    const store = createStore(makeTask());
    await finalizeCompletedPRCommentTask('task-123', { status: 'mystery' }, store);

    assert.equal(store.current().state, TaskStates.FAILED);
    assert.match(store.current().lastError?.message ?? '', /Unexpected.*mystery/);
});

test('missing completed results are recorded as failures', async () => {
    const store = createStore(makeTask());
    await finalizeCompletedPRCommentTask('task-123', undefined, store);

    assert.equal(store.current().state, TaskStates.FAILED);
    assert.match(store.current().lastError?.message ?? '', /without a result status/);
});

test('failure finalization sanitizes errors before persisting them', async () => {
    const store = createStore(makeTask());
    await finalizeFailedPRCommentTask(
        'task-123',
        new Error('clone https://x-access-token:ghp_secretValue@github.com/integry/propr'),
        store,
    );

    assert.equal(store.current().state, TaskStates.FAILED);
    assert.doesNotMatch(store.current().lastError?.message ?? '', /ghp_secretValue/);
});

test('finalization never overwrites an existing terminal state', async () => {
    const store = createStore(makeTask(TaskStates.CANCELLED));
    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'failed' }, store);

    assert.equal(result.outcome, 'already_terminal');
    assert.equal(store.current().state, TaskStates.CANCELLED);
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 0);
});

test('a durable completion is never projected over a different terminal state', async () => {
    const store = createStore(makeTask(TaskStates.CANCELLED));
    const result = await finalizeCompletedPRCommentTask(
        'task-123',
        { status: 'complete', terminalTransitionId: DURABLE_TRANSITION_ID },
        store,
    );

    assert.equal(result.outcome, 'unverifiable_completion',
        'a completion and a cancellation disagreeing is an operator problem, not something to overwrite');
    assert.equal(store.current().state, TaskStates.CANCELLED);
});

test('finalization retries a compare-and-set conflict with fresh state', async () => {
    const store = createStore(makeTask(), 1);
    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'skipped', preExecutionSkip: true }, store);

    assert.equal(result.outcome, 'finalized');
    assert.equal(store.current().state, TaskStates.COMPLETED);
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 2);
});

test('finalization keeps retrying after five compare-and-set conflicts', async () => {
    const store = createStore(makeTask(), 5);

    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'skipped', preExecutionSkip: true }, store);

    assert.equal(result.outcome, 'finalized');
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 6);
    assert.equal(store.current().state, TaskStates.COMPLETED);
});

test('recovery finalization rejects when the task changed after its stale scan', async () => {
    const scanned = makeTask();
    scanned.version = 4;
    const refreshed = structuredClone(scanned);
    refreshed.updatedAt = '2026-08-05T12:05:00.000Z';
    refreshed.version = 5;
    const store = createStore(refreshed);
    const expectation: TaskStateExpectation = {
        state: scanned.state,
        createdAt: scanned.createdAt,
        updatedAt: scanned.updatedAt,
        correlationId: scanned.correlationId,
        version: scanned.version,
    };

    const result = await finalizeFailedPRCommentTask(
        'task-123',
        new Error('orphaned'),
        store,
        { expectation },
    );

    assert.equal(result.outcome, 'state_changed');
    assert.equal(result.stateChanged, false);
    assert.equal(store.current().state, TaskStates.PROCESSING);
    assert.equal(store.updateTaskStateIfCurrentDetailed.mock.calls.length, 1);
    assert.deepEqual(
        store.updateTaskStateIfCurrentDetailed.mock.calls[0].arguments[1],
        expectation,
    );
});

test('processor reasons are sanitized and bounded before persistence', async () => {
    const store = createStore(makeTask());
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn';
    await finalizeCompletedPRCommentTask(
        'task-123',
        { status: 'skipped', preExecutionSkip: true, reason: `${secret}${'x'.repeat(1_000)}` },
        store,
    );

    const history = store.current().history.at(-1);
    assert.ok(history);
    assert.doesNotMatch(history.reason, /ghp_/);
    assert.ok(history.reason.length <= 516);
    assert.doesNotMatch(String(history.metadata?.jobResultReason), /ghp_/);
});

test('finalization explicitly reports incomplete durable publication', async () => {
    const store = createStore(makeTask(), 0, {
        historyPersisted: false,
        eventPublished: true,
        errors: ['history: unavailable'],
    });

    const result = await finalizeCompletedPRCommentTask('task-123', { status: 'skipped', preExecutionSkip: true }, store);

    assert.equal(result.outcome, 'partial_publication');
    assert.equal(result.stateChanged, true);
    assert.equal(result.publication?.historyPersisted, false);
});

/**
 * The worker-level failure handler is the last place an unverifiable completion can be turned
 * into a `failed` record: the processor re-throws, BullMQ marks the job failed, and this
 * finalizer settles the task from that outcome. It must decline, including when the error has
 * been reduced to a BullMQ `failedReason` string and rebuilt as a plain Error.
 */
test('a job that failed with an unverifiable completion is never settled as failed', async () => {
    const store = createStore(makeTask());

    const result = await finalizeFailedPRCommentTask(
        'task-123',
        new Error('COMPLETION_DURABILITY_UNVERIFIABLE: database refused the history read-back'),
        store,
    );

    assert.equal(result.outcome, 'unverifiable_completion');
    assert.equal(result.stateChanged, false);
    assert.equal(store.current().state, TaskStates.PROCESSING, 'the task keeps its non-terminal state');
});

test('a genuine job failure still settles the task', async () => {
    const store = createStore(makeTask());

    const result = await finalizeFailedPRCommentTask('task-123', new Error('agent execution failed'), store);

    assert.equal(result.outcome, 'finalized');
    assert.equal(store.current().state, TaskStates.FAILED);
});

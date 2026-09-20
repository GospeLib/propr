/**
 * End to end on the issue path: an unverifiable completion is settled as nothing.
 *
 * The barrier raises `COMPLETION_DURABILITY_UNVERIFIABLE` so that no terminal state is written
 * while a committed completion cannot be told from an absent one. Two handlers on this path used
 * to erase that distinction: `markTaskComplete` swallowed every state error with a warning, and
 * the job's `handleGenericError` wrote `failed` for every exception. Either one turns a delivered
 * success into a re-dispatchable failure — the production defect this remediation exists to stop.
 *
 * These drive the real job helpers, not the barrier: testing the barrier alone is what let the
 * caller-side defect through.
 */
import assert from 'node:assert/strict';
import { completionCoreExports } from './helpers/completionCoreDoubles.js';
import { beforeEach, describe, mock, test } from 'node:test';

const TASK_STATES = {
    PENDING: 'pending', PROCESSING: 'processing', CLAUDE_EXECUTION: 'claude_execution',
    POST_PROCESSING: 'post_processing', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
} as const;
const TASK_ID = 'issue-task-unverifiable';
const OPERATION_ID = 'issue-job:job-unverifiable';
const noop = () => undefined;
const log = { debug: noop, info: noop, warn: noop, error: noop, withCorrelation: () => log };

/** Terminal writes observed, so "nothing was settled" is asserted rather than assumed. */
const writes: string[] = [];
let refuseCompletedHistoryWrite = false;

const stateManager = {
    getTaskState: async () => ({ state: TASK_STATES.POST_PROCESSING }),
    updateTaskState: async (_taskId: string, state: string) => {
        writes.push(state);
        if (refuseCompletedHistoryWrite && state === TASK_STATES.COMPLETED) {
            throw new Error('database refused the completed history row');
        }
        return {};
    },
    markTaskFailed: async (_taskId: string, _error: Error) => { writes.push(TASK_STATES.FAILED); return {}; },
    markTaskCancelled: async () => { writes.push(TASK_STATES.CANCELLED); return {}; },
};

await mock.module('@propr/core', {
    namedExports: {
        ...completionCoreExports,
        TaskStates: TASK_STATES,
        ErrorCategories: { CLAUDE_EXECUTION: 'claude_execution', POST_PROCESSING: 'post_processing' },
        logger: log,
        redactSecrets: (value: string) => value,
        resolveAgentTerminationReason: () => undefined,
        // The read-back the barrier performs after an ambiguous write. Refusing it is what makes
        // a completion unverifiable: it may have committed, and nothing can establish whether.
        db: () => ({ where: () => ({ first: async () => {
            if (refuseCompletedHistoryWrite) throw new Error('database refused the history read-back');
            return undefined;
        }, update: async () => undefined }) }),
        findPlanIssueByRepoAndNumber: async () => null,
        PlanIssueStatus: { CLOSED: 'closed' },
        triggerNextPendingIssue: async () => undefined,
        updatePlanIssueStatus: async () => undefined,
        safeRemoveLabel: async () => undefined,
        safeAddLabel: async () => undefined,
        formatRetryTime: () => '',
        hoursUntil: () => 0,
        issueQueue: { add: async () => undefined },
        recordLLMMetrics: async () => undefined,
    },
});

const { markTaskComplete } = await import('../src/jobs/issueJob/completion.js');
const { handleGenericError } = await import('../src/jobs/errorHandlers.js');

const CLAUDE_RESULT = {
    success: true, sessionId: 'session-unverifiable', conversationId: 'conversation-unverifiable',
    executionTime: 1234, model: 'claude-test', summary: 'delivered the story',
} as never;

function completionParams() {
    return {
        stateManager: stateManager as never,
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        issueRef: { number: 7, repoOwner: 'GospeLib', repoName: 'main' } as never,
        currentIssueLabels: [],
        claudeResult: CLAUDE_RESULT,
        postProcessingResult: { pr: { number: 7, url: 'https://example.test/pull/7' } } as never,
        commitResult: null,
        correlatedLogger: log as never,
    };
}

beforeEach(() => {
    writes.length = 0;
    refuseCompletedHistoryWrite = false;
});

describe('an unverifiable completion is settled as nothing on the issue path', () => {
    test('markTaskComplete propagates it instead of swallowing it into a silent non-terminal task', async () => {
        refuseCompletedHistoryWrite = true;

        await assert.rejects(() => markTaskComplete(completionParams()), /COMPLETION_DURABILITY_UNVERIFIABLE/);

        assert.deepEqual(writes.filter(state => state === TASK_STATES.FAILED), [],
            'a completion that may already be durable must not be followed by failed');
        assert.ok(writes.includes(TASK_STATES.COMPLETED), 'the completion was attempted; only its durability is unknown');
    });

    test('the job-level failure handler declines to settle it', async () => {
        const unverifiable = await markTaskComplete(completionParams()).then(() => undefined, (error: unknown) => error);
        refuseCompletedHistoryWrite = true;
        const raised = await markTaskComplete(completionParams()).then(() => undefined, (error: unknown) => error);
        assert.ok(raised, 'the second attempt raises the unverifiable outcome');
        assert.equal(unverifiable, undefined, 'while a healthy completion raises nothing');

        writes.length = 0;
        await assert.rejects(() => handleGenericError(raised as Error, { discard: noop } as never,
            { number: 7, repoOwner: 'GospeLib', repoName: 'main', correlationId: 'correlation-unverifiable' } as never,
            { octokit: null, claudeResult: null, worktreeInfo: undefined, correlatedLogger: log,
                stateManager: stateManager as never, taskId: TASK_ID, AI_PROCESSING_TAG: 'AI-processing' } as never),
            /COMPLETION_DURABILITY_UNVERIFIABLE/);

        assert.deepEqual(writes, [], 'the handler writes no terminal state at all');
    });

    test('a genuine failure still settles the task as failed', async () => {
        await handleGenericError(new Error('agent execution failed'), { discard: noop } as never,
            { number: 7, repoOwner: 'GospeLib', repoName: 'main', correlationId: 'correlation-unverifiable' } as never,
            { octokit: null, claudeResult: null, worktreeInfo: undefined, correlatedLogger: log,
                stateManager: stateManager as never, taskId: TASK_ID, AI_PROCESSING_TAG: 'AI-processing' } as never);

        assert.deepEqual(writes, [TASK_STATES.FAILED], 'an ordinary failure is still recorded');
    });
});

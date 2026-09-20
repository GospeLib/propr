/**
 * Regressions for the task-import job's terminal record.
 *
 * The job used to enter `claude_execution`, run the agent, and then call `markTaskCompleted`
 * unconditionally — publishing `completed` even for an execution that failed, with no final
 * `claudeResult` and no `agentOutcome` on the entry. That is the same unreadable completion the
 * durability barrier exists to prevent, on a path the barrier did not cover.
 *
 * A success now goes through the barrier carrying its terminal evidence; a failure settles as a
 * durable failure and is never published as completed.
 */
import assert from 'node:assert/strict';
import { completionCoreExports } from './helpers/completionCoreDoubles.js';
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
    CLAUDE_EXECUTION: 'claude_execution',
    POST_PROCESSING: 'post_processing',
    UNKNOWN: 'unknown',
} as const;

const REPOSITORY = 'GospeLib/main';
const SESSION_ID = 'session-task-import';
const CONVERSATION_ID = 'conversation-task-import';
const EXECUTION_TIME_MS = 4321;
const MODEL_NAME = 'claude-test';

interface RecordedUpdate {
    taskId: string;
    state: string;
    metadata: Record<string, unknown>;
}

const updates: RecordedUpdate[] = [];
const failures: Array<{ taskId: string; error: Error; metadata: Record<string, unknown> }> = [];
let markTaskCompletedCalls = 0;

/** Reproduces a database that refuses the completed history row. */
let refuseCompletedHistoryWrite = false;

const stateManager = {
    createTaskState: async () => undefined,
    updateTaskState: async (taskId: string, state: string, metadata: Record<string, unknown> = {}) => {
        updates.push({ taskId, state, metadata });
        if (refuseCompletedHistoryWrite && state === TASK_STATES.COMPLETED) {
            throw new Error('database refused the completed history row');
        }
        return {};
    },
    markTaskFailed: async (taskId: string, error: Error, metadata: Record<string, unknown> = {}) => {
        failures.push({ taskId, error, metadata });
        updates.push({ taskId, state: TASK_STATES.FAILED, metadata });
        return {};
    },
    markTaskCompleted: async () => { markTaskCompletedCalls++; return {}; },
};

let agentResult: Record<string, unknown> = {};

class UsageLimitError extends Error {}

const coreLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

await mock.module('@propr/core', {
    namedExports: {
        ...completionCoreExports,
        TaskStates: TASK_STATES,
        ErrorCategories: ERROR_CATEGORIES,
        logger: { ...coreLogger, withCorrelation: () => coreLogger },
        // The read-back the barrier performs after an ambiguous write. Refusing it is what makes
        // a completion unverifiable: it may have committed, and nothing can establish whether.
        db: () => ({ where: () => ({ first: async () => {
            if (refuseCompletedHistoryWrite) throw new Error('database refused the history read-back');
            return undefined;
        } }) }),
        getStateManager: () => stateManager,
        getAuthenticatedOctokit: async () => ({ auth: async () => ({ token: 'github-token' }) }),
        withRetry: async (operation: () => Promise<unknown>) => operation(),
        retryConfigs: { githubApi: {} },
        getRepoUrl: () => 'https://github.com/GospeLib/main.git',
        ensureRepoCloned: async () => '/repos/main',
        ensureGitRepository: async () => undefined,
        createWorktreeForIssue: async () => ({ worktreePath: '/worktrees/import', branchName: 'import' }),
        cleanupWorktree: async () => undefined,
        generateTaskImportPrompt: () => 'prompt',
        handleError: () => undefined,
        redactSecrets: (value: string) => value,
        resolveAgentTerminationReason: () => undefined,
        UsageLimitError,
        AgentRegistry: {
            getInstance: () => ({
                ensureInitialized: async () => undefined,
                getAgentByAlias: () => ({ executeTask: async () => agentResult }),
            }),
        },
    },
});

await mock.module('../src/jobs/prCommentAgentUtils.js', {
    namedExports: { resolveDefaultAgentAndModel: async () => ({ resolvedAlias: 'claude', resolvedModel: MODEL_NAME }) },
});

await mock.module('../src/jobs/issueJobHelpers.js', {
    namedExports: { handleSimpleUsageLimitError: async () => ({ status: 'usage_limit' }) },
});

const { processTaskImportJob, TASK_IMPORT_EXECUTION_FAILED } = await import('../src/jobs/processTaskImportJob.js');
const { ClaudeResultPhases } = await import('../src/jobs/claudeExecutionResult.js');

function taskImportJob() {
    return {
        id: 'job-task-import',
        name: 'task-import',
        data: { taskDescription: 'import this', repository: REPOSITORY, correlationId: 'correlation-task-import', user: 'owner' },
    } as never;
}

function completionOf(state: string): RecordedUpdate | undefined {
    return updates.find(update => update.state === state);
}

function claudeResultOf(metadata: Record<string, unknown>) {
    return metadata.claudeResult as { success?: boolean; resultPhase?: string } | undefined;
}

function agentOutcomeOf(metadata: Record<string, unknown>) {
    return (metadata.historyMetadata as Record<string, unknown> | undefined)?.agentOutcome as { success?: boolean } | undefined;
}

beforeEach(() => {
    updates.length = 0;
    failures.length = 0;
    markTaskCompletedCalls = 0;
    refuseCompletedHistoryWrite = false;
    agentResult = {
        success: true,
        logs: 'logs',
        summary: 'imported the tasks',
        modifiedFiles: [],
        modelUsed: MODEL_NAME,
        sessionId: SESSION_ID,
        conversationId: CONVERSATION_ID,
        executionTimeMs: EXECUTION_TIME_MS,
        rawOutput: 'raw',
        conversationLog: [],
    };
});

describe('the task-import job records terminal execution evidence', () => {
    test('a successful agent run publishes completed through the durability barrier', async () => {
        const result = await processTaskImportJob(taskImportJob());

        assert.equal(result.status, 'complete');
        assert.equal(markTaskCompletedCalls, 0, 'the unguarded completion helper may not be used');
        const completed = completionOf(TASK_STATES.COMPLETED);
        assert.ok(completed, 'the job must publish completed');
        assert.equal(completed?.metadata.requireDurableHistory, true, 'through the barrier, which requires durable history');
        assert.equal(typeof completed?.metadata.transitionId, 'string', 'carrying its idempotency key');
        assert.equal(claudeResultOf(completed?.metadata ?? {})?.resultPhase, ClaudeResultPhases.FINAL);
        assert.equal(claudeResultOf(completed?.metadata ?? {})?.success, true);
        assert.equal(agentOutcomeOf(completed?.metadata ?? {})?.success, true);
        assert.equal(failures.length, 0);
    });

    test('an unsuccessful agent run fails terminally and is never published as completed', async () => {
        agentResult = { ...agentResult, success: false, error: 'the agent crashed', summary: undefined };

        await assert.rejects(() => processTaskImportJob(taskImportJob()), new RegExp(TASK_IMPORT_EXECUTION_FAILED));

        assert.equal(markTaskCompletedCalls, 0);
        assert.equal(completionOf(TASK_STATES.COMPLETED), undefined,
            'a failed execution may not reach completed');
        assert.equal(failures.length, 1, 'it settles as a failure instead');
        const failure = failures[0];
        assert.match(failure.error.message, new RegExp(TASK_IMPORT_EXECUTION_FAILED));
        assert.equal(failure.metadata.errorCategory, ERROR_CATEGORIES.CLAUDE_EXECUTION);
        assert.equal(claudeResultOf(failure.metadata)?.resultPhase, ClaudeResultPhases.FINAL,
            'the failure carries the real, final execution result');
        assert.equal(claudeResultOf(failure.metadata)?.success, false);
        assert.equal(agentOutcomeOf(failure.metadata)?.success, false,
            'and the terminal agent outcome a consumer reads');
    });

    /**
     * End to end through the processor, not through the barrier.
     *
     * The barrier throws `COMPLETION_DURABILITY_UNVERIFIABLE` so that NOTHING terminal is written
     * while a committed completion cannot be told from an absent one. This job's generic
     * `catch (error) { markTaskFailed(...) }` used to swallow that distinction and settle the task
     * as failed — recreating the production defect the barrier exists to prevent.
     */
    test('a completion whose durability cannot be established never becomes a failed record', async () => {
        refuseCompletedHistoryWrite = true;

        await assert.rejects(() => processTaskImportJob(taskImportJob()),
            /COMPLETION_DURABILITY_UNVERIFIABLE/);

        assert.equal(failures.length, 0,
            'the job must not settle a task whose completion may already be durable');
        assert.equal(updates.filter(update => update.state === TASK_STATES.FAILED).length, 0,
            'and no failed history entry may be written');
        assert.ok(updates.some(update => update.state === TASK_STATES.COMPLETED),
            'the completion was attempted; only its durability is unknown');
    });
});

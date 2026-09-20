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

const stateManager = {
    createTaskState: async () => undefined,
    updateTaskState: async (taskId: string, state: string, metadata: Record<string, unknown> = {}) => {
        updates.push({ taskId, state, metadata });
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
        TaskStates: TASK_STATES,
        ErrorCategories: ERROR_CATEGORIES,
        logger: { ...coreLogger, withCorrelation: () => coreLogger },
        db: () => ({ where: () => ({ first: async () => undefined }) }),
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
});

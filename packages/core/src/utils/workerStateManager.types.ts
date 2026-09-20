export const TaskStates = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    CLAUDE_EXECUTION: 'claude_execution',
    POST_PROCESSING: 'post_processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
} as const;

export type TaskState = typeof TaskStates[keyof typeof TaskStates];

export interface IssueRef {
    number: number;
    repoOwner: string;
    repoName: string;
    type?: string;
    modelName?: string;
    agentAlias?: string;
    [key: string]: unknown;
}

export interface HistoryEntry {
    state: TaskState;
    timestamp: string;
    reason: string;
    metadata?: Record<string, unknown>;
}

export interface LastError {
    message: string;
    category: string;
    timestamp: string;
}

/**
 * Which record of an execution a `ClaudeResultSummary` is.
 *
 * `provisional` is written the moment the agent starts, before any outcome exists: its
 * `success: false` is the absence of a result, never a failure. `final` is written once the
 * execution has returned and carries the real outcome. A reader holding only the task history
 * must treat a genuine failure as `final` + `success: false`; a `provisional` record that is
 * later superseded by a `final` one is not a failure.
 */
export type ClaudeResultPhase = 'provisional' | 'final';

/**
 * The phase values themselves, so the single reader of them — the durability barrier — and the
 * writers in the job tree name the same constant rather than two copies of a string literal.
 */
export const ClaudeResultPhases = {
    PROVISIONAL: 'provisional',
    FINAL: 'final',
} as const satisfies Record<string, ClaudeResultPhase>;

export interface ClaudeResultSummary {
    success: boolean;
    /** Provisional start-time placeholder vs. the execution's real outcome. Absent on legacy records. */
    resultPhase?: ClaudeResultPhase;
    sessionId?: string | null;
    executionTime?: number;
    conversationId?: string | null;
    /** Truthful outcome evidence for an admitted execution; absent for callers that do not record it. */
    terminationReason?: 'timeout' | 'max_turns';
    numTurns?: number;
    tokenUsage?: import('../agents/types.js').TokenUsage;
    finalOutput?: string;
    error?: string;
}

export interface WorktreeInfo {
    [key: string]: unknown;
}

export interface PRResult {
    prNumber?: number;
    prUrl?: string;
    [key: string]: unknown;
}

export interface TaskStateData {
    taskId: string;
    issueRef: IssueRef;
    correlationId: string;
    state: TaskState;
    createdAt: string;
    updatedAt: string;
    /** Monotonically increasing revision used for compare-and-set updates. */
    version?: number;
    attempts: number;
    history: HistoryEntry[];
    lastError?: LastError;
    worktreeInfo?: WorktreeInfo;
    claudeResult?: ClaudeResultSummary;
    prResult?: PRResult;
}

export interface TaskStateExpectation {
    state: TaskState;
    createdAt: string;
    updatedAt: string;
    correlationId: string;
    version?: number;
}

export interface TaskStatePublicationResult {
    historyPersisted: boolean;
    eventPublished: boolean;
    errors: string[];
}

export interface TaskStateUpdateResult {
    state: TaskStateData;
    publication: TaskStatePublicationResult;
}

export interface CancellationMetadata {
    cancelledBy?: 'user' | 'system';
    cancelledAt?: string;
    reason?: string;
    containerStopped?: boolean;
    containerId?: string;
}

/**
 * A durable write committed in the same transaction as a task-history row.
 *
 * Named here rather than inlined so a caller in another package can declare one without reaching
 * for the database client itself.
 */
export type DurableCommit = (transaction: import('knex').Knex.Transaction) => Promise<void>;

export interface UpdateMetadata {
    /** Refuse execution/settlement when its authoritative database history was not persisted. */
    requireDurableHistory?: boolean;
    /**
     * The capability that permits a `completed` transition. The transition builder refuses
     * `completed` without one, so the only ways to publish a completion are the durability
     * barrier and an explicit declaration that no model execution ran.
     */
    completionGuard?: import('./completionGuard.js').CompletionGuard;
    /**
     * Idempotency key for one logical terminal transition, unique in `task_history`.
     *
     * The writer keeps it identical across that transition's retries, so an INSERT that committed
     * without acknowledging the client can be read back by key, and a blind retry is rejected by
     * the constraint instead of duplicating the row.
     */
    transitionId?: string;
    /**
     * A durable record the caller needs committed ATOMICALLY with this transition's history row.
     *
     * It runs inside the same SQLite transaction as the `task_history` insert, so the two land
     * together or not at all. The execution lease is the case this exists for: a terminal state
     * that is durable while its lease is not leaves a window in which a lost projection reads the
     * operation as unrun, and paid work is admitted a second time.
     */
    durableCommit?: DurableCommit;
    isRetry?: boolean;
    error?: {
        message: string;
        category?: string;
    };
    worktreeInfo?: WorktreeInfo;
    claudeResult?: ClaudeResultSummary;
    prResult?: PRResult;
    reason?: string;
    historyMetadata?: Record<string, unknown>;
    errorCategory?: string;
    commitHash?: string;
    cancellation?: CancellationMetadata;
}

export interface TaskResult {
    prUrl?: string;
    prNumber?: number;
    commitResult?: unknown;
    [key: string]: unknown;
}

export interface ResumableTaskInfo extends TaskStateData {
    isStale: boolean;
    staleDuration?: number;
}

export interface NonTerminalTaskScanResult {
    tasks: TaskStateData[];
    nextCursor: string;
}

export interface WorkerStateManagerOptions {
    redis?: Record<string, unknown>;
    keyPrefix?: string;
    stateExpiry?: number;
}

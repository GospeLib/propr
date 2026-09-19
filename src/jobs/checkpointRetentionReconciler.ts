/**
 * Recurring reconciler for worktrees retained because a partial-work checkpoint push failed.
 *
 * Each pass, per retained worktree (oldest first, bounded per pass):
 *  1. Re-read the checkpoint ref/SHA and repository from the durable task record and retry
 *     publishing that exact commit. On verified publication, update the durable terminal
 *     record so recovery sees the published ref/SHA, then remove the worktree and record.
 *  2. Otherwise, once the worktree is older than the age bound or beyond the count bound,
 *     first make its content recoverable locally (pin the checkpoint commit, or snapshot the
 *     whole worktree to a local-only ref when there is no commit), then remove the worktree.
 *     The pinned commit stays; publication keeps being retried until the give-up bound.
 * A worktree is never removed unless its content is referenced by a remote or local ref.
 */
import type { Logger } from 'pino';
import {
    AI_COMMIT_AUTHOR, TaskStates, cleanupWorktree, getAuthenticatedOctokit, getRepoUrl, getWorktreesBasePath, logger as coreLogger,
    pinExecutionCheckpoint, publishPinnedExecutionCheckpoint, redactSecrets, snapshotWorktreeToLocalRef,
} from '@propr/core';
import type { IssueRef, TaskStateData, WorkerStateManager, ExecutionCheckpointRecord } from '@propr/core';
import path from 'node:path';
import { boundedInteger } from '../shared/boundedInteger.js';
import type { GitHubToken } from './githubTypes.js';
import { recordedExecutionCheckpoint } from './recordedExecutionCheckpoint.js';
import { listRetainedCheckpoints, removeRetainedCheckpoint, saveRetainedCheckpoint, type RetainedCheckpointEntry } from './checkpointRetentionStore.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Retry cadence; bounded so the reconciler can neither spin nor stall indefinitely. */
const DEFAULT_INTERVAL_MS = 10 * MINUTE_MS;
const MIN_INTERVAL_MS = MINUTE_MS;
const MAX_INTERVAL_MS = DAY_MS;
/** Retained-worktree disk bound: count. */
const DEFAULT_MAX_RETAINED_WORKTREES = 10;
const MAX_RETAINED_WORKTREES_CEILING = 1_000;
/** Retained-worktree disk bound: age. Kept well under the 7-day task-state expiry. */
const DEFAULT_MAX_WORKTREE_AGE_MS = 2 * DAY_MS;
const MAX_WORKTREE_AGE_CEILING_MS = 5 * DAY_MS;
/** Publication needs the durable task record; stop retrying before it can expire. */
const PUBLISH_GIVE_UP_MS = 6 * DAY_MS;
const MAX_ENTRIES_PER_PASS = 25;
const MAX_ERROR_CHARACTERS = 2_000;
const ALWAYS_DELETE_RETENTION = 'always_delete';
const TASK_SEGMENT_UNSAFE = /[^A-Za-z0-9._-]+/g;
const TASK_SEGMENT_SEPARATOR = '-';

export interface CheckpointRetentionPolicy {
    maxRetainedWorktrees: number;
    maxWorktreeAgeMs: number;
    publishGiveUpMs: number;
    maxEntriesPerPass: number;
}

export function checkpointRetentionPolicyFromEnvironment(): CheckpointRetentionPolicy {
    return {
        maxRetainedWorktrees: boundedInteger(process.env.CHECKPOINT_RETENTION_MAX_WORKTREES,
            DEFAULT_MAX_RETAINED_WORKTREES, 1, MAX_RETAINED_WORKTREES_CEILING),
        maxWorktreeAgeMs: boundedInteger(process.env.CHECKPOINT_RETENTION_MAX_WORKTREE_AGE_MS,
            DEFAULT_MAX_WORKTREE_AGE_MS, HOUR_MS, MAX_WORKTREE_AGE_CEILING_MS),
        publishGiveUpMs: PUBLISH_GIVE_UP_MS,
        maxEntriesPerPass: MAX_ENTRIES_PER_PASS,
    };
}

type RetentionStateManager = Pick<WorkerStateManager, 'getTaskState' | 'updateHistoryMetadata'>;

export interface CheckpointRetentionDependencies {
    stateManager: RetentionStateManager;
    getAuthToken?: (issueRef: IssueRef) => Promise<string>;
    repoUrlFor?: (issueRef: IssueRef) => string;
    now?: () => number;
    storeDir?: string;
    worktreesBasePath?: string;
    policy?: CheckpointRetentionPolicy;
    logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface CheckpointRetentionSummary {
    published: number;
    expired: number;
    abandoned: number;
    pending: number;
    failed: number;
    malformed: number;
}

interface Authority {
    issueRef: IssueRef;
    checkpoint?: ExecutionCheckpointRecord & { ref: string; sha: string };
    retainedWorktreePath?: unknown;
}

async function installationToken(): Promise<string> {
    const octokit = await getAuthenticatedOctokit();
    return (await octokit.auth({ type: 'installation' }) as GitHubToken).token;
}

function errorText(error: unknown): string {
    return redactSecrets((error as Error)?.message || String(error)).slice(0, MAX_ERROR_CHARACTERS);
}

/** The checkpoint and repository as recorded on the durable failed terminal entry. */
function readAuthority(state: TaskStateData | null): Authority | undefined {
    if (!state) return undefined;
    return { issueRef: state.issueRef, ...recordedExecutionCheckpoint(state) };
}

function removableWorktree(entry: RetainedCheckpointEntry, authority: Authority | undefined, basePath: string): boolean {
    const relative = path.relative(path.resolve(basePath), path.resolve(entry.worktreePath));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    const recorded = authority?.retainedWorktreePath;
    return typeof recorded !== 'string' || path.resolve(recorded) === path.resolve(entry.worktreePath);
}

async function removeWorktree(entry: RetainedCheckpointEntry): Promise<void> {
    await cleanupWorktree(entry.gitDir, entry.worktreePath, entry.branchName,
        { deleteBranch: true, success: true, retentionStrategy: ALWAYS_DELETE_RETENTION });
}

async function recordRetention(deps: CheckpointRetentionDependencies, taskId: string, metadata: Record<string, unknown>,
    log: NonNullable<CheckpointRetentionDependencies['logger']>): Promise<void> {
    try {
        await deps.stateManager.updateHistoryMetadata(taskId, TaskStates.FAILED, metadata, { requireDurableHistory: true });
    } catch (error) {
        log.warn({ taskId, error: errorText(error) }, 'Could not record checkpoint retention status on the durable task record');
    }
}

/**
 * Makes the retained content recoverable from a local ref before its worktree goes: the
 * checkpoint commit is pinned; without one (or if it cannot be pinned) the whole worktree
 * is snapshotted to a local-only ref. Throws when neither succeeds.
 */
async function preserveLocally(entry: RetainedCheckpointEntry, authority: Authority | undefined): Promise<{ localRef: string; sha: string }> {
    if (authority?.checkpoint) {
        const { ref, sha } = authority.checkpoint;
        try {
            return { localRef: await pinExecutionCheckpoint(entry.gitDir, ref, sha), sha };
        } catch {
            // Fall through: the worktree itself still holds the content.
        }
    }
    const snapshot = await snapshotWorktreeToLocalRef(entry.worktreePath,
        entry.taskId.replace(TASK_SEGMENT_UNSAFE, TASK_SEGMENT_SEPARATOR), AI_COMMIT_AUTHOR);
    entry.snapshotRef = snapshot.ref;
    return { localRef: snapshot.ref, sha: snapshot.sha };
}

type EntryOutcome = 'published' | 'expired' | 'abandoned' | 'pending' | 'failed';

interface PassContext {
    now: number;
    policy: CheckpointRetentionPolicy;
    basePath: string;
    storeDir?: string;
    log: NonNullable<CheckpointRetentionDependencies['logger']>;
}

/**
 * Retries publishing the recorded checkpoint. On verified publication the durable terminal
 * record is updated (required: recovery must see the published ref/SHA before the local
 * copy goes; on failure the next pass retries the idempotent push), then the worktree and
 * registry record are removed. Returns false, with the attempt recorded, on any failure.
 */
async function tryPublish(entry: RetainedCheckpointEntry, authority: Authority & { checkpoint: NonNullable<Authority['checkpoint']> },
    deps: CheckpointRetentionDependencies, context: PassContext): Promise<boolean> {
    const { ref, sha } = authority.checkpoint;
    try {
        const authToken = await (deps.getAuthToken ?? installationToken)(authority.issueRef);
        await publishPinnedExecutionCheckpoint({ repoPath: entry.gitDir, ref, sha,
            repoUrl: (deps.repoUrlFor ?? getRepoUrl)(authority.issueRef), authToken });
        const published: ExecutionCheckpointRecord = { ...authority.checkpoint, status: 'preserved' };
        delete published.error;
        delete published.localRef;
        await deps.stateManager.updateHistoryMetadata(entry.taskId, TaskStates.FAILED, {
            executionCheckpoint: published, retainedWorktreePath: null,
            checkpointRetention: { status: 'published', publishedAt: new Date(context.now).toISOString(),
                publishAttempts: entry.publishAttempts + 1 },
        }, { requireDurableHistory: true });
    } catch (error) {
        entry.publishAttempts += 1;
        entry.lastError = errorText(error);
        return false;
    }
    if (!entry.worktreeRemovedAt) {
        if (removableWorktree(entry, authority, context.basePath)) await removeWorktree(entry);
        else context.log.error({ taskId: entry.taskId, worktreePath: entry.worktreePath },
            'Published checkpoint, but the retained worktree path is not the recorded one; leaving it in place');
    }
    await removeRetainedCheckpoint(entry.worktreePath, context.storeDir);
    context.log.info({ taskId: entry.taskId, ref, sha }, 'Published retained partial-work checkpoint');
    return true;
}

/** Removes an expired retained worktree only after its content is held by a local ref. */
async function expireWorktree(entry: RetainedCheckpointEntry, authority: Authority | undefined,
    deps: CheckpointRetentionDependencies, context: PassContext & { overCapacity: boolean }): Promise<EntryOutcome> {
    const { overCapacity } = context;
    const { log, storeDir } = context;
    if (!removableWorktree(entry, authority, context.basePath)) {
        log.error({ taskId: entry.taskId, worktreePath: entry.worktreePath }, 'Retained worktree path is not the recorded one; refusing to remove it');
        await saveRetainedCheckpoint(entry, storeDir);
        return 'failed';
    }
    try {
        const preserved = await preserveLocally(entry, authority);
        await removeWorktree(entry);
        entry.worktreeRemovedAt = new Date(context.now).toISOString();
        await recordRetention(deps, entry.taskId, { retainedWorktreePath: null, checkpointRetention: {
            status: 'worktree_expired', gitDir: entry.gitDir, ...preserved, expiredAt: entry.worktreeRemovedAt,
            reason: overCapacity ? 'count_bound' : 'age_bound' } }, log);
        log.warn({ taskId: entry.taskId, ...preserved }, 'Removed expired retained worktree after preserving its content under a local ref');
    } catch (error) {
        entry.lastError = errorText(error);
        log.error({ taskId: entry.taskId, error: entry.lastError }, 'Could not preserve retained worktree content; keeping the worktree');
        await saveRetainedCheckpoint(entry, storeDir);
        return 'failed';
    }
    // Only a local-only snapshot exists without a recorded checkpoint: nothing is left to publish.
    if (authority?.checkpoint) await saveRetainedCheckpoint(entry, storeDir);
    else await removeRetainedCheckpoint(entry.worktreePath, storeDir);
    return 'expired';
}

async function reconcileEntry(entry: RetainedCheckpointEntry, overCapacity: boolean, deps: CheckpointRetentionDependencies,
    context: PassContext): Promise<EntryOutcome> {
    const authority = readAuthority(await deps.stateManager.getTaskState(entry.taskId));
    if (authority?.checkpoint && await tryPublish(entry, { ...authority, checkpoint: authority.checkpoint }, deps, context)) return 'published';

    const age = context.now - Date.parse(entry.retainedAt);
    if (!entry.worktreeRemovedAt) {
        if (age >= context.policy.maxWorktreeAgeMs || overCapacity) return expireWorktree(entry, authority, deps, { ...context, overCapacity });
    } else if (!authority?.checkpoint || age >= context.policy.publishGiveUpMs) {
        await recordRetention(deps, entry.taskId, { checkpointRetention: { status: 'publication_abandoned', gitDir: entry.gitDir,
            localRef: entry.snapshotRef, abandonedAt: new Date(context.now).toISOString(), lastError: entry.lastError } }, context.log);
        await removeRetainedCheckpoint(entry.worktreePath, context.storeDir);
        context.log.error({ taskId: entry.taskId, gitDir: entry.gitDir }, 'Stopped retrying checkpoint publication; the commit stays pinned locally');
        return 'abandoned';
    }
    await saveRetainedCheckpoint(entry, context.storeDir);
    return 'pending';
}

/** One bounded reconciliation pass over every retained checkpoint worktree. */
export async function reconcileRetainedCheckpoints(deps: CheckpointRetentionDependencies): Promise<CheckpointRetentionSummary> {
    const log = deps.logger ?? coreLogger;
    const policy = deps.policy ?? checkpointRetentionPolicyFromEnvironment();
    const now = (deps.now ?? Date.now)();
    const basePath = deps.worktreesBasePath ?? getWorktreesBasePath();
    const { entries, malformed } = await listRetainedCheckpoints(deps.storeDir);
    if (malformed.length) log.error({ malformed }, 'Malformed retained-checkpoint records left in place for inspection');
    const held = entries.filter(entry => !entry.worktreeRemovedAt);
    const overCapacity = new Set(held.slice(0, Math.max(0, held.length - policy.maxRetainedWorktrees)).map(entry => entry.worktreePath));
    // Disk-holding entries first, oldest first; the rest after, within the per-pass bound.
    const ordered = [...held, ...entries.filter(entry => entry.worktreeRemovedAt)].slice(0, policy.maxEntriesPerPass);
    const summary: CheckpointRetentionSummary = { published: 0, expired: 0, abandoned: 0, pending: 0, failed: 0, malformed: malformed.length };
    for (const entry of ordered) {
        try {
            summary[await reconcileEntry(entry, overCapacity.has(entry.worktreePath), deps,
                { now, policy, basePath, storeDir: deps.storeDir, log })] += 1;
        } catch (error) {
            summary.failed += 1;
            log.error({ taskId: entry.taskId, error: errorText(error) }, 'Retained checkpoint reconciliation failed');
        }
    }
    return summary;
}

export interface CheckpointRetentionReconciler {
    runOnce(): Promise<CheckpointRetentionSummary | undefined>;
    close(): Promise<void>;
}

/** Starts the recurring reconciler: one pass now, then every interval, never overlapping. */
export function startCheckpointRetentionReconciler(deps: CheckpointRetentionDependencies & { intervalMs?: number }): CheckpointRetentionReconciler {
    const log = deps.logger ?? coreLogger;
    const intervalMs = deps.intervalMs ?? boundedInteger(process.env.CHECKPOINT_RETENTION_RECONCILE_INTERVAL_MS,
        DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    let active: Promise<CheckpointRetentionSummary | undefined> | null = null;
    let closed = false;
    const runOnce = (): Promise<CheckpointRetentionSummary | undefined> => {
        if (closed) return Promise.resolve(undefined);
        active ??= reconcileRetainedCheckpoints(deps)
            .catch(error => { log.error({ error: errorText(error) }, 'Retained checkpoint reconciliation pass failed'); return undefined; })
            .finally(() => { active = null; });
        return active;
    };
    const timer = setInterval(() => { void runOnce(); }, intervalMs);
    timer.unref();
    void runOnce();
    return {
        runOnce,
        async close(): Promise<void> {
            closed = true;
            clearInterval(timer);
            await active;
        },
    };
}

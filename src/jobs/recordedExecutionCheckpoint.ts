/**
 * The partial-work checkpoint ProPR itself recorded for a stopped admitted task, and the rule that
 * a signed recovery may resume only such a checkpoint of the very issue it executes.
 *
 * Each Ezer unit, including every repository lane of a story, has its own execution issue. Binding
 * `recovery.checkpoint` to the source task's durable record (same repository, same issue, same ref,
 * same commit, same base) means a lane can never restore another lane's or its story's work, even
 * when the checkpoint ref is well formed and signed.
 */
import { TaskStates, requireExecutionRecoveryCheckpoint } from '@propr/core';
import type { ExecutionCheckpointRecord, IssueRef, StoryExecutionContract, TaskStateData, WorkerStateManager } from '@propr/core';

/** Only a checkpoint verified on the remote can be fetched into a fresh worktree. */
const PUBLISHED_CHECKPOINT = 'preserved';

export interface RecordedExecutionCheckpoint {
    /** The published or pinned checkpoint, when the record names a valid ref and commit. */
    checkpoint?: ExecutionCheckpointRecord & { ref: string; sha: string };
    retainedWorktreePath?: unknown;
}

/** The checkpoint recorded on the task's latest durable failed terminal entry. */
export function recordedExecutionCheckpoint(state: TaskStateData): RecordedExecutionCheckpoint {
    const entry = [...state.history].reverse().find(item => item.state === TaskStates.FAILED && item.metadata?.executionCheckpoint);
    const recorded = entry?.metadata?.executionCheckpoint as ExecutionCheckpointRecord | undefined;
    let checkpoint: RecordedExecutionCheckpoint['checkpoint'];
    try {
        if (recorded?.ref && recorded.sha) {
            requireExecutionRecoveryCheckpoint({ ref: recorded.ref, sha: recorded.sha });
            checkpoint = recorded as RecordedExecutionCheckpoint['checkpoint'];
        }
    } catch { checkpoint = undefined; }
    return { checkpoint, retainedWorktreePath: entry?.metadata?.retainedWorktreePath };
}

/** Refuses a signed checkpoint that ProPR did not record for this exact issue's source task. */
export async function requireIssueRecordedCheckpoint(stateManager: Pick<WorkerStateManager, 'getTaskState'>,
    issueRef: Pick<IssueRef, 'repoOwner' | 'repoName' | 'number'>, execution: StoryExecutionContract): Promise<void> {
    const recovery = execution.recovery;
    const signed = recovery?.checkpoint;
    if (!recovery || !signed) return;
    const source = await stateManager.getTaskState(recovery.sourceTaskId);
    const recorded = source ? recordedExecutionCheckpoint(source).checkpoint : undefined;
    if (!source || source.issueRef.repoOwner !== issueRef.repoOwner || source.issueRef.repoName !== issueRef.repoName ||
        source.issueRef.number !== issueRef.number || recorded?.status !== PUBLISHED_CHECKPOINT ||
        recorded.ref !== signed.ref || recorded.sha !== signed.sha ||
        recorded.baseSha !== execution.baseSha)
        throw Error('STORY_EXECUTION_CHECKPOINT_NOT_RECORDED_FOR_ISSUE');
}

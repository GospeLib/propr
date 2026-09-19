/**
 * Which Ezer unit an execution admission acts for.
 *
 * `storyId` is always the approved story. A story's second repository lane is its own Ezer unit,
 * `<story>-T<nn>`, and Ezer signs it as `unitId` beside the story. Absent `unitId` means the unit is
 * the story itself. A lane unit acts only as its own task: its signed task assignment, stop control,
 * delegated grant and recovery checkpoint must all name that lane, never the story's other lanes.
 */
import { refuse } from './admissionBindings.js';
import type { StopAdmissionBinding } from './admissionBindings.js';
import { EXECUTION_CHECKPOINT_REF_PREFIX, executionCheckpointTaskSegment } from './executionRecoveryContext.js';
import type { StoryExecutionContract } from './storyExecutionContract.js';

const LANE_TASK_SUFFIX = /^-T[0-9]+$/;

export interface UnitScopedAdmission {
    storyId: string;
    unitId?: string;
    storyExecution?: StoryExecutionContract;
    control?: StopAdmissionBinding;
    typedWork?: unknown;
    artifactCorrection?: unknown;
    comment?: unknown;
}

/** The Ezer unit an admission acts for. */
export function admissionUnitId(admission: Pick<UnitScopedAdmission, 'storyId' | 'unitId'>): string {
    return admission.unitId ?? admission.storyId;
}

/** A signed unit is exactly one repository lane `<story>-T<nn>` of the signed story. */
export function requireAdmissionUnitId(value: unknown, storyId: string): string {
    if (typeof value !== 'string' || !value.startsWith(storyId) || !LANE_TASK_SUFFIX.test(value.slice(storyId.length)))
        refuse('invalid-admission-unit');
    return value;
}

/** A checkpoint may resume only the exact ProPR task the recovery names as its source. */
function requireCheckpointOfSourceTask(execution: StoryExecutionContract | undefined): void {
    const recovery = execution?.recovery;
    const checkpoint = recovery?.checkpoint;
    if (!recovery || !checkpoint) return;
    let segment: string;
    try { segment = executionCheckpointTaskSegment(recovery.sourceTaskId); } catch { refuse('checkpoint-source-task-mismatch'); }
    const tail = checkpoint.ref.slice(EXECUTION_CHECKPOINT_REF_PREFIX.length);
    if (!checkpoint.ref.startsWith(EXECUTION_CHECKPOINT_REF_PREFIX) || !tail.endsWith(`/${segment}`))
        refuse('checkpoint-source-task-mismatch');
}

export function requireUnitWithinAdmission(admission: UnitScopedAdmission): void {
    if (admission.unitId !== undefined) {
        if (admission.typedWork || admission.artifactCorrection || admission.comment ||
            (!admission.storyExecution && !admission.control)) refuse('unit-authority-mismatch');
        if (admission.storyExecution && admission.storyExecution.taskAssignment?.taskId !== admission.unitId)
            refuse('unit-task-mismatch');
    }
    if (admission.control && admission.control.unitId !== admissionUnitId(admission)) refuse('stop-authority-mismatch');
    requireCheckpointOfSourceTask(admission.storyExecution);
}

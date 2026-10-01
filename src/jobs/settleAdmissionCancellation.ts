import { AdmissionCancelledError, TaskStates, durableOperationIdentity, type JobResult, type WorkerStateManager } from '@propr/core';
import type { Logger } from 'pino';
import { publishCompletedWithDurableExecutionEvidence } from './completedExecutionDurability.js';

/** Cancellation acknowledgement is distinct from the terminal evidence Ezer observes in task history. */
export async function settleAdmissionCancellation(error: AdmissionCancelledError, taskId: string, stateManager: WorkerStateManager,
    correlatedLogger: Logger, operationId?: string): Promise<JobResult> {
    const status = error.pushedHead ? 'published-before-cancel' : 'cancelled';
    const historyMetadata = { ...(operationId ? { operationId } : {}), admissionId: error.admissionId, settlement: status, jobResultStatus: status,
        ...(error.pushedHead ? { pushedHead: error.pushedHead, commitHash: error.pushedHead } : {}) };
    if (error.pushedHead) {
        const state = await stateManager.getTaskState(taskId);
        const result = await publishCompletedWithDurableExecutionEvidence({ stateManager, taskId, correlatedLogger,
            operationId: durableOperationIdentity('ezer-cancel-publication', taskId),
            metadata: { reason: status, commitHash: error.pushedHead, claudeResult: state?.claudeResult, historyMetadata } });
        return { status, commit: error.pushedHead, pushedHead: error.pushedHead, admissionId: error.admissionId,
            ...(result.outcome === 'published' ? { terminalTransitionId: result.transitionId } : {}) };
    }
    await stateManager.updateTaskState(taskId, TaskStates.CANCELLED, { reason: status, historyMetadata, requireDurableHistory: true });
    return { status, admissionId: error.admissionId };
}

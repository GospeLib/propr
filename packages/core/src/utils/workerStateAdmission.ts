/** Persist initial admission lineage in the existing task and task-history authority. */
import { db } from '../db/connection.js';
import { TaskStates, type TaskStateData } from './workerStateManager.types.js';
const ADMISSION_PROJECTION_FAILED = 'Task admission projection failed before execution';

export async function persistTaskAdmission(state: TaskStateData, projectAdmission?: () => Promise<unknown>): Promise<string> {
    const { taskId, issueRef } = state;
    const repository = `${issueRef.repoOwner ?? 'unknown'}/${issueRef.repoName ?? 'unknown'}`;
    await db('tasks').insert({ task_id: taskId, job_id: null, correlation_id: state.correlationId,
        repository, issue_number: issueRef.number, task_type: issueRef.type ?? 'issue',
        model_name: issueRef.modelName ?? null, created_at: state.createdAt,
        initial_job_data: JSON.stringify(issueRef),
    }).onConflict('task_id').ignore();
    await db('task_history').insert({ task_id: taskId, state: TaskStates.PENDING,
        timestamp: state.createdAt, reason: 'Task created', metadata: JSON.stringify({}),
    });
    try { await projectAdmission?.(); }
    catch (error) {
        const original = error instanceof Error ? error : new Error(String(error));
        // Redis is a projection, not authority. No executor was admitted; retain
        // the failed admission in the existing durable history even if Redis is absent.
        try {
            await db('task_history').insert({ task_id: taskId, state: TaskStates.FAILED,
                timestamp: new Date().toISOString(), reason: ADMISSION_PROJECTION_FAILED,
                metadata: JSON.stringify({ admissionProjectionError: original.message, executionStarted: false }),
            });
            Object.assign(original, { admissionFailureRecorded: true });
        } catch (settlementError) { Object.assign(original, { admissionSettlementError: String(settlementError) }); }
        throw original;
    }
    return repository;
}

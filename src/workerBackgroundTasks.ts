/**
 * Recurring worker maintenance started once per worker process, before it claims jobs:
 * stale PR-comment task-state reconciliation, and publication/bounded cleanup of worktrees
 * retained because a partial-work checkpoint push failed.
 */
import type { WorkerStateManager } from '@propr/core';
import { startWorkerTaskStateRecovery } from './workerTaskStateRecovery.js';
import { startCheckpointRetentionReconciler } from './jobs/checkpointRetentionReconciler.js';

export interface WorkerBackgroundTasks {
    close(): Promise<void>;
}

export async function startWorkerBackgroundTasks(options: { stateManager: WorkerStateManager }): Promise<WorkerBackgroundTasks> {
    const taskStateRecovery = await startWorkerTaskStateRecovery({ stateManager: options.stateManager });
    const checkpointRetention = startCheckpointRetentionReconciler({ stateManager: options.stateManager });
    return {
        async close(): Promise<void> {
            await checkpointRetention.close();
            await taskStateRecovery.close();
        },
    };
}

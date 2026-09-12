import { db } from '../db/connection.js';
import type { TaskState } from './workerStateManager.types.js';

interface TaskHistoryMetadataRow {
    history_id: number;
    metadata: string | Record<string, unknown> | null;
}

export interface HistoryMetadataPersistenceOptions {
    maxAttempts: number;
    waitForRetry: (attempt: number) => Promise<void>;
}

export interface HistoryMetadataUpdate {
    taskId: string;
    historyState: TaskState;
    historyTimestamp: string;
    metadata: Record<string, unknown>;
}

function parseTaskHistoryMetadata(value: TaskHistoryMetadataRow['metadata']): Record<string, unknown> {
    if (!value) return {};
    if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
    return value;
}

export async function persistHistoryMetadata(
    update: HistoryMetadataUpdate,
    options: HistoryMetadataPersistenceOptions,
): Promise<boolean> {
    const { taskId, historyState, historyTimestamp, metadata } = update;
    for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
        const target = await db('task_history')
            .select('history_id')
            .where({ task_id: taskId, state: historyState, timestamp: historyTimestamp })
            .orderBy('history_id', 'desc')
            .first<Pick<TaskHistoryMetadataRow, 'history_id'>>();
        if (!target) {
            if (attempt === options.maxAttempts - 1) return false;
            await options.waitForRetry(attempt);
            continue;
        }

        const current = await db('task_history')
            .select('history_id', 'metadata')
            .where({ history_id: target.history_id })
            .first<TaskHistoryMetadataRow>();
        if (!current) return false;

        const serializedMetadata = JSON.stringify({
            ...parseTaskHistoryMetadata(current.metadata),
            ...metadata,
        });
        const update = db('task_history').where({ history_id: target.history_id });
        if (current.metadata === null) update.whereNull('metadata');
        else update.andWhere(
            'metadata',
            typeof current.metadata === 'string' ? current.metadata : JSON.stringify(current.metadata),
        );
        const updatedRows = await update.update({ metadata: serializedMetadata });
        if (updatedRows === 1) return true;
        await options.waitForRetry(attempt);
    }
    throw new Error(`Task history metadata update conflicted ${options.maxAttempts} times for taskId: ${taskId}`);
}

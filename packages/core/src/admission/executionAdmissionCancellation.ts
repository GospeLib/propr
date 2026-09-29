import type { Redis } from 'ioredis';
import type { Job, Queue } from 'bullmq';
import type { SourceAdmissionBinding, SourceAdmissionStep } from './admissionBindings.js';

export function cancelledExecutionAdmissionKey(admissionId: string): string {
    return `ezer:execution-admission:cancelled:${admissionId}`;
}
export function executionAdmissionJobKey(admissionId: string): string {
    return `ezer:execution-admission:job:${admissionId}`;
}
export function sourceAdmissionJobId(admissionId: string, source: SourceAdmissionBinding, step?: SourceAdmissionStep): string {
    if (step) return `ultrafix-ezer-${step.loopId}-${step.ordinal}`;
    return `${source.mode === 'merge' ? 'merge' : 'pr-comments-batch'}-ezer-${admissionId}`;
}

export class AdmissionCancelledError extends Error {
    constructor(public readonly admissionId: string, public readonly pushedHead?: string) {
        super('ezer-execution-admission-refused:cancelled');
    }
}

export async function requireAdmissionNotCancelled(store: { get(key: string): Promise<string | null> }, admissionId: string, pushedHead?: string): Promise<void> {
    if (await store.get(cancelledExecutionAdmissionKey(admissionId))) throw new AdmissionCancelledError(admissionId, pushedHead);
}

export type AdmissionCancelState = 'not-started' | 'dequeued' | 'abort-requested' | 'already-settled';

/** Persistent tombstones deliberately have no expiry: delayed jobs/tokens cannot outlive them. */
export async function cancelExecutionAdmission(input: { admissionId: string; operationId: string; reason: string }, redis: Redis, queue: Pick<Queue, 'getJob'>, onDequeued?: (job: Job) => Promise<void>): Promise<{ state: AdmissionCancelState }> {
    if (![input.admissionId, input.operationId, input.reason].every(v => typeof v === 'string' && v.trim()) ||
        !/^[a-zA-Z0-9_-]+$/.test(input.admissionId)) throw new Error('ezer-cancel-refused:invalid-request');
    await redis.set(cancelledExecutionAdmissionKey(input.admissionId), JSON.stringify(input), 'NX');
    const indexed = await redis.get(executionAdmissionJobKey(input.admissionId));
    const ids = indexed ? [indexed] : [`pr-comments-batch-ezer-${input.admissionId}`, `merge-ezer-${input.admissionId}`];
    for (const id of ids) {
        const job = await queue.getJob(id);
        if (!job) continue;
        if (job.data.executionAdmissionReceipt?.admissionId !== input.admissionId) throw new Error('ezer-cancel-refused:job-binding-mismatch');
        const state = await cancelJob(job, redis, input);
        if (state === 'dequeued') await onDequeued?.(job);
        return { state };
    }
    return { state: 'not-started' };
}

async function cancelJob(job: Job, redis: Redis, input: { admissionId: string; operationId: string; reason: string }): Promise<AdmissionCancelState> {
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') return 'already-settled';
    if (state !== 'active') {
        try { await job.remove(); return 'dequeued'; }
        catch (error) {
            const raced = await job.getState();
            if (raced === 'completed' || raced === 'failed') return 'already-settled';
            if (raced !== 'active') throw error;
        }
    }
    await redis.set(`worker:abort:${job.id}`, JSON.stringify({ ...input, timestamp: new Date().toISOString() }), 'EX', 3600);
    return 'abort-requested';
}

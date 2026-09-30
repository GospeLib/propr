import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { cancelExecutionAdmission, issueQueue, getStateManager, TaskStates } from '@propr/core';
import { verifyEzerInternalRequest } from '../ezerInternalAuth.js';

export async function postEzerAdmissionCancel(req: Request, res: Response): Promise<void> {
    if (!verifyEzerInternalRequest(req)) { res.status(403).json({ error: 'Authenticated Ezer admission cancellation required' }); return; }
    const { operationId, reason } = req.body ?? {};
    const admissionId = req.params.admissionId;
    if (typeof admissionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(admissionId) ||
        typeof operationId !== 'string' || !operationId.trim() || typeof reason !== 'string' || !reason.trim()) {
        res.status(400).json({ error: 'admissionId, operationId and reason are required' }); return;
    }
    const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '6379') });
    try { res.json(await cancelExecutionAdmission({ admissionId, operationId, reason }, redis, issueQueue, async job => {
        const manager = getStateManager();
        const data = job.data;
        await manager.createTaskState(job.id!, { number: data.pullRequestNumber, repoOwner: data.repoOwner,
            repoName: data.repoName, executionAdmissionReceipt: data.executionAdmissionReceipt }, data.correlationId);
        await manager.updateTaskState(job.id!, TaskStates.CANCELLED, { reason, requireDurableHistory: true,
            historyMetadata: { admissionId, operationId, settlement: 'not-started', jobResultStatus: 'not-started' } });
    })); }
    catch { res.status(503).json({ error: 'Cancellation could not be confirmed; retry the same request' }); }
    finally { redis.disconnect(); }
}

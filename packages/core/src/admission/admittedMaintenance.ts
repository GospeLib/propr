/** Maintenance intake shares the admission store and merge-conflict queue with owner follow-ups. */
import { admissionTokenDigest } from './ezerAdmissionClaim.js';
import { Redis } from 'ioredis';
import { db } from '../db/connection.js';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { issueQueue } from '../queue/taskQueue.js';
import type { MergeConflictJobData } from '../queue/taskQueue.types.js';
import { generateCorrelationId } from '../utils/logger.js';
import { consumeExecutionAdmission, createRedisAdmissionStore, pendingExecutionAdmissionKey, readSignedExecutionAdmission,
    inspectWorkerAdmissionReceipt, type WorkerAdmissionReceipt, type ExecutionAdmissionClaims } from './ezerExecutionAdmission.js';
import { parseMaintenanceBinding, requireExactMaintenance, refuse, type PRMaintenanceBinding } from './admissionBindings.js';
import { executionAdmissionJobKey, requireAdmissionNotCancelled } from './executionAdmissionCancellation.js';

export async function readLiveMaintenance(repository: string, prNumber: number, target: string,
    binding: PRMaintenanceBinding, publishedHead?: string): Promise<void> {
    const [owner, repo] = repository.split('/');
    const octokit = await getAuthenticatedOctokit();
    const { data: pr } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: prNumber });
    if (pr.number !== prNumber || pr.state !== 'open' || pr.draft || pr.head.repo?.full_name !== repository ||
        // After the maintenance push GitHub re-points the PR's base at the merged base commit, so the
        // admitted base is compared only before publication.
        pr.base.repo.full_name !== repository || pr.base.ref !== target || (!publishedHead && pr.base.sha !== binding.baseSha) ||
        pr.head.ref !== binding.headBranch || pr.head.sha !== (publishedHead ?? binding.headSha)) refuse('maintenance-pr-changed');
    if (publishedHead) return;
    if (pr.mergeable === false && pr.mergeable_state === 'dirty') return;
    if (pr.mergeable !== true || pr.mergeable_state !== 'behind') refuse('maintenance-no-longer-needed');
    const [{ data: checks }, { data: statuses }, { data: workflows }] = await Promise.all([
        octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { owner, repo, ref: binding.headSha, per_page: 1 }),
        octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', { owner, repo, ref: binding.headSha, per_page: 1 }),
        octokit.request('GET /repos/{owner}/{repo}/actions/runs', { owner, repo, head_sha: binding.headSha, per_page: 1 }),
    ]);
    if (checks.total_count !== 0 || statuses.total_count !== 0 || workflows.total_count !== 0) refuse('maintenance-checks-running');
}

async function requirePriorDelivery(repository: string, prNumber: number, binding: PRMaintenanceBinding, storyId: string): Promise<void> {
    const task = await db('tasks').where({ task_id: binding.priorTaskId }).first();
    if (!task || task.repository !== repository || task.pr_number !== prNumber || task.commit_hash !== binding.headSha) refuse('maintenance-prior-task-mismatch');
    const history = await db('task_history').where({ task_id: binding.priorTaskId }).orderBy('history_id', 'desc');
    if (history[0]?.state !== 'completed') refuse('maintenance-prior-task-not-completed');
    const initial = typeof task.initial_job_data === 'string' ? JSON.parse(task.initial_job_data) : task.initial_job_data;
    const receipt = initial?.executionAdmissionReceipt;
    if (!receipt?.admissionId || !receipt.operationId || receipt.storyId !== storyId ||
        !history.some(row => {
            const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
            return meta?.admissionId === receipt.admissionId && meta?.operationId === receipt.operationId;
        })) refuse('maintenance-prior-task-not-ezer');
}

async function requireMaintenanceFences(redis: Redis, data: MergeConflictJobData, publishedHead?: string): Promise<void> {
    const receipt = data.executionAdmissionReceipt!;
    await requireAdmissionNotCancelled(redis, receipt.admissionId, publishedHead);
    const jobId = `merge-ezer-${receipt.admissionId}`;
    if (await redis.get(`worker:abort:${jobId}`)) refuse('maintenance-owner-abort');
    const lock = await redis.get(`lock:pr:${data.repoOwner}:${data.repoName}:${data.pullRequestNumber}`);
    if (lock && lock !== data.correlationId) refuse('maintenance-competing-job');
    const jobs = await issueQueue.getJobs(['active', 'waiting', 'delayed', 'paused', 'prioritized', 'waiting-children']);
    if (jobs.some(job => job.id !== jobId && 'repoOwner' in job.data && job.data.repoOwner === data.repoOwner && job.data.repoName === data.repoName &&
        (('pullRequestNumber' in job.data && job.data.pullRequestNumber === data.pullRequestNumber) ||
        ('number' in job.data && job.data.number === data.pullRequestNumber)))) refuse('maintenance-competing-job');
    if (await issueQueue.isPaused()) refuse('maintenance-queue-paused');
}

/** Reuses retained consumed evidence at every fence, including after the worker receipt is taken. */
export async function requireMaintenanceJob(data: MergeConflictJobData, redis: Redis, publishedHead?: string): Promise<void> {
    const receipt = data.executionAdmissionReceipt;
    if (!receipt?.maintenance || !data.executionAdmissionTarget) refuse('maintenance-missing-binding');
    const raw = await redis.get(`ezer:execution-admission:consumed:${receipt.admissionId}`);
    if (!raw) refuse('maintenance-missing-consumed-admission');
    const stored = JSON.parse(raw);
    requireExactMaintenance(stored.maintenance, receipt.maintenance);
    if (stored.admissionId !== receipt.admissionId || stored.operationId !== receipt.operationId || stored.storyId !== receipt.storyId ||
        stored.repository !== `${data.repoOwner}/${data.repoName}` || stored.issueNumber !== data.pullRequestNumber ||
        stored.target !== data.executionAdmissionTarget || stored.executionDeadline !== receipt.executionDeadline ||
        JSON.stringify(stored.scope) !== JSON.stringify(receipt.scope) || !Number.isFinite(Date.parse(stored.executionDeadline)) ||
        Date.parse(stored.executionDeadline) <= Date.now() || data.executionAdmissionSource || receipt.source || receipt.step ||
        data.headSha !== receipt.maintenance.headSha || data.baseSha !== receipt.maintenance.baseSha ||
        data.headBranch !== receipt.maintenance.headBranch || data.baseBranch !== stored.target || data.triggerSource !== 'ezer') refuse('maintenance-worker-binding-changed');
    await requireMaintenanceFences(redis, data, publishedHead);
    await requirePriorDelivery(stored.repository, stored.issueNumber, receipt.maintenance, stored.storyId);
    await readLiveMaintenance(stored.repository, stored.issueNumber, stored.target, receipt.maintenance, publishedHead);
    await requireMaintenanceFences(redis, data, publishedHead);
}

export async function enqueueAdmittedMaintenance(input: { repository: string; prNumber: number; priorTaskId: string;
    admissionId: string; requestId: string }): Promise<{ jobId: string }> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.admissionId) || !input.requestId.trim()) refuse('invalid-maintenance-request');
    const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '6379') });
    const jobId = `merge-ezer-${input.admissionId}`;
    // Serialize retries across API processes without renewing the execution admission.
    const lockKey = `lock:ezer-maintenance:${input.admissionId}`;
    const lockOwner = generateCorrelationId();
    let locked = false;
    try {
        for (let i = 0; i < 100 && !locked; i++) {
            locked = await redis.set(lockKey, lockOwner, 'PX', 60000, 'NX') === 'OK';
            if (!locked) await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!locked) refuse('maintenance-intake-busy');
        await requireAdmissionNotCancelled(redis, input.admissionId);
        const store = createRedisAdmissionStore(redis);
        const existing = await issueQueue.getJob(jobId);
        if (existing) {
            const data = existing.data as MergeConflictJobData;
            const binding = parseMaintenanceBinding(data.executionAdmissionReceipt?.maintenance);
            if (binding.priorTaskId !== input.priorTaskId || binding.requestId !== input.requestId ||
                data.executionAdmissionReceipt?.admissionId !== input.admissionId ||
                `${data.repoOwner}/${data.repoName}` !== input.repository || data.pullRequestNumber !== input.prNumber) refuse('maintenance-replay-mismatch');
            // A completed replay must not demand that the PR still needs its already published merge.
            const raw = await store.get(`ezer:execution-admission:consumed:${input.admissionId}`);
            if (!raw) refuse('maintenance-replay-missing-evidence');
            const stored = JSON.parse(raw);
            requireExactMaintenance(stored.maintenance, binding);
            if (stored.repository !== input.repository || stored.issueNumber !== input.prNumber ||
                stored.operationId !== data.executionAdmissionReceipt.operationId || Date.parse(stored.executionDeadline) <= Date.now()) refuse('maintenance-replay-mismatch');
            return { jobId };
        }
        const token = await store.get(pendingExecutionAdmissionKey(input.repository, input.prNumber));
        if (!token) refuse('missing-pending-admission');
        const signingSecret = process.env.EZER_ADMISSION_HMAC_SECRET || '';
        const signed = readSignedExecutionAdmission({ token, signingSecret });
        const binding = parseMaintenanceBinding(signed.maintenance);
        if (signed.admissionId !== input.admissionId || binding.priorTaskId !== input.priorTaskId || binding.requestId !== input.requestId) refuse('maintenance-request-mismatch');
        const [repoOwner, repoName] = input.repository.split('/');
        const data: MergeConflictJobData = { repoOwner, repoName, pullRequestNumber: input.prNumber,
            headBranch: binding.headBranch, headSha: binding.headSha, baseSha: binding.baseSha, baseBranch: signed.target,
            triggerSource: 'ezer', systemGenerated: true, correlationId: generateCorrelationId(), executionAdmissionTarget: signed.target };
        const policy = async (claims: ExecutionAdmissionClaims) => {
            await requirePriorDelivery(input.repository, input.prNumber, binding, claims.storyId);
            await readLiveMaintenance(input.repository, input.prNumber, claims.target, binding);
            await requireMaintenanceFences(redis, { ...data, executionAdmissionReceipt: { admissionId: claims.admissionId,
                operationId: claims.operationId, receiptKey: '', maintenance: binding } });
        };
        const expected = { repository: input.repository, issueNumber: input.prNumber, maintenance: binding };
        const consumed = await store.get(`ezer:execution-admission:consumed:${input.admissionId}`);
        let receipt: WorkerAdmissionReceipt;
        if (consumed) {
            // Recover an enqueue failure using the original unspent worker receipt, never fresh authority.
            const stored = JSON.parse(consumed);
            if (stored.maintenanceTokenDigest !== admissionTokenDigest(token)) refuse('maintenance-recovery-mismatch');
            receipt = { admissionId: signed.admissionId, operationId: signed.operationId, storyId: signed.storyId,
                receiptKey: `ezer:execution-admission:receipt:${signed.admissionId}`, maintenance: binding,
                scope: signed.scope, executionDeadline: signed.expiresAt, ...(signed.version === 2 ? { version: 2 as const } : {}) };
            await inspectWorkerAdmissionReceipt({ receipt, store, expected: { ...expected, target: signed.target } });
            await policy(signed);
        } else {
            ({ receipt } = await consumeExecutionAdmission({ token, signingSecret, store, expected, preConsumePolicy: policy }));
        }
        data.executionAdmissionReceipt = receipt;
        await redis.set(executionAdmissionJobKey(input.admissionId), jobId);
        await requireMaintenanceJob(data, redis);
        const job = await issueQueue.add('processMergeConflict', data, { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false });
        try { await requireAdmissionNotCancelled(redis, input.admissionId); }
        catch (error) { if (await job.getState() !== 'active') await job.remove(); throw error; }
        return { jobId };
    } finally {
        if (locked) await redis.eval("if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", 1, lockKey, lockOwner);
        redis.disconnect();
    }
}

import { getFailingCheckEvidence } from '../webhook/checkRunHelpers.js';
import type { SourceAdmissionStep } from './admissionBindings.js';
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { getAuthenticatedOctokit } from '../auth/githubAuth.js';
import { issueQueue } from '../queue/taskQueue.js';
import type { CommentJobData, MergeConflictJobData } from '../queue/taskQueue.types.js';
import { generateCorrelationId } from '../utils/logger.js';
import { buildCodeContext } from '../webhook/commentEventHelpers.js';
import { fenceAdmittedManualCommand } from '../webhook/commentEventHandler.js';
import { resolveLlmLabel, resolveModelAlias } from '../config/modelAliases.js';
import { consumeExecutionAdmission, createRedisAdmissionStore, pendingExecutionAdmissionKey, readSignedExecutionAdmission } from './ezerExecutionAdmission.js';
import { parseSourceBinding, requireExactSource, requireExactSourceStep, refuse, type SourceAdmissionBinding } from './admissionBindings.js';
import { executionAdmissionJobKey, requireAdmissionNotCancelled, sourceAdmissionJobId } from './executionAdmissionCancellation.js';

export interface SourceReference { kind: SourceAdmissionBinding['kind']; id: number }
export function parseSourceReference(value: unknown): SourceReference {
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('invalid-source-reference');
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => !['kind', 'id'].includes(k)) ||
        !['issue_comment', 'review_comment', 'review'].includes(String(v.kind)) ||
        !Number.isSafeInteger(v.id) || Number(v.id) < 1) refuse('invalid-source-reference');
    return { kind: v.kind as SourceReference['kind'], id: Number(v.id) };
}

/** Fetch by resource kind; a numeric id alone never establishes source identity. */
export async function readLiveAdmissionSource(repository: string, prNumber: number, expected: SourceAdmissionBinding,
    target?: string, publishedHead?: string) {
    const [owner, repo] = repository.split('/');
    const octokit = await getAuthenticatedOctokit();
    const params = { owner, repo, comment_id: expected.id, review_id: expected.id, pull_number: prNumber };
    const route = expected.kind === 'issue_comment' ? 'GET /repos/{owner}/{repo}/issues/comments/{comment_id}'
        : expected.kind === 'review_comment' ? 'GET /repos/{owner}/{repo}/pulls/comments/{comment_id}'
        : 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}';
    const [{ data: raw }, { data: pr }] = await Promise.all([
        octokit.request(route, params), octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', params),
    ]);
    const message = raw as { id: number; body?: string | null; user?: { id: number; login: string } | null;
        issue_url?: string; pull_request_url?: string; state?: string; updated_at?: string; submitted_at?: string | null;
        created_at?: string; path?: string; line?: number | null; diff_hunk?: string };
    const ownerId = Number(process.env.EZER_OWNER_GITHUB_USER_ID);
    if (!Number.isSafeInteger(ownerId) || ownerId < 1 || message.user?.id !== ownerId || expected.authorId !== ownerId ||
        message.id !== expected.id || (expected.kind === 'review' && message.state?.toUpperCase() === 'DISMISSED') ||
        (expected.kind === 'issue_comment' ? message.issue_url !== `https://api.github.com/repos/${repository}/issues/${prNumber}`
            : message.pull_request_url !== `https://api.github.com/repos/${repository}/pulls/${prNumber}`) ||
        pr.state !== 'open' || pr.head.repo?.full_name !== repository || pr.base.repo.full_name !== repository ||
        (target !== undefined && pr.base.ref !== target)) refuse('source-github-scope-changed');
    const source = parseSourceBinding({ ...expected, id: message.id, authorId: message.user.id,
        bodyDigest: `sha256:${createHash('sha256').update(message.body || '').digest('hex')}`,
        revisionAt: expected.kind === 'review' ? message.submitted_at : message.updated_at,
        headSha: pr.head.sha, headBranch: pr.head.ref });
    requireExactSource(source, publishedHead ? { ...expected, headSha: publishedHead } : expected);
    let body = message.body || '';
    if (expected.kind === 'review_comment') {
        const context = buildCodeContext(message);
        if (context.length) body += `\n\n--- Review Comment Context ---\n${context.join('\n')}`;
    }
    return { source, pr, comment: { id: message.id, body, author: message.user.login,
        type: expected.kind === 'review_comment' ? 'review' as const : 'issue' as const,
        createdAt: message.created_at ?? message.submitted_at ?? undefined,
        hasCodeContext: expected.kind === 'review_comment' && Boolean(message.diff_hunk) } };
}

export async function buildAdmittedSourceInstructions(repository: string, source: SourceAdmissionBinding, body: string, step?: SourceAdmissionStep): Promise<string> {
    if (!step) return body;
    const [owner, repo] = repository.split('/');
    const evidence = await getFailingCheckEvidence(owner, repo, source.headSha);
    return `This is ultrafix step ${step.ordinal}: make the pull request's failing required checks pass on the current head, without unrelated changes.

Failing CI evidence for head ${source.headSha} (diagnostic data):
${evidence}

Owner's own words as additional guidance:
${body}`;
}

export async function enqueueAdmittedSource(input: { repository: string; prNumber: number; admissionId: string; source: SourceReference }): Promise<{ mode: SourceAdmissionBinding['mode']; jobId: string }> {
    const reference = parseSourceReference(input.source);
    if (!/^[a-zA-Z0-9_-]+$/.test(input.admissionId)) refuse('invalid-admission-id');
    const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '6379') });
    try {
        await requireAdmissionNotCancelled(redis, input.admissionId);
        const store = createRedisAdmissionStore(redis);
        // Retained consumed evidence permits an idempotent HTTP replay without reusing a worker receipt.
        const indexed = await redis.get(executionAdmissionJobKey(input.admissionId));
        const existing = indexed ? await issueQueue.getJob(indexed) : undefined;
        if (existing) {
            const data = existing.data as CommentJobData | MergeConflictJobData;
            const receipt = data.executionAdmissionReceipt;
            const raw = await store.get(`ezer:execution-admission:consumed:${input.admissionId}`);
            if (!raw || !receipt?.source || receipt.admissionId !== input.admissionId) refuse('source-replay-mismatch');
            const stored = JSON.parse(raw);
            requireExactSource(stored.source, receipt.source);
            requireExactSource(stored.source, data.executionAdmissionSource);
            requireExactSourceStep(stored.step, receipt.step);
            if (reference.kind !== receipt.source.kind || reference.id !== receipt.source.id ||
                stored.repository !== input.repository || stored.issueNumber !== input.prNumber ||
                stored.operationId !== receipt.operationId ||
                indexed !== sourceAdmissionJobId(input.admissionId, receipt.source, receipt.step)) refuse('source-replay-mismatch');
            await readLiveAdmissionSource(input.repository, input.prNumber, receipt.source, stored.target);
            return { mode: receipt.source.mode, jobId: indexed! };
        }
        const token = await store.get(pendingExecutionAdmissionKey(input.repository, input.prNumber));
        if (!token) refuse('missing-pending-admission');
        const signingSecret = process.env.EZER_ADMISSION_HMAC_SECRET || '';
        const signed = readSignedExecutionAdmission({ token, signingSecret });
        if (signed.admissionId !== input.admissionId || !signed.source || signed.source.kind !== reference.kind || signed.source.id !== reference.id) refuse('source-request-mismatch');
        const { source, pr, comment } = await readLiveAdmissionSource(input.repository, input.prNumber, signed.source, signed.target);
        if (source.mode === 'ultrafix') refuse('ultrafix-requires-fix-step');
        if (source.model) {
            if (resolveModelAlias(source.model) !== source.model) refuse('source-model-not-resolved');
            await resolveLlmLabel(source.model);
        }
        const jobId = sourceAdmissionJobId(input.admissionId, source, signed.step);
        if (await issueQueue.getJob(jobId)) refuse('source-job-identity-already-used');
        const commandInstructions = await buildAdmittedSourceInstructions(input.repository, source, comment.body, signed.step);
        const { receipt } = await consumeExecutionAdmission({ token, signingSecret, store,
            expected: { repository: input.repository, issueNumber: input.prNumber, source, step: signed.step } });
        const [repoOwner, repoName] = input.repository.split('/');
        if (source.mode === 'fix' || source.mode === 'review') await fenceAdmittedManualCommand({
            owner: repoOwner, repo: repoName, pr: input.prNumber, sourceCommentId: source.id,
            sourceCommentRevision: `${source.kind}:${source.id}:${source.generation}:${source.revisionAt}:${source.bodyDigest}`, redis });
        const common = { repoOwner, repoName, pullRequestNumber: input.prNumber, correlationId: generateCorrelationId(),
            executionAdmissionReceipt: receipt, executionAdmissionSource: source, executionAdmissionTarget: signed.target };
        const data: CommentJobData | MergeConflictJobData = source.mode === 'merge'
            ? { ...common, headBranch: source.headBranch, baseBranch: pr.base.ref, headSha: source.headSha, baseSha: pr.base.sha,
                triggerSource: 'comment', systemGenerated: true }
            : { ...common, branchName: source.headBranch, commandMode: source.mode === 'review' ? 'owner-review' : 'default',
                comments: [comment], commandInstructions,
                ...(source.model ? { requestedModels: [source.model], llm: source.model } : {}),
                ...(signed.step ? { executionAdmissionStep: signed.step } : {}) };
        await redis.set(executionAdmissionJobKey(input.admissionId), jobId);
        await requireAdmissionNotCancelled(redis, input.admissionId);
        const job = await issueQueue.add(source.mode === 'merge' ? 'processMergeConflict' : 'processPullRequestComment', data,
            { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false });
        try { await requireAdmissionNotCancelled(redis, input.admissionId); }
        catch (error) { if (await job.getState() !== 'active') await job.remove(); throw error; }
        return { mode: source.mode, jobId };
    } finally { redis.disconnect(); }
}

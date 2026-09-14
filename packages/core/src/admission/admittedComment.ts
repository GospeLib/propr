import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { consumeExecutionAdmission, createRedisAdmissionStore, pendingExecutionAdmissionKey, getAuthenticatedOctokit, issueQueue, generateCorrelationId, extractLlmFromLabels, logger } from '../index.js';

const COMMENT_PREFIX = '/ezer ';
const RESERVED_OWNER_CONTROL = /^\s*\/ezer\s+(?:stop|accept-review-stop|approve|retry|pause|resume|use)(?:\s|$)/i;
import { EZER_REVIEW_REQUEST } from './reviewRequest.js';

const COMMENT_JOB_PREFIX = 'pr-comments-batch-ezer-';

/** Reuses an existing GitHub comment; never posts or impersonates its author. */
export async function enqueueAdmittedComment(input: {
  repository: string; prNumber: number; commentId: number; body: string; admissionId: string; review?: boolean;
}): Promise<{ jobId: string; commentId: number }> {
  if (RESERVED_OWNER_CONTROL.test(input.body)) throw new Error('ezer-comment-refused:reserved-owner-control');
  const review = input.review ? EZER_REVIEW_REQUEST.exec(input.body) : null;
  if (input.review && (!review || review[1] !== input.admissionId)) throw new Error('ezer-review-refused:request-mismatch');
  if (!input.review && EZER_REVIEW_REQUEST.test(input.body)) throw new Error('ezer-review-refused:review-cannot-run-as-correction');
  const [owner, repo] = input.repository.split('/');
  const octokit = await getAuthenticatedOctokit();
  const [{ data: comment }, { data: pr }] = await Promise.all([
    octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner, repo, comment_id: input.commentId }),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner, repo, pull_number: input.prNumber }),
  ]);
  if (!comment.user || comment.issue_url !== `https://api.github.com/repos/${input.repository}/issues/${input.prNumber}` ||
      comment.body !== input.body || !input.body.startsWith(COMMENT_PREFIX) || pr.state !== 'open' ||
      pr.head.repo?.full_name !== input.repository || pr.base.repo.full_name !== input.repository) {
    throw new Error('ezer-comment-refused:github-identity-or-content-changed');
  }
  const binding = { commentId: comment.id, bodyDigest: `sha256:${createHash('sha256').update(input.body).digest('hex')}`,
    headSha: pr.head.sha, headBranch: pr.head.ref };
  const jobId = `${COMMENT_JOB_PREFIX}${input.admissionId}`;
  const existing = await issueQueue.getJob(jobId);
  if (existing) {
    if (!('commandMode' in existing.data) || existing.data.commandMode !== (review ? 'review' : 'default') || existing.data.executionAdmissionReceipt?.admissionId !== input.admissionId ||
        JSON.stringify('executionAdmissionComment' in existing.data ? existing.data.executionAdmissionComment : undefined) !== JSON.stringify(binding)) throw new Error('ezer-comment-refused:replay-mismatch');
    return { jobId, commentId: comment.id };
  }
  const redis = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || '6379') });
  try {
    const store = createRedisAdmissionStore(redis);
    const token = await store.get(pendingExecutionAdmissionKey(input.repository, input.prNumber));
    if (!token) throw new Error('ezer-comment-refused:missing-pending-admission');
    const { claims, receipt } = await consumeExecutionAdmission({ token,
      signingSecret: process.env.EZER_ADMISSION_HMAC_SECRET || '', store,
      expected: { repository: input.repository, issueNumber: input.prNumber, comment: binding } });
    if (claims.admissionId !== input.admissionId || claims.target !== pr.base.ref) throw new Error('ezer-comment-refused:wrong-admission-or-base');
    await issueQueue.add('processPullRequestComment', {
      repoOwner: owner, repoName: repo, pullRequestNumber: input.prNumber, branchName: pr.head.ref,
      correlationId: generateCorrelationId(), commandMode: review ? 'review' : 'default',
      ...(review ? { requestedModels: [review[2]!], commandInstructions: review[3]!, commandCommentId: comment.id,
        commandCommentCreatedAt: comment.created_at, commandCommentType: 'issue' as const } : {}),
      llm: extractLlmFromLabels(pr.labels, process.env.MODEL_LABEL_PATTERN || '', input.prNumber, logger.withCorrelation(input.admissionId)),
      comments: [{ id: comment.id, body: input.body, author: comment.user!.login, type: 'issue' }],
      executionAdmissionReceipt: receipt, executionAdmissionComment: binding, executionAdmissionTarget: claims.target,
    }, { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false });
    return { jobId, commentId: comment.id };
  } finally { redis.disconnect(); }
}

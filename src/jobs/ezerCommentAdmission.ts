import { createHash } from 'node:crypto';
import { createRedisAdmissionStore, requiresEzerExecutionAdmission, verifyWorkerAdmissionReceipt, getAuthenticatedOctokit, requireReviewRequestMode, type TypedArtifactCorrection, type CommentJobData } from '@propr/core';
import type { Redis } from 'ioredis';

export async function verifyAdmittedPRComment(data: CommentJobData, redis: Redis, onArtifactCorrection?: (binding: TypedArtifactCorrection) => void): Promise<boolean> {
  const repository = `${data.repoOwner}/${data.repoName}`;
  if (!data.executionAdmissionReceipt && !requiresEzerExecutionAdmission({ repository, protectedRepositories: process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES })) return false;
  requireReviewRequestMode({ body: data.comments?.[0]?.body || '', admissionId: data.executionAdmissionReceipt?.admissionId || '',
    mode: data.commandMode || '', models: data.requestedModels, instructions: data.commandInstructions });
  const binding = data.executionAdmissionComment;
  if (!binding || !data.executionAdmissionReceipt || !data.executionAdmissionTarget || data.comments?.length !== 1 || !['default', 'review'].includes(data.commandMode || '')) {
    throw new Error('ezer-comment-refused:missing-or-ambiguous-worker-admission');
  }
  const octokit = await getAuthenticatedOctokit();
  const [{ data: comment }, { data: pr }] = await Promise.all([
    octokit.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', { owner: data.repoOwner, repo: data.repoName, comment_id: binding.commentId }),
    octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: data.repoOwner, repo: data.repoName, pull_number: data.pullRequestNumber }),
  ]);
  const queued = data.comments[0];
  const actual = { commentId: comment.id, bodyDigest: `sha256:${createHash('sha256').update(comment.body || '').digest('hex')}`,
    headSha: pr.head.sha, headBranch: pr.head.ref };
  if (JSON.stringify(actual) !== JSON.stringify(binding) || queued.id !== comment.id || queued.body !== comment.body ||
      queued.author !== comment.user?.login || pr.state !== 'open' || pr.base.ref !== data.executionAdmissionTarget ||
      pr.head.repo?.full_name !== repository || pr.base.repo.full_name !== repository || data.branchName !== pr.head.ref ||
      comment.issue_url !== `https://api.github.com/repos/${repository}/issues/${data.pullRequestNumber}`) {
    throw new Error('ezer-comment-refused:github-scope-or-content-changed');
  }
  await verifyWorkerAdmissionReceipt({ receipt: data.executionAdmissionReceipt,
    expected: { repository, issueNumber: data.pullRequestNumber, target: data.executionAdmissionTarget, comment: actual },
    store: createRedisAdmissionStore(redis), onArtifactCorrection });
  return true;
}

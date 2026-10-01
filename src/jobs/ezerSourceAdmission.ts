import * as core from '@propr/core';
import type { CommentJobData, MergeConflictJobData, TypedArtifactCorrection } from '@propr/core';
import type { Redis } from 'ioredis';

type SourceJob = CommentJobData | MergeConflictJobData;

/** Live publication fence, also usable after the single-use worker receipt has been consumed. */
export async function requireSourcePublication(data: SourceJob, redis: Redis, pushedHead?: string): Promise<void> {
    const receipt = data.executionAdmissionReceipt;
    if (!receipt) return;
    await core.requireAdmissionNotCancelled(redis, receipt.admissionId, pushedHead);
    if (receipt.maintenance) {
        if (!('headBranch' in data)) throw new Error('maintenance-requires-merge-worker');
        await core.requireMaintenanceJob(data, redis, pushedHead);
        return;
    }
    if (!data.executionAdmissionSource) return;
    core.requireExactSource(data.executionAdmissionSource, receipt.source);
    await core.readLiveAdmissionSource(`${data.repoOwner}/${data.repoName}`, data.pullRequestNumber,
        data.executionAdmissionSource, data.executionAdmissionTarget, pushedHead);
    await core.requireAdmissionNotCancelled(redis, receipt.admissionId, pushedHead);
}

export async function verifyAdmittedSourceJob(data: SourceJob, redis: Redis, onArtifactCorrection?: (binding: TypedArtifactCorrection) => void): Promise<void> {
    const source = data.executionAdmissionSource, receipt = data.executionAdmissionReceipt;
    if (receipt?.maintenance) {
        if (!('headBranch' in data)) throw new Error('maintenance-requires-merge-worker');
        await core.requireMaintenanceJob(data, redis);
        await core.verifyWorkerAdmissionReceipt({ receipt, store: core.createRedisAdmissionStore(redis),
            expected: { repository: `${data.repoOwner}/${data.repoName}`, issueNumber: data.pullRequestNumber,
                target: data.baseBranch, maintenance: receipt.maintenance } });
        return;
    }
    if (!source || !receipt || !data.executionAdmissionTarget) throw new Error('ezer-source-refused:missing-worker-binding');
    await core.requireAdmissionNotCancelled(redis, receipt.admissionId);
    const live = await core.readLiveAdmissionSource(`${data.repoOwner}/${data.repoName}`, data.pullRequestNumber, source, data.executionAdmissionTarget);
    if ('headBranch' in data) {
        if (source.mode !== 'merge' || receipt.step || data.headSha !== source.headSha || data.headBranch !== source.headBranch ||
            data.baseBranch !== data.executionAdmissionTarget || data.baseSha !== live.pr.base.sha || data.triggerSource !== 'comment') {
            throw new Error('ezer-source-refused:merge-binding-changed');
        }
    } else {
        if (!['fix', 'review'].includes(source.mode) || data.commandMode !== (source.mode === 'review' ? 'owner-review' : 'default') ||
            data.branchName !== source.headBranch || data.comments?.length !== 1 ||
            JSON.stringify(data.comments[0]) !== JSON.stringify(live.comment) || (!receipt.step && data.commandInstructions !== live.comment.body) ||
            JSON.stringify(data.requestedModels) !== JSON.stringify(source.model ? [source.model] : undefined) ||
            data.llm !== source.model || data.ultrafixMeta || data.commandMeta || data.systemAction || data.autoResolveContext) {
            throw new Error('ezer-source-refused:comment-binding-changed');
        }
    }
    // Step instructions are derived from trusted live inputs, never accepted as queue authority.
    const instructions = 'headBranch' in data ? undefined : !receipt.step ? live.comment.body : await core.buildAdmittedSourceInstructions(
        `${data.repoOwner}/${data.repoName}`, live.source, live.comment.body, receipt.step);
    await core.verifyWorkerAdmissionReceipt({ receipt, store: core.createRedisAdmissionStore(redis),
        expected: { repository: `${data.repoOwner}/${data.repoName}`, issueNumber: data.pullRequestNumber,
            target: data.executionAdmissionTarget, source: live.source,
            ...('headBranch' in data ? {} : { step: data.executionAdmissionStep }) }, onArtifactCorrection });
    if (!('headBranch' in data)) data.commandInstructions = instructions;
}

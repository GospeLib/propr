/**
 * The terminal evidence for a PR review run.
 *
 * The review workflow DOES run model executions — `runSingleReview` invokes `agent.analyze` (or
 * the routing session's `analyze`) once per assignment — so its completion is an executed
 * completion and goes through the durability barrier like every other. It was ledgered as
 * "non-executing" for as long as the sweep policing that invariant only recognised `.executeTask`
 * in the job's own file.
 *
 * The outcome recorded is the truthful aggregate: every analysis has to have succeeded for the
 * run to claim success, and a run that analysed nothing claims nothing.
 */
import { durableOperationIdentity, type WorkerStateManager } from '@propr/core';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { ReviewResult } from './prReviewRunner.js';
import { publishCompletedWithDurableExecutionEvidence } from './completedExecutionDurability.js';

export interface ReviewExecutionOutcome {
    success: boolean;
    executionTimeMs: number;
    reviewCount: number;
    error?: string;
}

export function reviewExecutionOutcome(reviewResults: ReviewResult[]): ReviewExecutionOutcome {
    const executionTimeMs = reviewResults.reduce((total, result) => total + (result.analysisResult.executionTimeMs ?? 0), 0);
    const firstError = reviewResults.find(result => !result.analysisResult.success)?.error;
    return {
        success: reviewResults.length > 0 && reviewResults.every(result => result.analysisResult.success),
        executionTimeMs,
        reviewCount: reviewResults.length,
        ...(firstError ? { error: firstError } : {}),
    };
}

/** Publishes the review run's completion through the durability barrier, with its evidence. */
export async function publishReviewCompletion(options: {
    stateManager: WorkerStateManager;
    taskId: string;
    job: Pick<Job, 'id'>;
    reviewResults: ReviewResult[];
    ultrafixHistoryMeta: Record<string, unknown> | undefined;
    correlatedLogger: Logger;
}): Promise<void> {
    const { stateManager, taskId, job, reviewResults, ultrafixHistoryMeta, correlatedLogger } = options;
    await publishCompletedWithDurableExecutionEvidence({
        stateManager, taskId, correlatedLogger,
        // The queue job owns this attempt and keeps its id across every redelivery.
        operationId: durableOperationIdentity('pr-comment-review-job', job.id ?? taskId),
        metadata: {
            reason: 'Review processing completed successfully',
            historyMetadata: {
                commandMode: 'review',
                reviewResults: reviewResults.map(result => ({
                    model: result.assignment.model, label: result.assignment.label, success: result.analysisResult.success,
                    commentId: result.commentId, commentUrl: result.commentUrl, error: result.error,
                })),
                ...(ultrafixHistoryMeta ?? {}),
                agentOutcome: reviewExecutionOutcome(reviewResults),
            },
        },
    });
}

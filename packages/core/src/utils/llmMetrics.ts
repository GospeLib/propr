import { Redis } from 'ioredis';
import logger from './logger.js';
import { db } from '../db/connection.js';
import { getAnalysisQueue } from '../queue/taskQueue.js';
import { extractMetricsFromClaudeResult, calculateTokens, calculateCost } from './llmMetricsTokens.js';
import { processConversationLog } from './llmMetricsConversation.js';
import type { RedisConnectionOptions, ClaudeResult, IssueRef, RecordMetricsOptions, AggregatedMetrics, CostCheckMetrics, PersistMetrics, HighCostAlert, LLMMetricsData, TokenUsage } from './llmMetrics.types.js';

export { getLLMMetricsSummary, getLLMMetricsByCorrelationId, getTotalMetrics, getModelMetrics } from './llmMetricsSummary.js';

const REDIS_HOST: string = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT: number = parseInt(process.env.REDIS_PORT ?? '6379', 10);

const connectionOptions: RedisConnectionOptions = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null, enableReadyCheck: false };

export async function updateAggregatedMetrics(metricsRedis: InstanceType<typeof Redis>, metrics: AggregatedMetrics): Promise<void> {
    const { model, success, costUsd, numTurns, executionTimeMs, dateKey } = metrics;
    const successKey = success ? 'successful' : 'failed';
    const incrAndAdd = async (key: string, val: number, isFloat = false) => {
        const cur = isFloat ? parseFloat(await metricsRedis.get(key) ?? '0') : parseInt(await metricsRedis.get(key) ?? '0');
        await metricsRedis.set(key, isFloat ? (cur + val).toFixed(4) : String(cur + val));
    };
    await Promise.all([
        metricsRedis.incr(`llm:metrics:total:${successKey}`), metricsRedis.incr(`llm:metrics:daily:${dateKey}:${successKey}`),
        metricsRedis.incr(`llm:metrics:model:${model}:${successKey}`), metricsRedis.sadd('llm:metrics:models:used', model)
    ]);
    const ops: Promise<unknown>[] = [
        incrAndAdd('llm:metrics:total:costUsd', costUsd, true), incrAndAdd(`llm:metrics:daily:${dateKey}:costUsd`, costUsd, true),
        incrAndAdd(`llm:metrics:model:${model}:costUsd`, costUsd, true), incrAndAdd('llm:metrics:total:executionTimeMs', executionTimeMs),
        incrAndAdd(`llm:metrics:model:${model}:executionTimeMs`, executionTimeMs)
    ];
    // Only a proven turn count is added to the sum, and only then does its divisor advance:
    // an unknown count must never silently pull the average down.
    if (typeof numTurns === 'number') {
        ops.push(
            incrAndAdd('llm:metrics:total:turns', numTurns), incrAndAdd(`llm:metrics:model:${model}:turns`, numTurns),
            metricsRedis.incr('llm:metrics:total:turnsKnownCount'), metricsRedis.incr(`llm:metrics:model:${model}:turnsKnownCount`)
        );
    }
    await Promise.all(ops);
}

export async function checkCostThreshold(metricsRedis: InstanceType<typeof Redis>, metrics: CostCheckMetrics, issueRef: IssueRef): Promise<void> {
    const { timestamp, correlationId, costUsd, model, numTurns } = metrics;
    const costThreshold = parseFloat(process.env.LLM_COST_THRESHOLD_USD ?? '10.00');
    if (costUsd > costThreshold) {
        const alertEntry: HighCostAlert = { timestamp, correlationId, issueNumber: issueRef.number,
            repository: `${issueRef.repoOwner}/${issueRef.repoName}`, costUsd, threshold: costThreshold, model,
            ...(typeof numTurns === 'number' ? { numTurns } : {}) };
        await metricsRedis.lpush('llm:metrics:alerts:highcost', JSON.stringify(alertEntry));
        await metricsRedis.ltrim('llm:metrics:alerts:highcost', 0, 99);
        logger.warn({ ...alertEntry, message: 'LLM cost exceeded threshold' });
    }
}

/**
 * Whether a recorded execution should trigger a post-execution "task analysis".
 *
 * Only real implementation runs (issue / pr-comments-batch / merge-conflict)
 * produce a commit/diff worth analyzing, and they are recorded with no explicit
 * executionType — so allow undefined/null or 'implementation'. Every other type
 * is excluded by default.
 *
 * This is the anti-recursion guard: the analysis itself runs claude and records
 * its own execution with executionType 'task-analysis'. If that re-enqueued an
 * analysis, it would analyze-the-analysis forever (the analysis-processor loop
 * that wedged production). An allowlist means any future executionType is
 * excluded by default and cannot re-introduce the recursion.
 */
export function shouldEnqueueExecutionAnalysis(executionType?: string | null): boolean {
    return executionType == null || executionType === 'implementation';
}

async function enqueueAnalysisTask(taskId: string, executionId: string, sessionId: string, correlationId?: string): Promise<void> {
    try {
        const queue = await getAnalysisQueue();
        await queue.add('analyzeExecution', {
            taskId,
            executionId,
            sessionId: sessionId || 'unknown',
            correlationId: correlationId || 'unknown'
        }, {
            jobId: `analysis-${executionId}`,
            removeOnComplete: true,
            removeOnFail: true,
            delay: 10000
        });
        logger.debug({ correlationId, taskId, executionId }, 'Enqueued task for execution analysis (with 10s delay)');
    } catch (queueError) {
        logger.error({ error: (queueError as Error).message, correlationId, taskId }, 'Failed to enqueue task for analysis');
    }
}
async function persistToDatabase(claudeResult: ClaudeResult, taskId: string | null, metrics: PersistMetrics): Promise<void> {
    const { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd, tokenUsage, correlationId, executionType } = metrics;

    // Check if taskId exists in tasks table (drafts won't exist)
    // Use null for task_id if it doesn't exist (FK allows null now)
    let effectiveTaskId: string | null = null;
    if (taskId) {
        const taskExists = await db('tasks').where({ task_id: taskId }).first();
        effectiveTaskId = taskExists ? taskId : null;
    }

    try {
        const executionData = {
            task_id: effectiveTaskId, session_id: sessionId, conversation_id: conversationId,
            start_time: new Date(Date.now() - executionTimeMs).toISOString(),
            end_time: new Date().toISOString(), duration_ms: executionTimeMs,
            model_name: model, success: success, num_turns: numTurns ?? null, cost_usd: costUsd,
            error_message: !success ? (claudeResult?.error ?? 'Unknown error') : null,
            prompt_length: null, output_length: null,
            input_tokens: tokenUsage?.input_tokens ?? null,
            output_tokens: tokenUsage?.output_tokens ?? null,
            cache_creation_input_tokens: tokenUsage?.cache_creation_input_tokens ?? null,
            cache_read_input_tokens: tokenUsage?.cache_read_input_tokens ?? null
        };
        const [insertedExecution] = await db('llm_executions').insert(executionData).returning('execution_id');
        const executionId = (insertedExecution as { execution_id: string }).execution_id;

        await processConversationLog({ claudeResult, executionId, costUsd, correlationId, taskId: effectiveTaskId });
        logger.debug({ correlationId, taskId: effectiveTaskId, executionId }, 'LLM metrics persisted to database');

        // Only enqueue post-execution analysis for real implementation runs — the
        // only ones that produce a commit/diff worth analyzing. Implementation
        // executions (issue / pr-comments-batch / merge-conflict) are recorded with
        // no explicit executionType, so allow undefined or 'implementation'.
        //
        // Excluding everything else is CRITICAL, not just cosmetic: the analysis
        // itself runs claude (executeClaudeAnalysis) which records its own execution
        // with executionType 'task-analysis'. Under the old `!== 'pr-review'` gate
        // that re-enqueued another analysis → analyze-the-analysis forever, an
        // infinite recursion in the analysis-processor queue (execution IDs climbing
        // every ~80s) that wedged production. Reviews/chat/planning/summaries/titles
        // produce no commit and shouldn't be analyzed either.
        if (effectiveTaskId && shouldEnqueueExecutionAnalysis(executionType)) {
            await enqueueAnalysisTask(effectiveTaskId, executionId, sessionId, correlationId);
        } else {
            logger.debug({ correlationId, taskId: effectiveTaskId, executionId, executionType }, 'Skipping analysis queue (non-implementation execution)');
        }
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack, correlationId, taskId }, 'Failed to persist LLM metrics to database');
    }
}
async function storeMetricsToRedis(metricsRedis: InstanceType<typeof Redis>, llmMetrics: LLMMetricsData, correlationId?: string): Promise<void> { await metricsRedis.setex(`llm:metrics:${correlationId}`, 30 * 24 * 3600, JSON.stringify(llmMetrics)); }
async function storeTimeSeriesEntry(metricsRedis: InstanceType<typeof Redis>, entry: Record<string, unknown>): Promise<void> { await metricsRedis.lpush('llm:metrics:timeseries', JSON.stringify(entry)); await metricsRedis.ltrim('llm:metrics:timeseries', 0, 999); }
function logConversationDebug(claudeResult: ClaudeResult | null, correlationId?: string, taskId?: string | null): void {
    if (claudeResult?.conversationLog && claudeResult.conversationLog.length > 0) {
        logger.info({
            correlationId, taskId, conversationLogLength: claudeResult.conversationLog.length,
            firstItemKeys: Object.keys(claudeResult.conversationLog[0]),
            firstItemSample: JSON.stringify(claudeResult.conversationLog[0]).substring(0, 300)
        }, 'DEBUG: ConversationLog structure');
    }
}
export async function recordLLMMetrics(claudeResult: ClaudeResult | null, issueRef: IssueRef, options: RecordMetricsOptions = {}): Promise<void> {
    const { jobType = 'issue', correlationId, taskId = null, executionType } = options;
    const metricsRedis = new Redis(connectionOptions);
    logger.info({
        correlationId, taskId, hasClaudeResult: !!claudeResult,
        hasConversationLog: !!claudeResult?.conversationLog,
        conversationLogType: Array.isArray(claudeResult?.conversationLog) ? 'array' : typeof claudeResult?.conversationLog,
        conversationLogLength: claudeResult?.conversationLog?.length ?? 0
    }, 'DEBUG: recordLLMMetrics called');

    try {
        const timestamp = new Date().toISOString();
        const dateKey = timestamp.split('T')[0];
        const extracted = extractMetricsFromClaudeResult(claudeResult);
        const { model, success, executionTimeMs, executionTimeSec, numTurns, sessionId, conversationId } = extracted;
        const cumulativeTokens = calculateTokens(claudeResult?.conversationLog, claudeResult?.tokenUsage);
        const costUsd = await calculateCost(model, cumulativeTokens, claudeResult);
        const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;

        const llmMetrics: LLMMetricsData = {
            correlationId, timestamp, issueNumber: issueRef.number, repository, jobType,
            model, success, executionTimeMs, executionTimeSec, numTurns, costUsd,
            sessionId, conversationId, error: claudeResult?.error ?? null,
            failureReason: !success ? (claudeResult?.error ?? 'unknown') : null
        };
        await storeMetricsToRedis(metricsRedis, llmMetrics, correlationId);
        // These are running sums/alerts, not the persisted per-execution record: an unknown
        // turn count is excluded from the sum AND its divisor, never fabricated as 0.
        await updateAggregatedMetrics(metricsRedis, { model, success, costUsd, numTurns, executionTimeMs, dateKey });
        await storeTimeSeriesEntry(metricsRedis, { timestamp, correlationId, model, success, costUsd, executionTimeSec, numTurns, repository });
        await checkCostThreshold(metricsRedis, { timestamp, correlationId, costUsd, model, numTurns }, issueRef);

        logger.info({ correlationId, issueNumber: issueRef.number, model, success, costUsd, executionTimeSec, numTurns }, 'LLM metrics recorded');
        logConversationDebug(claudeResult, correlationId, taskId);
        if (claudeResult) {
            // Build cumulative token usage from conversation log (same as PR comment)
            const cumulativeTokenUsage: TokenUsage = {
                input_tokens: cumulativeTokens.totalInputWithCache,
                output_tokens: cumulativeTokens.outputTokens,
                cache_creation_input_tokens: cumulativeTokens.cacheCreationTokens,
                cache_read_input_tokens: cumulativeTokens.cacheReadTokens
            };
            await persistToDatabase(claudeResult, taskId, { sessionId, conversationId, executionTimeMs, model, success, numTurns, costUsd, tokenUsage: cumulativeTokenUsage, correlationId, executionType });
        }
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack, correlationId }, 'Failed to record LLM metrics');
    } finally {
        await metricsRedis.quit();
    }
}

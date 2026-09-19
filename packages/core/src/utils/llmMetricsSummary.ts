import { Redis } from 'ioredis';
import logger from './logger.js';
import type { LLMMetricsSummary, ModelMetrics, DailyMetric, HighCostAlert, LLMMetricsSummaryResult, LLMMetricsData } from './llmMetrics.types.js';

const REDIS_HOST: string = process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT: number = parseInt(process.env.REDIS_PORT ?? '6379', 10);

const connectionOptions = { host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: null, enableReadyCheck: false };

export async function getTotalMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<LLMMetricsSummary> {
    const [totalSuccessful, totalFailed, totalCostUsd, totalTurns, turnsKnownCount, totalExecutionTimeMs] = await Promise.all([
        metricsRedis.get('llm:metrics:total:successful').then(v => parseInt(v ?? '0')),
        metricsRedis.get('llm:metrics:total:failed').then(v => parseInt(v ?? '0')),
        metricsRedis.get('llm:metrics:total:costUsd').then(v => parseFloat(v ?? '0')),
        metricsRedis.get('llm:metrics:total:turns').then(v => parseInt(v ?? '0')),
        metricsRedis.get('llm:metrics:total:turnsKnownCount').then(v => parseInt(v ?? '0')),
        metricsRedis.get('llm:metrics:total:executionTimeMs').then(v => parseInt(v ?? '0'))
    ]);
    const totalRequests = totalSuccessful + totalFailed;
    const avg = (val: number) => totalRequests > 0 ? val / totalRequests : 0;
    // Divide only by executions with proven turn evidence, never by every request: an
    // unknown-turn run must not silently pull the average down.
    const avgTurns = turnsKnownCount > 0 ? totalTurns / turnsKnownCount : 0;
    return { totalRequests, totalSuccessful, totalFailed, successRate: avg(totalSuccessful), totalCostUsd,
        avgCostPerRequest: avg(totalCostUsd), totalTurns, avgTurnsPerRequest: avgTurns,
        avgExecutionTimeSec: avg(totalExecutionTimeMs) / 1000 };
}

export async function getModelMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<Record<string, ModelMetrics>> {
    const modelsUsed = await metricsRedis.smembers('llm:metrics:models:used');
    const entries = await Promise.all(modelsUsed.map(async (model) => {
        const [successful, failed, costUsd, turns, turnsKnownCount, execTimeMs] = await Promise.all([
            metricsRedis.get(`llm:metrics:model:${model}:successful`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:failed`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:costUsd`).then(v => parseFloat(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:turns`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:turnsKnownCount`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:model:${model}:executionTimeMs`).then(v => parseInt(v ?? '0'))
        ]);
        const total = successful + failed;
        const avg = (val: number) => total > 0 ? val / total : 0;
        const avgTurns = turnsKnownCount > 0 ? turns / turnsKnownCount : 0;
        return [model, { totalRequests: total, successful, failed, successRate: avg(successful), totalCostUsd: costUsd,
            avgCostPerRequest: avg(costUsd), totalTurns: turns, avgTurnsPerRequest: avgTurns,
            avgExecutionTimeSec: avg(execTimeMs) / 1000 }] as const;
    }));
    return Object.fromEntries(entries);
}

async function getDailyMetrics(metricsRedis: InstanceType<typeof Redis>): Promise<DailyMetric[]> {
    const today = new Date();
    const dateKeys = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today); d.setDate(d.getDate() - i); return d.toISOString().split('T')[0];
    });
    return Promise.all(dateKeys.map(async (dateKey) => {
        const [successful, failed, costUsd] = await Promise.all([
            metricsRedis.get(`llm:metrics:daily:${dateKey}:successful`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:daily:${dateKey}:failed`).then(v => parseInt(v ?? '0')),
            metricsRedis.get(`llm:metrics:daily:${dateKey}:costUsd`).then(v => parseFloat(v ?? '0'))
        ]);
        return { date: dateKey, successful, failed, total: successful + failed, costUsd };
    }));
}

async function getHighCostAlerts(metricsRedis: InstanceType<typeof Redis>): Promise<HighCostAlert[]> {
    return (await metricsRedis.lrange('llm:metrics:alerts:highcost', 0, 9))
        .map((a: string) => { try { return JSON.parse(a) as HighCostAlert; } catch { return null; } })
        .filter((a): a is HighCostAlert => a !== null);
}

export async function getLLMMetricsSummary(): Promise<LLMMetricsSummaryResult> {
    const metricsRedis = new Redis(connectionOptions);
    try {
        const summary = await getTotalMetrics(metricsRedis);
        const modelBreakdown = await getModelMetrics(metricsRedis);
        const dailyMetrics = await getDailyMetrics(metricsRedis);
        const recentHighCostAlerts = await getHighCostAlerts(metricsRedis);
        return { summary, modelBreakdown, dailyMetrics, recentHighCostAlerts, lastUpdated: new Date().toISOString() };
    } catch (error) {
        logger.error({ error: (error as Error).message, stack: (error as Error).stack }, 'Failed to retrieve LLM metrics summary');
        throw error;
    } finally {
        await metricsRedis.quit();
    }
}

export async function getLLMMetricsByCorrelationId(correlationId: string): Promise<LLMMetricsData | null> {
    const metricsRedis = new Redis(connectionOptions);
    try {
        const data = await metricsRedis.get(`llm:metrics:${correlationId}`);
        return data ? JSON.parse(data) as LLMMetricsData : null;
    } catch (error) {
        logger.error({ error: (error as Error).message, correlationId }, 'Failed to retrieve LLM metrics by correlation ID');
        return null;
    } finally { await metricsRedis.quit(); }
}

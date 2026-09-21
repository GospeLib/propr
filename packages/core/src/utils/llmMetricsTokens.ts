import logger from './logger.js';
import { getOpenRouterId } from '../config/modelAliases.js';
import { getModelPricing } from '../services/pricingService.js';
import { calculateCostWithCachePricing } from './tokenCalculation.js';
import type { ClaudeResult, ModelPricing, ExtractedMetrics, ConversationStep, TokenUsage } from './llmMetrics.types.js';

export function extractMetricsFromClaudeResult(claudeResult: ClaudeResult | null): ExtractedMetrics {
    const model = claudeResult?.model ?? process.env.CLAUDE_MODEL ?? 'unknown';
    const executionTimeMs = claudeResult?.executionTime ?? 0;
    return { model, success: claudeResult?.success ?? false, executionTimeMs, executionTimeSec: Math.round(executionTimeMs / 1000),
        ...(typeof claudeResult?.finalResult?.num_turns === 'number' ? { numTurns: claudeResult.finalResult.num_turns } : {}),
        sessionId: claudeResult?.sessionId ?? 'unknown',
        conversationId: claudeResult?.conversationId ?? null };
}

export interface CumulativeTokenUsage {
    inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number;
    totalInputWithCache: number;  // input + cache_creation + cache_read (for cost calc and display)
}

export function calculateTokens(conversationLog: ConversationStep[] | undefined, reportedTokenUsage?: TokenUsage): CumulativeTokenUsage {
    let aggrInput = 0, aggrOutput = 0, aggrCacheCreate = 0, aggrCacheRead = 0;
    if (conversationLog && Array.isArray(conversationLog)) {
        const seenIds = new Set<string>(); // Deduplicate by message ID (per Claude docs, same ID = same usage)
        conversationLog.forEach(step => {
            const message = step.message as { id?: string; usage?: TokenUsage } | undefined;
            // Check both message?.usage and root-level step.usage (Claude CLI stores usage in either location)
            const usage = message?.usage || (step as { usage?: TokenUsage }).usage;
            if (usage) {
                const msgId = message?.id;
                if (msgId && seenIds.has(msgId)) return;
                if (msgId) seenIds.add(msgId);
                aggrInput += usage.input_tokens ?? 0; aggrOutput += usage.output_tokens ?? 0;
                aggrCacheCreate += usage.cache_creation_input_tokens ?? 0; aggrCacheRead += usage.cache_read_input_tokens ?? 0;
            }
        });
    }
    const rptInput = reportedTokenUsage?.input_tokens ?? 0, rptOutput = reportedTokenUsage?.output_tokens ?? 0;
    const rptCacheCreate = reportedTokenUsage?.cache_creation_input_tokens ?? 0, rptCacheRead = reportedTokenUsage?.cache_read_input_tokens ?? 0;
    const aggrTotal = aggrInput + aggrOutput + aggrCacheCreate + aggrCacheRead;
    const rptTotal = rptInput + rptOutput + rptCacheCreate + rptCacheRead;
    const useAggr = aggrTotal > rptTotal; // Use whichever is higher to avoid undercounting
    const [inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens] = useAggr
        ? [aggrInput, aggrOutput, aggrCacheCreate, aggrCacheRead] : [rptInput, rptOutput, rptCacheCreate, rptCacheRead];
    return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalInputWithCache: inputTokens + cacheCreationTokens + cacheReadTokens };
}

export async function calculateCost(model: string, tokens: CumulativeTokenUsage, claudeResult: ClaudeResult | null): Promise<number> {
    const openRouterId = getOpenRouterId(model);
    const pricing = await getModelPricing(openRouterId) as ModelPricing | null;
    const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = tokens;
    logger.info({ model, openRouterId, pricingFound: !!pricing, pricing, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens },
        'Cost calculation: looking up pricing');
    const hasTokens = inputTokens > 0 || outputTokens > 0 || cacheCreationTokens > 0 || cacheReadTokens > 0;
    let calculatedCostUsd = 0;
    if (pricing && hasTokens) {
        calculatedCostUsd = calculateCostWithCachePricing(model, {
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
            totalInputWithCache: tokens.totalInputWithCache,
            totalTokens: tokens.totalInputWithCache + outputTokens
        }, pricing);
        logger.info({ model, openRouterId, calculatedCostUsd }, 'Calculated dynamic cost with cache pricing');
    } else if (!pricing) { logger.warn({ model, openRouterId }, 'No pricing found for model - cost will be 0 or fallback'); }
    else { logger.warn({ model, inputTokens, outputTokens }, 'No token data available - cost will be 0 or fallback'); }
    return calculatedCostUsd > 0 ? calculatedCostUsd : (claudeResult?.finalResult?.cost_usd ?? claudeResult?.finalResult?.total_cost_usd ?? 0);
}

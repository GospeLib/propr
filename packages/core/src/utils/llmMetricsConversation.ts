import logger from './logger.js';
import { db } from '../db/connection.js';
import type { ClaudeResult, ConversationDetailParams, ConversationDetail, ConversationStep, MessageContent, TokenUsage } from './llmMetrics.types.js';

interface GenericConversationStep {
    message?: ConversationStep['message'] | string; timestamp?: string; type?: string; isError?: boolean; metadata?: Record<string, unknown>;
    role?: string; content?: string; tool?: string; params?: unknown; result?: string; usage?: TokenUsage;
    item?: { type?: string; text?: string; command?: string; aggregated_output?: string; exit_code?: number | null; items?: Array<{ text?: string; completed?: boolean }> };
}

function extractToolUsage(content: MessageContent[] | undefined): { toolName: string | null; toolInput: unknown | null; toolUseId: string | null } {
    const toolUse = content?.find(b => b.type === 'tool_use');
    return toolUse ? { toolName: toolUse.name ?? null, toolInput: toolUse.input ?? null, toolUseId: toolUse.id ?? null }
        : { toolName: null, toolInput: null, toolUseId: null };
}

function buildPayload(content: string | null, isError = false, toolName: string | null = null, toolInput: unknown | null = null): { content: string | null; toolName: string | null; toolInput: unknown | null; toolUseId: string | null; isError: boolean } { return { content, toolName, toolInput, toolUseId: null, isError }; }
function getCommandExecutionPayload(step: GenericConversationStep) { return buildPayload(step.item?.aggregated_output ?? JSON.stringify(step), step.item?.exit_code != null && step.item.exit_code !== 0, 'command_execution', step.item?.command ? { command: step.item.command } : null); }
function getReasoningPayload(step: GenericConversationStep) { return buildPayload(step.item?.text ?? null); }
function getFallbackPayload(step: GenericConversationStep) { return buildPayload(JSON.stringify(step), step.isError ?? false); }

function getGenericStepPayload(step: GenericConversationStep): {
    content: string | null;
    toolName: string | null;
    toolInput: unknown | null;
    toolUseId: string | null;
    isError: boolean;
} {
    if (step.message) return buildPayload(JSON.stringify(step.message), step.isError ?? false);
    if (step.type === 'message' && step.role === 'assistant') return buildPayload(step.content ?? JSON.stringify(step));
    if (step.type === 'tool_use') return buildPayload(JSON.stringify(step), false, step.tool ?? null, step.params ?? null);
    if (step.type === 'error') return buildPayload(step.message ?? step.result ?? JSON.stringify(step), true);
    if (step.item?.type === 'command_execution') return getCommandExecutionPayload(step);
    if ((step.item?.type === 'reasoning' || step.item?.type === 'agent_message') && step.item.text) return getReasoningPayload(step);
    return getFallbackPayload(step);
}
function calculateMessageCost(messageTokens: number, totalTokens: number, costUsd: number): number | null { return totalTokens > 0 && costUsd > 0 ? (messageTokens / totalTokens) * costUsd : null; }
function calculateDurationMs(step: ConversationStep, index: number, conversationLog: ConversationStep[]): number | null { return index <= 0 || !step.timestamp || !conversationLog[index - 1].timestamp ? null : new Date(step.timestamp).getTime() - new Date(conversationLog[index - 1].timestamp!).getTime(); }
function getStepTokenUsage(step: ConversationStep, genericStep: GenericConversationStep) { return { inputTokens: step.message?.usage?.input_tokens ?? genericStep.usage?.input_tokens ?? null, outputTokens: step.message?.usage?.output_tokens ?? genericStep.usage?.output_tokens ?? null }; }
function getStepContent(step: ConversationStep, hasClaudeMessage: boolean, genericPayload: ReturnType<typeof getGenericStepPayload> | null): string | null { return hasClaudeMessage ? JSON.stringify(step.message) : genericPayload?.content ?? null; }
function getStepMetadata(step: ConversationStep, hasClaudeMessage: boolean): string | null { return hasClaudeMessage ? (step.metadata ? JSON.stringify(step.metadata) : null) : JSON.stringify(step); }

function buildConversationDetail(params: ConversationDetailParams): ConversationDetail {
    const { step, index, executionId, conversationLog, totalTokens, costUsd } = params;
    const genericStep = step as GenericConversationStep;
    const hasClaudeMessage = !!step.message;
    const { toolName, toolInput, toolUseId } = hasClaudeMessage
        ? extractToolUsage(step.message?.content)
        : getGenericStepPayload(genericStep);
    const { inputTokens, outputTokens } = getStepTokenUsage(step, genericStep);
    const messageTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
    const genericPayload = hasClaudeMessage ? null : getGenericStepPayload(genericStep);
    return {
        execution_id: executionId, sequence_number: index,
        event_timestamp: step.timestamp ?? new Date().toISOString(),
        event_type: step.type ?? 'unknown',
        content: getStepContent(step, hasClaudeMessage, genericPayload),
        duration_ms: calculateDurationMs(step, index, conversationLog),
        token_count_input: inputTokens,
        token_count_output: outputTokens,
        cost_usd: calculateMessageCost(messageTokens, totalTokens, costUsd),
        is_error: hasClaudeMessage ? (step.isError ?? false) : (genericPayload?.isError ?? false), tool_name: toolName,
        tool_input: toolInput ? JSON.stringify(toolInput) : null,
        tool_use_id: toolUseId,
        metadata: getStepMetadata(step, hasClaudeMessage)
    };
}

export interface ProcessConversationLogParams { claudeResult: ClaudeResult; executionId: string; costUsd: number; correlationId?: string; taskId?: string | null; }

export async function processConversationLog(params: ProcessConversationLogParams): Promise<void> {
    const { claudeResult, executionId, costUsd, correlationId, taskId } = params;
    if (!claudeResult.conversationLog || !Array.isArray(claudeResult.conversationLog)) return;

    if (claudeResult.conversationLog.length > 0) {
        logger.debug({
            correlationId, taskId,
            sampleKeys: Object.keys(claudeResult.conversationLog[0]),
            sampleItem: JSON.stringify(claudeResult.conversationLog[0]).substring(0, 200)
        }, 'ConversationLog sample structure');
    }

    let totalTokens = 0;
    claudeResult.conversationLog.forEach((step) => {
        totalTokens += (step.message?.usage?.input_tokens ?? 0) + (step.message?.usage?.output_tokens ?? 0);
    });

    const detailsArray = claudeResult.conversationLog.map((step, index) =>
        buildConversationDetail({ step, index, executionId, conversationLog: claudeResult.conversationLog!, totalTokens, costUsd })
    );

    if (detailsArray.length > 0) {
        logger.info({
            correlationId, taskId,
            sampleDetail: {
                sequence: detailsArray[0].sequence_number, type: detailsArray[0].event_type,
                hasContent: !!detailsArray[0].content, contentPreview: detailsArray[0].content?.substring(0, 100),
                inputTokens: detailsArray[0].token_count_input, outputTokens: detailsArray[0].token_count_output,
                toolName: detailsArray[0].tool_name
            }
        }, 'DEBUG: Sample detail before insert');
        await db('llm_execution_details').insert(detailsArray);
    }
}

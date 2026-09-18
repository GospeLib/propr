import type { TokenUsage } from '../../types.js';
import type { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import type { UsageTrackingMetrics } from './usageTrackingWrapper.js';
import type { ClaudeOutput } from '../../../claude/claudeHelpers.js';

const GENERIC_CLAUDE_RESULT_TEXTS = new Set(['task completed.', 'task completed']);
const SINGLE_ANALYSIS_TURN = 1;
const MIN_CONTINUATION_SEGMENTS = 2;
const COMPLETED_RESULT_SUBTYPE = 'success';
const COMPLETED_TERMINAL_REASON = 'completed';
const COMPLETED_STOP_REASON = 'end_turn';
const COMPLETED_STRUCTURED_STOP_REASONS = new Set([COMPLETED_STOP_REASON, 'tool_use']);

function isJsonDocument(text: string): boolean {
    try { const value: unknown = JSON.parse(text); return value !== null && typeof value === 'object'; }
    catch { return false; }
}

function continuationPart(entry: ClaudeOutput['conversationLog'][number], sessionId: string) {
    if (entry.type !== 'assistant' || entry.session_id !== sessionId || entry.parent_tool_use_id !== null)
        return undefined;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content) || content.some(block => !block || typeof block !== 'object' ||
        !(block.type === 'thinking' || block.type === 'text' && typeof block.text === 'string'))) return undefined;
    const texts = content.filter(block => block.type === 'text').map(block => block.text as string);
    if (!texts.length) return null;
    const id = entry.message?.id;
    return id ? { id, text: texts.join('') } : undefined;
}

/** CLI auto-continuation can return only its last fragment in result.result.
 * Recover a document only from one completed, tool-free, session-bound turn.
 * Never concatenate arbitrary conversational turns or accept partial JSON.
 */
function structuredContinuation(output: Pick<ClaudeOutput, 'finalResult' | 'conversationLog' | 'streamParseComplete'>): string | undefined {
    if (output.streamParseComplete !== true) return undefined;
    const result = output.finalResult;
    if (!result || result.is_error !== false || result.subtype !== COMPLETED_RESULT_SUBTYPE ||
        result.num_turns !== SINGLE_ANALYSIS_TURN || result.terminal_reason !== COMPLETED_TERMINAL_REASON ||
        result.stop_reason !== COMPLETED_STOP_REASON || !result.session_id) return undefined;
    const parts: string[] = [], messageIds = new Set<string>();
    for (const entry of output.conversationLog) {
        const part = continuationPart(entry, result.session_id);
        if (part === undefined) return undefined;
        if (part === null) continue;
        if (messageIds.has(part.id)) return undefined;
        messageIds.add(part.id);
        parts.push(part.text);
    }
    if (parts.length < MIN_CONTINUATION_SEGMENTS || parts.at(-1) !== result.result) return undefined;
    const joined = parts.join('');
    return isJsonDocument(joined) ? joined.trim() : undefined;
}

export function getTextFromClaudeContent(content: unknown): string {
    if (!Array.isArray(content)) return '';
    return content
        .map(block => {
            if (block && typeof block === 'object' && 'type' in block && (block as { type?: unknown }).type === 'text') {
                const text = (block as { text?: unknown }).text;
                return typeof text === 'string' ? text : '';
            }
            return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

export function getLastAssistantText(conversationLog: Array<{ type?: string; message?: Record<string, unknown> }>): string {
    for (let index = conversationLog.length - 1; index >= 0; index--) {
        const entry = conversationLog[index];
        if (entry?.type !== 'assistant') continue;
        const text = getTextFromClaudeContent(entry.message?.content);
        if (text) return text;
    }
    return '';
}

function nativeStructuredOutput(claudeOutput: Pick<ClaudeOutput, 'finalResult' | 'streamParseComplete'>): string {
        const result = claudeOutput.finalResult;
        if (claudeOutput.streamParseComplete !== true || !result || result.is_error !== false ||
            result.subtype !== COMPLETED_RESULT_SUBTYPE || result.terminal_reason !== COMPLETED_TERMINAL_REASON ||
            !COMPLETED_STRUCTURED_STOP_REASONS.has(result.stop_reason ?? '') ||
            !result.session_id || result.structured_output === null || typeof result.structured_output !== 'object' ||
            Array.isArray(result.structured_output)) throw new Error('Native structured output unavailable or incomplete');
        // The CLI schema-delivery tool legitimately finishes with stop_reason=tool_use.
        // Only its explicit result field is authoritative; never reconstruct tool conversations.
        return JSON.stringify(result.structured_output);
}

export function getClaudeAnalysisText(claudeOutput: Pick<ClaudeOutput, 'finalResult' | 'conversationLog' | 'streamParseComplete'>,
    responseFormat: 'text' | 'json' = 'text', responseSchema?: Readonly<Record<string, unknown>>): string {
    if (responseSchema !== undefined) return nativeStructuredOutput(claudeOutput);
    const resultText = (claudeOutput.finalResult?.result || '').trim();
    if (responseFormat === 'json' && !isJsonDocument(resultText)) {
        const complete = structuredContinuation(claudeOutput);
        if (complete !== undefined) return complete;
    }
    const assistantText = getLastAssistantText(claudeOutput.conversationLog);
    if (resultText && !GENERIC_CLAUDE_RESULT_TEXTS.has(resultText.toLowerCase())) {
        return resultText;
    }
    return assistantText || resultText;
}

export interface PersistLogsParams {
    result: ExecutionResult;
    prompt: string;
    issueRef: { number: number; repoOwner: string; repoName: string };
    modelUsed: string;
    isRetry: boolean;
    retryReason?: string;
    executionTime: number;
    correctedTokenUsage: TokenUsage | undefined;
    taskId?: string;
    prNumber?: number;
    reasoningLevel?: string;
    usageMetrics?: UsageTrackingMetrics | null;
}

/** Claude CLI stream framing, results, and loss provenance. Public compatibility exports remain in claudeHelpers. */
import { classifyExecutionFailure, type ExecutionFailure } from '../agents/executionFailure.js';
import logger from '../utils/logger.js';
import type { ExecutionResult } from './docker/dockerExecutor.js';
import { parseResetTimeFromMessage, calculateNextRoundHourPlus2Minutes } from '../utils/scheduling.js';

export class UsageLimitError extends Error {
    readonly failureKind = 'usage_limit' as const;
    usageResetAt?: string;
    resetTimestamp: number;
    retryable: boolean;
    rawErrorMessage?: string;

    constructor(message: string, resetTimestamp: number, rawErrorMessage?: string, usageResetAt?: string) {
        super(message);
        this.usageResetAt = usageResetAt;
        this.name = 'UsageLimitError';
        this.resetTimestamp = resetTimestamp;
        this.retryable = true;
        this.rawErrorMessage = rawErrorMessage;
    }
}

export interface ConversationLogEntry {
    type?: string;
    message?: {
        id?: string;
        model?: string;
    };
    timestamp?: string;
    [key: string]: unknown;
}

export interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

export interface ClaudeOutputResult {
    structured_output?: unknown;
    type: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    num_turns?: number;
    session_id?: string;
    terminal_reason?: string;
    stop_reason?: string;
    total_cost_usd?: number;
    cost_usd?: number;
    model?: string;
    conversation_id?: string;
    usage?: TokenUsage;
}

export interface ClaudeOutput {
    failure?: ExecutionFailure;
    success: boolean;
    rawOutput: string;
    /** Explicit false means a stream record was dropped; absence is not proof of completeness. */
    streamParseComplete?: boolean;
    error: string;
    conversationLog: ConversationLogEntry[];
    sessionId: string | null;
    conversationId?: string;
    finalResult: ClaudeOutputResult | null;
    model?: string;
    tokenUsage?: TokenUsage;
}

interface JsonLineMessage {
    structured_output?: unknown;
    type?: string;
    subtype?: string;
    message?: {
        id?: string;
        model?: string;
        content?: Array<{ type: string; text?: string }>;
    };
    session_id?: string;
    conversation_id?: string;
    model?: string;
    result?: string;
    num_turns?: number;
    terminal_reason?: string;
    stop_reason?: string;
    is_error?: boolean;
    total_cost_usd?: number;
    cost_usd?: number;
    usage?: TokenUsage;
    error?: unknown;
    status?: number;
    headers?: Record<string, string>;
}

export function parseStreamJsonOutput(result: ExecutionResult): ClaudeOutput {
    const claudeOutput: ClaudeOutput = {
        success: result.exitCode === 0,
        rawOutput: result.stdout,
        streamParseComplete: true,
        error: result.stderr,
        conversationLog: [],
        sessionId: null,
        finalResult: null
    };

    const limitMatch = result.stderr.match(/^Claude AI usage limit reached\|(\d+)$/m);
    if (limitMatch?.[1]) {
        const resetTimestamp = Number(limitMatch[1]);
        throw new UsageLimitError(`Claude usage limit reached. Limit resets at timestamp ${resetTimestamp}.`,
            resetTimestamp, result.stderr, new Date(resetTimestamp * 1000).toISOString());
    }

    if (!result.stdout) return claudeOutput;

    let streamStarted = false;
    const lines = result.stdout.split('\n').filter(line => line.trim());
    for (const line of lines) {
        let jsonLine: JsonLineMessage;
        try {
            jsonLine = JSON.parse(line);
        } catch {
            // Setup-wrapper prose precedes the CLI stream. Once framed events begin,
            // an unparsed line can be a lost continuation even without an opening brace.
            if (streamStarted || line.trimStart().startsWith('{')) claudeOutput.streamParseComplete = false;
            continue;
        }
        if (!jsonLine || typeof jsonLine !== 'object' || Array.isArray(jsonLine) || typeof jsonLine.type !== 'string') {
            claudeOutput.streamParseComplete = false;
            continue;
        }
        streamStarted = true;

        try {
            processJsonLine(jsonLine, claudeOutput, result.messageTimestamps);
        } catch (error) {
            // Propagate usage limit detection to trigger upstream requeue logic.
            if (error instanceof UsageLimitError) {
                throw error;
            }
            claudeOutput.streamParseComplete = false;
        }
    }

    return claudeOutput;
}

function handleRateLimitError(jsonLine: JsonLineMessage): void {
    let messageText = '';
    if (jsonLine.message?.content && Array.isArray(jsonLine.message.content)) {
        const textItem = jsonLine.message.content.find(item => item.type === 'text' && item.text);
        if (textItem) messageText = textItem.text || '';
    }
    const reportedTimestamp = parseResetTimeFromMessage(messageText);
    const resetTimestamp = reportedTimestamp || calculateNextRoundHourPlus2Minutes();
    const usageResetAt = classifyExecutionFailure({ error: jsonLine }).usageResetAt
        ?? (reportedTimestamp ? new Date(reportedTimestamp * 1000).toISOString() : undefined);
    logger.warn({ messageText, resetTimestamp }, 'Claude rate limit reached (new format). Throwing specific error for requeue.');
    throw new UsageLimitError(`Claude usage limit reached. Limit resets at timestamp ${resetTimestamp}.`, resetTimestamp, messageText || 'Rate limit reached', usageResetAt);
}

function processConversationMessage(jsonLine: JsonLineMessage, claudeOutput: ClaudeOutput, messageTimestamps: Map<string, string>): void {
    const messageKey = jsonLine.message?.id || `${jsonLine.type}-${JSON.stringify(jsonLine).substring(0, 100)}`;
    const timestamp = messageTimestamps?.get(messageKey);
    claudeOutput.conversationLog.push({ ...jsonLine, timestamp: timestamp || new Date().toISOString() });
    if (jsonLine.type === 'assistant' && jsonLine.message?.model) claudeOutput.model = jsonLine.message.model;
}

function processJsonLine(
    jsonLine: JsonLineMessage,
    claudeOutput: ClaudeOutput,
    messageTimestamps: Map<string, string>
): void {
    if (jsonLine.error || jsonLine.is_error || jsonLine.type === 'error') {
        claudeOutput.failure = classifyExecutionFailure({ error: { ...jsonLine,
            type: jsonLine.subtype ?? jsonLine.type,
        }, agentRan: true });
    }
    // Check for new rate limit format: {"type": "assistant", "error": "rate_limit", "message": {...}}
    if (jsonLine.type === 'assistant' && jsonLine.error === 'rate_limit') {
        handleRateLimitError(jsonLine);
    }

    if (jsonLine.type === 'user' || jsonLine.type === 'assistant') {
        processConversationMessage(jsonLine, claudeOutput, messageTimestamps);
    }

    if (jsonLine.session_id) claudeOutput.sessionId = jsonLine.session_id;
    if (jsonLine.conversation_id) claudeOutput.conversationId = jsonLine.conversation_id;
    if (jsonLine.model) claudeOutput.model = jsonLine.model;

    if (jsonLine.type === 'result') {
        processResultLine(jsonLine, claudeOutput);
    }
}

function processResultLine(jsonLine: JsonLineMessage, claudeOutput: ClaudeOutput): void {
    claudeOutput.finalResult = {
        ...(jsonLine.structured_output === undefined ? {} : { structured_output: jsonLine.structured_output }),
        type: jsonLine.type || 'result',
        subtype: jsonLine.subtype,
        is_error: jsonLine.is_error,
        result: jsonLine.result,
        num_turns: jsonLine.num_turns,
        session_id: jsonLine.session_id,
        terminal_reason: jsonLine.terminal_reason,
        stop_reason: jsonLine.stop_reason,
        total_cost_usd: jsonLine.total_cost_usd,
        cost_usd: jsonLine.cost_usd,
        model: jsonLine.model,
        conversation_id: jsonLine.conversation_id,
        usage: jsonLine.usage
    };
    claudeOutput.success = !jsonLine.is_error;

    // Extract token usage from result line
    if (jsonLine.usage) {
        claudeOutput.tokenUsage = {
            input_tokens: jsonLine.usage.input_tokens,
            output_tokens: jsonLine.usage.output_tokens,
            cache_creation_input_tokens: jsonLine.usage.cache_creation_input_tokens,
            cache_read_input_tokens: jsonLine.usage.cache_read_input_tokens
        };
    }


    if (jsonLine.total_cost_usd && !jsonLine.cost_usd) {
        claudeOutput.finalResult.cost_usd = jsonLine.total_cost_usd;
    }
    if (jsonLine.model) claudeOutput.model = jsonLine.model;
    if (jsonLine.conversation_id) claudeOutput.conversationId = jsonLine.conversation_id;
}

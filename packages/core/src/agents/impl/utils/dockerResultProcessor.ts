/**
 * Docker execution result processing utilities.
 *
 * This module handles the transformation of raw Docker execution results
 * into structured AgentExecutionResult objects.
 */

import { AgentExecutionResult, TokenUsage } from '../../types.js';
import { ExecutionResult } from '../../../claude/docker/dockerExecutor.js';
import { parseStreamJsonOutput } from '../../../claude/claudeHelpers.js';
import { getCorrectedTokenUsage, ensurePromptInConversationLog } from './tokenUtils.js';
import { getClaudeAnalysisText } from './claudeOutputHelpers.js';
import { describeAgentTermination, resolveAgentTerminationReason } from '../../termination.js';

/**
 * Extracts a commit message from Claude's summary.
 * Cleans up markdown formatting but preserves the full content.
 */
function extractCommitMessage(summary: string | undefined): string | null {
    if (!summary || summary.trim().length === 0) {
        return null;
    }

    // Clean up the summary - remove markdown headers and bold markers
    const cleaned = summary
        .replace(/^#+\s*/gm, '') // Remove markdown headers
        .replace(/\*\*/g, '')    // Remove bold markers
        .trim();

    return cleaned || null;
}

function extractExecutionError(
    claudeOutput: ReturnType<typeof parseStreamJsonOutput>,
    stderr: string
): string | undefined {
    if (claudeOutput.success) {
        return undefined;
    }

    const resultText = claudeOutput.finalResult?.result?.trim();
    if (resultText) {
        return resultText;
    }

    const parsedError = claudeOutput.error?.trim();
    if (parsedError) {
        return parsedError;
    }

    const stderrText = stderr.trim();
    if (stderrText) {
        return stderrText;
    }

    return undefined;
}

/**
 * Counts completed model turns. The CLI result line reports `num_turns`; a run
 * killed at its lease has no result line, so count distinct assistant messages
 * (one streamed message can span several events sharing its id).
 */
export function countAgentTurns(
    reportedTurns: number | undefined,
    conversationLog: ReadonlyArray<{ type?: string; message?: { id?: string } }> | undefined
): number {
    if (Number.isSafeInteger(reportedTurns) && (reportedTurns as number) >= 0) return reportedTurns as number;
    const messageIds = new Set<string>();
    let anonymousMessages = 0;
    for (const entry of conversationLog ?? []) {
        if (entry?.type !== 'assistant') continue;
        if (entry.message?.id) messageIds.add(entry.message.id);
        else anonymousMessages += 1;
    }
    return messageIds.size + anonymousMessages;
}

/**
 * Result of processing a Docker execution result.
 */
export interface ProcessedDockerResult {
    /** The transformed agent execution result */
    response: AgentExecutionResult;
    /** Token usage after correction (may differ from reported usage) */
    correctedTokenUsage: TokenUsage | undefined;
    /** The model that was actually used for execution */
    modelUsed: string;
}

/**
 * Processes a Docker execution result and builds the agent response.
 *
 * This function:
 * 1. Parses the stream JSON output from Claude CLI
 * 2. Determines the actual model used
 * 3. Ensures the initial prompt is in the conversation log
 * 4. Corrects token usage if the reported values are incomplete
 * 5. Builds the final AgentExecutionResult
 *
 * @param result - Raw execution result from Docker
 * @param prompt - The prompt that was passed to Claude
 * @param effectiveModel - The model that was requested
 * @param executionTime - Total execution time in milliseconds
 * @returns ProcessedDockerResult containing the response and metadata
 */
export function processDockerResult(
    result: ExecutionResult,
    prompt: string,
    effectiveModel: string,
    executionTime: number
): ProcessedDockerResult {
    const claudeOutput = parseStreamJsonOutput(result);

    // Determine the actual model used (from output or fallback to requested model)
    // 'unknown' is a sentinel value — downstream consumers (metrics, cost calculations) should check for it
    const modelUsed = claudeOutput.model || effectiveModel || 'unknown';

    // Ensure the initial prompt is included in the conversation log
    const fullConversationLog = ensurePromptInConversationLog(
        claudeOutput.conversationLog,
        prompt
    );

    // Get corrected token usage (aggregated if reported is incomplete)
    const correctedTokenUsage = getCorrectedTokenUsage(
        claudeOutput.tokenUsage,
        fullConversationLog
    );

    // Extract commit message from Claude's summary
    const executionError = extractExecutionError(claudeOutput, result.stderr || '');
    const terminationReason = resolveAgentTerminationReason({
        timedOut: result.timedOut,
        subtype: claudeOutput.finalResult?.subtype,
        error: executionError
    });
    const summary = claudeOutput.finalResult?.result
        ?? (terminationReason ? getClaudeAnalysisText(claudeOutput) || undefined : undefined);
    const commitMessage = extractCommitMessage(summary);

    // Build the agent execution response
    const response: AgentExecutionResult = {
        success: claudeOutput.success && !terminationReason,
        executionTimeMs: executionTime,
        logs: result.stderr || '',
        exitCode: result.exitCode,
        rawOutput: result.stdout,
        sessionId: claudeOutput.sessionId ?? undefined,
        conversationId: claudeOutput.conversationId,
        modelUsed,
        cost: claudeOutput.finalResult?.total_cost_usd || claudeOutput.finalResult?.cost_usd,
        modifiedFiles: [],
        commitMessage,
        summary,
        error: executionError || (terminationReason ? describeAgentTermination(terminationReason) : undefined),
        terminationReason,
        prompt,
        conversationLog: fullConversationLog,
        tokenUsage: correctedTokenUsage,
        numTurns: countAgentTurns(claudeOutput.finalResult?.num_turns, claudeOutput.conversationLog)
    };

    return {
        response,
        correctedTokenUsage,
        modelUsed
    };
}

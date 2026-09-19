/**
 * Truthful terminal evidence for an agent run: why it stopped, how many turns and
 * tokens it used, and its final assistant output. Ezer reads this from the task
 * record; the bounded output fits `recovery.checkpointText` for a continuation.
 */
import { redactSecrets, resolveAgentTerminationReason } from '@propr/core';
import type { ClaudeCodeResponse, ExecutionFailureClassification } from '@propr/core';

/** Same bound as ExecutionRecoveryContext.checkpointText, so the output can be handed on verbatim. */
export const MAX_FINAL_OUTPUT_CHARACTERS = 16_384;
const MAX_ERROR_CHARACTERS = 4_000;

export interface AgentOutcome {
    success: boolean;
    terminationReason?: 'timeout' | 'max_turns';
    failureClassification?: ExecutionFailureClassification;
    numTurns: number;
    tokenUsage?: ClaudeCodeResponse['tokenUsage'];
    costUsd?: number;
    executionTimeMs: number;
    finalOutput?: string;
    error?: string;
}

export function classifyExecutionFailure(claudeResult: ClaudeCodeResponse): ExecutionFailureClassification {
    return resolveAgentTerminationReason(claudeResult) ?? 'agent_error';
}

function finalAssistantOutput(claudeResult: ClaudeCodeResponse): string | undefined {
    const text = claudeResult.summary ?? claudeResult.finalResult?.result ?? undefined;
    if (!text?.trim()) return undefined;
    const redacted = redactSecrets(text);
    // Keep the end: the latest assistant text is where a stopped run left off.
    return redacted.length > MAX_FINAL_OUTPUT_CHARACTERS ? redacted.slice(-MAX_FINAL_OUTPUT_CHARACTERS) : redacted;
}

export function buildAgentOutcome(claudeResult: ClaudeCodeResponse): AgentOutcome {
    const terminationReason = resolveAgentTerminationReason(claudeResult);
    const costUsd = claudeResult.finalResult?.total_cost_usd ?? claudeResult.finalResult?.cost_usd;
    const finalOutput = finalAssistantOutput(claudeResult);
    const error = claudeResult.success ? undefined : claudeResult.error?.trim();
    return {
        success: claudeResult.success,
        ...(terminationReason ? { terminationReason } : {}),
        ...(claudeResult.success ? {} : { failureClassification: classifyExecutionFailure(claudeResult) }),
        numTurns: claudeResult.numTurns ?? claudeResult.finalResult?.num_turns ?? 0,
        ...(claudeResult.tokenUsage ? { tokenUsage: claudeResult.tokenUsage } : {}),
        ...(typeof costUsd === 'number' ? { costUsd } : {}),
        executionTimeMs: claudeResult.executionTime,
        ...(finalOutput ? { finalOutput } : {}),
        ...(error ? { error: redactSecrets(error).slice(0, MAX_ERROR_CHARACTERS) } : {}),
    };
}

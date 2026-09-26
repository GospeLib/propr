import { classifyExecutionFailure } from '../agents/executionFailure.js';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';
import { getDefaultModel } from '../config/modelAliases.js';
import type { AgentTerminationReason } from '../agents/types.js';
import { countAgentTurns } from '../agents/turnCount.js';
import { generateTaskImportPrompt, IssueRef, IssueDetails } from './prompts/promptGenerator.js';
import { executeDockerCommand, buildClaudeDockerImage as buildDockerImageInternal } from './docker/dockerExecutor.js';
import {
    verifyWorktreeStructure,
    verifyWorktreePostExecution,
    setWorktreeOwnership,
    buildDockerArgs,
    parseStreamJsonOutput,
    storePromptInRedis,
    buildClaudePrompt,
    UsageLimitError,
    ClaudeOutput,
    ConversationLogEntry,
    ClaudeOutputResult,
    TokenUsage
} from './claudeHelpers.js';
import type { ConversationStep } from '../utils/llmMetrics.types.js';
import { executeWithUsageTracking, type UsageTrackingMetrics } from '../agents/impl/utils/index.js';
import { DEFAULT_AGENT_DOCKER_IMAGES, DEFAULT_AGENT_EXECUTION_TIMEOUT_MS } from '../agents/constants.js';
import type { ReasoningLevel } from '@propr/shared';
import { resolveAgentTerminationReason } from '../agents/termination.js';
export { UsageLimitError };
export type { IssueRef, IssueDetails };
// The lightweight (non-executeClaudeCode) analysis path lives in its own module to
// keep this file under the file-size cap (INV-4); re-exported here so the public
// import path (./claude/claudeService.js) is unchanged.
export {
    generateTaskSummary,
    runLightweightLLMAnalysis,
    type GenerateTaskSummaryOptions,
    type RunLightweightLLMAnalysisOptions,
} from './claudeLightweightAnalysis.js';

const CLAUDE_DOCKER_IMAGE: string = process.env.AGENT_DOCKER_IMAGE || DEFAULT_AGENT_DOCKER_IMAGES.claude;
const CLAUDE_CONFIG_PATH: string = process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude');
const CLAUDE_MAX_TURNS: number = parseInt(process.env.CLAUDE_MAX_TURNS || '1000', 10);
const CLAUDE_TIMEOUT_MS: number = parseInt(process.env.CLAUDE_TIMEOUT_MS || String(DEFAULT_AGENT_EXECUTION_TIMEOUT_MS), 10);

/** @deprecated Use AgentRegistry and Agent.executeTask() instead. */
export interface ExecuteClaudeCodeOptions {
    worktreePath: string;
    issueRef: IssueRef;
    githubToken: string;
    customPrompt?: string;
    isRetry?: boolean;
    retryReason?: string;
    branchName?: string;
    modelName?: string;
    issueDetails?: IssueDetails;
    onSessionId?: (sessionId: string, conversationId?: string) => void;
    onContainerId?: (containerId: string, containerName: string) => void;
    systemPrompt?: string;
    tools?: string;
    timeoutMs?: number;
}

export interface ClaudeCodeResponse {
    failureKind?: import('../agents/executionFailure.js').FailureKind;
    usageResetAt?: string;
    success: boolean;
    executionTime: number;
    output: ClaudeOutput | null;
    logs: string;
    exitCode?: number | null;
    rawOutput?: string;
    conversationLog?: ConversationLogEntry[];
    sessionId?: string | null;
    conversationId?: string;
    model?: string;
    /** Effective reasoning level passed to the agent runtime, when configured. */
    reasoningLevel?: ReasoningLevel;
    finalResult?: ClaudeOutputResult | null;
    modifiedFiles: string[];
    commitMessage: string | null;
    summary: string | null;
    prompt?: string;
    error?: string;
    terminationReason?: AgentTerminationReason;
    tokenUsage?: TokenUsage;
    /** Model turns actually completed, including runs stopped at a turn limit or lease. */
    numTurns?: number;
    usageMetrics?: UsageTrackingMetrics | null;
}

/** @deprecated Use AgentRegistry.getDefaultAgent().executeTask() instead. */
export async function executeClaudeCode(options: ExecuteClaudeCodeOptions): Promise<ClaudeCodeResponse> {
    const { worktreePath, issueRef, githubToken, customPrompt, isRetry = false, retryReason, branchName, modelName, issueDetails, onSessionId, onContainerId, timeoutMs } = options;
    const startTime = Date.now();

    const repo = `${issueRef.repoOwner}/${issueRef.repoName}`;
    logger.info({ issueNumber: issueRef.number, repository: repo, worktreePath, isRetry },
        isRetry ? 'Starting Claude Code execution (RETRY)' : 'Starting Claude Code execution');

    try {
        const prompt = buildClaudePrompt({ customPrompt, issueRef, branchName, modelName, issueDetails, isRetry, retryReason });
        await setWorktreeOwnership(worktreePath, issueRef.number);
        const worktreeGitContent = verifyWorktreeStructure(worktreePath, issueRef.number);

        const dockerArgs = buildDockerArgs({
            worktreePath, githubToken, prompt, modelName, issueNumber: issueRef.number,
            CLAUDE_DOCKER_IMAGE, CLAUDE_CONFIG_PATH, CLAUDE_MAX_TURNS,
            systemPrompt: options.systemPrompt, tools: options.tools, agentAlias: 'claude'
        });
        const { result, usageMetrics } = await executeWithUsageTracking(
            'claude',
            async () => executeDockerCommand('docker', dockerArgs, {
                timeout: timeoutMs ?? CLAUDE_TIMEOUT_MS,
                cwd: worktreePath,
                onSessionId,
                onContainerId,
                worktreePath,
                stdinData: prompt, // Always pass prompt via stdin
                preserveOutputOnTimeout: true
            })
        );

        const executionTime = Date.now() - startTime;
        logger.info({ issueNumber: issueRef.number, executionTime, exitCode: result.exitCode }, 'Claude Code execution completed');

        const claudeOutput = parseStreamJsonOutput(result);
        const terminationReason = resolveAgentTerminationReason({
            timedOut: result.timedOut,
            subtype: claudeOutput.finalResult?.subtype,
            error: result.stderr
        });
        const response: ClaudeCodeResponse = {
            success: claudeOutput.success && !terminationReason,
            executionTime,
            output: claudeOutput,
            logs: result.stderr || '',
            exitCode: result.exitCode,
            rawOutput: result.stdout,
            conversationLog: claudeOutput.conversationLog || [],
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            model: claudeOutput.model || process.env.CLAUDE_MODEL || getDefaultModel() || (() => {
                logger.error('No default model configured - using sentinel value "unconfigured". Configure an AI agent with a default model in the dashboard.');
                return 'unconfigured';
            })(),
            finalResult: claudeOutput.finalResult,
            modifiedFiles: [],
            commitMessage: null,
            summary: claudeOutput.finalResult?.result || null,
            error: terminationReason ? result.stderr : undefined,
            terminationReason,
            ...(!(claudeOutput.success && !terminationReason) ? classifyExecutionFailure({
                ...claudeOutput.failure, terminationReason,
                transportError: result.stderr,
                infrastructure: result.infrastructureFailure,
                agentRan: !!claudeOutput.finalResult || !!claudeOutput.sessionId || claudeOutput.conversationLog.length > 0,
            }) : {}),
            prompt: prompt,
            tokenUsage: claudeOutput.tokenUsage,
            usageMetrics
        };

        await storePromptInRedis({ claudeOutput, prompt, issueRef, model: response.model!, isRetry, retryReason });

        if (!response.success) {
            logger.error({ issueNumber: issueRef.number, exitCode: result.exitCode }, 'Claude Code execution failed');
        } else {
            logger.info({ issueNumber: issueRef.number, model: response.model }, 'Claude Code execution succeeded');
            verifyWorktreePostExecution(worktreePath, issueRef.number, worktreeGitContent);
        }

        return response;
    } catch (error) {
        if (error instanceof UsageLimitError) {
            throw error;
        }

        const executionTime = Date.now() - startTime;
        const err = error as Error;
        logger.error({ issueNumber: issueRef.number, executionTime, error: err.message }, 'Error during Claude Code execution');
        return {
            success: false, ...classifyExecutionFailure({ error, ...error as object, transportError: error }), error: err.message, executionTime, output: null,
            logs: (error as { stderr?: string }).stderr || err.message,
            modifiedFiles: [], commitMessage: null, summary: null
        };
    }
}

export const buildClaudeDockerImage = buildDockerImageInternal;

export { generateTaskImportPrompt };

export function buildLlmMetricsPayload(claudeResult: ClaudeCodeResponse, fallbackModel: string) {
    return {
        model: claudeResult.model ?? fallbackModel,
        success: claudeResult.success,
        executionTime: claudeResult.executionTime,
        sessionId: claudeResult.sessionId,
        conversationId: claudeResult.conversationId,
        conversationLog: claudeResult.conversationLog as unknown as ConversationStep[],
        tokenUsage: claudeResult.tokenUsage,
        finalResult: claudeResult.finalResult ? {
            num_turns: countAgentTurns('claude', { events: claudeResult.conversationLog as unknown as ReadonlyArray<unknown> | undefined }),
            cost_usd: undefined
        } : null,
        error: claudeResult.error
    };
}

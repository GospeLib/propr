/**
 * Lightweight (non-Docker-Claude-only) LLM analysis path, extracted from claudeService.ts
 * to keep that file under the repo's file-size cap (INV-4). Behaviour-preserving split:
 * re-exported verbatim from claudeService.ts so the public import path is unchanged.
 */
import logger from '../utils/logger.js';
import { resolveModelAlias } from '../config/modelAliases.js';
import { AgentRegistry } from '../agents/AgentRegistry.js';
import type { AnalysisResult } from '../agents/types.js';
import type { IssueRef } from './prompts/promptGenerator.js';
import type { UsageTrackingMetrics } from '../agents/impl/utils/index.js';
import type { ReasoningLevel } from '@propr/shared';
import { recordLLMMetrics } from '../utils/llmMetrics.js';
import { persistLlmLog, createLlmLogFromAnalysis } from '../utils/llmLogger.js';
import type { ExecutionType } from '../utils/llmMetrics.types.js';
import type { SyntheticRoutingSession } from '../services/syntheticRoutingService.js';
import { loadSummarizationSettings } from '../config/configManager.js';
import { resolveConfiguredModel } from '../config/configuredModel.js';
import { executeClaudeCode, buildLlmMetricsPayload, type ClaudeCodeResponse } from './claudeService.js';

const LIGHTWEIGHT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const LIGHTWEIGHT_TOOLS = '';

export interface GenerateTaskSummaryOptions {
    summaryRequest: string;
    worktreePath: string;
    githubToken: string;
    issueRef: IssueRef;
    correlationId: string;
    modelAlias?: string;
}

export interface RunLightweightLLMAnalysisOptions {
    prompt: string;
    model: string;
    correlationId: string;
    worktreePath: string;
    githubToken: string;
    issueRef: IssueRef;
    taskId?: string;
    prNumber?: number;
    executionType?: ExecutionType;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
    reasoningLevel?: ReasoningLevel;
    /** Whether an omitted reasoning level may inherit the configured per-model/global levels. Defaults to false. */
    useConfiguredReasoningLevel?: boolean;
    /** Preselected call-scoped route used by context-sensitive callers. */
    routingSession?: SyntheticRoutingSession;
}

interface ParsedModelInfo {
    agentAlias?: string;
    modelOverride?: string;
    effectiveModel: string;
}

function parseAgentModelFormat(model: string, correlatedLogger: ReturnType<typeof logger.withCorrelation>): ParsedModelInfo {
    if (model && model.includes(':')) {
        const parts = model.split(':');
        const agentAlias = parts[0];
        const modelOverride = parts.slice(1).join(':');
        correlatedLogger.info({ model, agentAlias, modelOverride }, 'Parsed agent:model format');
        return { agentAlias, modelOverride, effectiveModel: modelOverride };
    }
    return { effectiveModel: model };
}

function mapUsageMetrics(usageMetrics: UsageTrackingMetrics | null | undefined) {
    if (!usageMetrics) return undefined;
    return {
        preCall: usageMetrics.preCall,
        postCall: usageMetrics.postCall,
        delta: usageMetrics.delta,
        records: usageMetrics.records,
        timestamp: usageMetrics.timestamp,
        agent: usageMetrics.agent
    };
}

interface AgentExecutionParams {
    agentAlias: string;
    modelOverride?: string;
    prompt: string;
    taskId?: string;
    taskNumber?: number;
    prNumber?: number;
    executionType?: string;
    correlationId?: string;
    repository?: string;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
    reasoningLevel?: ReasoningLevel;
    useConfiguredReasoningLevel?: boolean;
    correlatedLogger: ReturnType<typeof logger.withCorrelation>;
    routingSession?: SyntheticRoutingSession;
}

async function tryExecuteWithAgent(params: AgentExecutionParams): Promise<AnalysisResult | null> {
    const { agentAlias, modelOverride, prompt, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, reasoningLevel, useConfiguredReasoningLevel, correlatedLogger, routingSession } = params;
    const registry = AgentRegistry.getInstance();
    await registry.ensureInitialized();

    const agent = registry.getAgentByAlias(agentAlias);
    if (!agent) {
        correlatedLogger.warn({ agentAlias }, 'Agent not found, falling back to default execution');
        return null;
    }

    const resolvedModel = modelOverride ? resolveModelAlias(modelOverride) : agent.config.defaultModel;
    correlatedLogger.info({ agentAlias, resolvedModel, taskId, executionType }, 'Using agent-specific lightweight LLM analysis');
    const analyzeOptions = { model: resolvedModel, taskId, taskNumber, prNumber, executionType, correlationId, repository, metadata, timeoutMs, reasoningLevel, useConfiguredReasoningLevel };
    return routingSession
        ? await routingSession.analyze(prompt, analyzeOptions)
        : await agent.analyze(prompt, analyzeOptions);
}

function buildWorkRef(opts: {
    executionType: string;
    taskId?: string;
    prNumber?: number;
    issueRef?: IssueRef;
    repository?: string;
}): Record<string, unknown> {
    const isPlan = opts.executionType === 'plan-generation' || opts.executionType === 'plan-refinement';
    const taskNumber = isPlan ? undefined : opts.issueRef?.number;
    return {
        workType: isPlan ? 'plan' : (opts.taskId || taskNumber) ? 'task' : 'repository',
        taskId: isPlan ? undefined : opts.taskId,
        taskNumber,
        prNumber: isPlan ? undefined : opts.prNumber,
        planDraftId: isPlan ? opts.taskId : undefined,
        workRepository: opts.repository,
    };
}

async function executeClaudeAnalysis(
    options: RunLightweightLLMAnalysisOptions,
    resolvedModel: string,
    correlatedLogger: ReturnType<typeof logger.withCorrelation>
): Promise<string> {
    const { prompt, correlationId, worktreePath, githubToken, issueRef, taskId, prNumber, executionType = 'other', model, timeoutMs } = options;

    const claudeResult: ClaudeCodeResponse = await executeClaudeCode({
        worktreePath, issueRef, githubToken,
        customPrompt: `${prompt}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only provide direct output.`,
        branchName: 'analysis-generation',
        modelName: resolvedModel,
        systemPrompt: LIGHTWEIGHT_SYSTEM_PROMPT,
        tools: LIGHTWEIGHT_TOOLS,
        timeoutMs,
    });

    await recordLLMMetrics(buildLlmMetricsPayload(claudeResult, resolvedModel), issueRef, { correlationId, taskId, executionType });

    const repository = issueRef ? `${issueRef.repoOwner}/${issueRef.repoName}` : undefined;
    await persistLlmLog(createLlmLogFromAnalysis({
        executionType,
        modelUsed: claudeResult.model ?? resolvedModel,
        executionTimeMs: claudeResult.executionTime,
        success: claudeResult.success,
        tokenUsage: claudeResult.tokenUsage,
        error: claudeResult.error,
        sessionId: claudeResult.sessionId ?? undefined,
        correlationId, draftId: taskId, repository,
        agentAlias: 'claude',
        usageMetrics: mapUsageMetrics(claudeResult.usageMetrics),
        usageMetricRecords: claudeResult.usageMetrics?.records,
        workRef: buildWorkRef({ executionType, taskId, prNumber, issueRef, repository }),
    }));

    const analysisText = (claudeResult.finalResult?.result || claudeResult.summary)?.trim();
    if (analysisText) {
        correlatedLogger.info({ model, responseLength: analysisText.length, exitCode: claudeResult.exitCode }, 'Lightweight LLM analysis completed via Docker');
        return analysisText;
    }

    correlatedLogger.error({ exitCode: claudeResult.exitCode, rawOutputLength: claudeResult.rawOutput?.length }, 'Claude execution did not produce valid result');
    throw new Error(`Invalid analysis response from Claude execution: ${claudeResult.error || 'No result returned'}`);
}

export async function runLightweightLLMAnalysis(options: RunLightweightLLMAnalysisOptions): Promise<string> {
    const { prompt, model, correlationId, taskId, prNumber, issueRef, executionType = 'other', metadata, timeoutMs, reasoningLevel, useConfiguredReasoningLevel, routingSession } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);

    const { agentAlias, modelOverride, effectiveModel } = parseAgentModelFormat(model, correlatedLogger);

    if (agentAlias) {
        try {
            const repository = issueRef ? `${issueRef.repoOwner}/${issueRef.repoName}` : undefined;
            const taskNumber = issueRef?.number;
            // Pass all logging fields to agent - agent handles persistence internally
            const analysisResult = await tryExecuteWithAgent({
                agentAlias, modelOverride, prompt, taskId, taskNumber, prNumber, executionType,
                correlationId, repository, metadata, timeoutMs, reasoningLevel, useConfiguredReasoningLevel, correlatedLogger, routingSession
            });
            if (analysisResult !== null) {
                if (!analysisResult.success) {
                    throw new Error(analysisResult.error || 'Agent analysis failed');
                }
                correlatedLogger.info({ agentAlias, model: analysisResult.modelUsed, responseLength: analysisResult.response.length }, 'Agent analysis completed');
                return analysisResult.response;
            }
        } catch (agentError) {
            const err = agentError as Error;
            correlatedLogger.error({ error: err.message, agentAlias }, 'Agent execution failed');
            throw new Error(`Agent '${agentAlias}' failed: ${err.message}`);
        }
    }

    const resolvedModel = resolveModelAlias(effectiveModel);
    correlatedLogger.info({ model, resolvedModel }, 'Running lightweight LLM analysis via Docker...');

    try {
        return await executeClaudeAnalysis(options, resolvedModel, correlatedLogger);
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ error: err.message, model }, 'Lightweight LLM analysis failed');
        throw error;
    }
}

export async function generateTaskSummary(options: GenerateTaskSummaryOptions): Promise<string> {
    const { summaryRequest, worktreePath, githubToken, issueRef, correlationId, modelAlias } = options;
    const correlatedLogger = logger.withCorrelation(correlationId);
    const summarizationSettings = await loadSummarizationSettings();
    const configuredModel = modelAlias?.trim() || summarizationSettings.agent_alias?.trim();
    if (!configuredModel) {
        throw new Error('No summarization model configured for task summary generation.');
    }
    const model = await resolveConfiguredModel(configuredModel);
    correlatedLogger.info({ model, issueRef: issueRef.number }, 'Generating task summary');
    const summaryPrompt = `Please provide a one-sentence summary for the following request, focusing on the main action. Your output must be ONLY the summary string itself, with no other text.\n\nREQUEST:\n${summaryRequest}\n\nCRITICAL: Do not modify any files. Do not run any commands. Only output the summary.`;

    try {
        const rawSummary = await runLightweightLLMAnalysis({
            prompt: summaryPrompt,
            model,
            correlationId,
            worktreePath,
            githubToken,
            issueRef,
            executionType: 'title-generation',
        });
        const summary = rawSummary.split('\n')[0].replace(/^#+\s*/, '').replace(/^"|"$/g, '').trim();
        if (!summary) throw new Error('Task summary generation returned an empty response.');
        correlatedLogger.info({ summary, model }, 'Successfully generated task summary');
        return summary;
    } catch (error) {
        const err = error as Error;
        correlatedLogger.error({ error: err.message, model }, 'Failed to generate task summary');
        throw error;
    }
}

import type { AnalyzeOptions } from '../../types.js';
import { PLANNING_ARTIFACT_PROFILE, PLANNING_ARTIFACT_TIMEOUT_MS, PLANNING_ARTIFACT_MAX_OUTPUT_TOKENS } from '../../constants.js';

const DEFAULT_ANALYSIS_TIMEOUT_MS = 30 * 60 * 1000;
export const ANALYSIS_SYSTEM_PROMPT = 'You are a helpful assistant.';
const CLOSED_PROFILE_AUTH_ERROR = 'Closed planning profile requires subscription CLI init without API authentication or MCP servers';
const SUBSCRIPTION_CLI_API_KEY_SOURCE = 'none';

/** Observed Max/OAuth CLI init reports "none". This is accepted only inside
 * the closed settings/environment profile; "none" alone is not an auth proof. */
export function planningAnalysisAuthFailure(stdout: string): string | undefined {
    const init = stdout.split('\n').flatMap(line => {
        try { const event = JSON.parse(line); return event?.type === 'system' && event.subtype === 'init' ? [event] : []; }
        catch { return []; }
    });
    return init.length === 1 && init[0].apiKeySource === SUBSCRIPTION_CLI_API_KEY_SOURCE &&
        Array.isArray(init[0].mcp_servers) && init[0].mcp_servers.length === 0
        ? undefined : CLOSED_PROFILE_AUTH_ERROR;
}

export async function checkpointAnalysisInput(callbacks: AnalyzeOptions['executionCallbacks'], prompt: string,
    responseSchema?: AnalyzeOptions['responseSchema']): Promise<void> {
    await callbacks?.onInputPrepared?.({ prompt, systemPrompt: ANALYSIS_SYSTEM_PROMPT,
        ...(responseSchema === undefined ? {} : { responseSchema }) });
}
export function nativeAnalysisExecutorOptions(callbacks: AnalyzeOptions['executionCallbacks'], worktreePath: string, taskId?: string) {
    return callbacks ? { worktreePath, streamToRedis: Boolean(taskId), preserveOutputOnTimeout: true,
        preserveTerminalEvidence: true, ...callbacks } : {};
}

/** Closed policy reuses the CLI's existing effort and environment controls. */
export function resolveAnalysisPolicy(options?: AnalyzeOptions) {
    const responseSchema = options?.responseSchema;
    if (responseSchema !== undefined && options?.responseFormat !== 'json')
        throw new Error('Structured output requires JSON response format');
    if (options?.analysisProfile === PLANNING_ARTIFACT_PROFILE) return {
        responseSchema,
        timeoutScope: 'execution' as const,
        timeoutMs: PLANNING_ARTIFACT_TIMEOUT_MS,
        reasoningLevel: 'low' as const,
        environment: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(PLANNING_ARTIFACT_MAX_OUTPUT_TOKENS) },
    };
    return {
        responseSchema,
        timeoutScope: 'command' as const,
        timeoutMs: options?.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
        reasoningLevel: options?.reasoningLevel,
        environment: undefined,
    };
}

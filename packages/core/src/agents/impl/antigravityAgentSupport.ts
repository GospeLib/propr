/**
 * Pure helper functions for AntigravityAgent, extracted to keep the class file under
 * the repo's file-size cap (INV-4). Behaviour-preserving split: no logic changes.
 */
import { estimateTokens } from '../../utils/tokenCalculation.js';
import { antigravityModelIdsMatch } from './antigravityModelIds.js';
import { resolveAntigravityProtocolError } from './utils/antigravityProtocol.js';
import { normalizeAntigravityModelId, type AntigravityOutputEvent } from './utils/antigravityOutputParser.js';
import type { TokenUsage } from '../types.js';

export const DEFAULT_ANTIGRAVITY_TRANSCRIPT_ROOT = '/tmp/git-processor/propr-cache/transcripts/antigravity';
const GITHUB_CREDENTIAL_ENV_PATTERN = /^(?:GH|GITHUB)_.*(?:TOKEN|KEY|SECRET|PASSWORD|PAT|PRIVATE_KEY)$/;

export function isSuccessfulAnalysisResult(
    result: { timedOut?: boolean; exitCode: number | null },
    summary: string | undefined,
    protocolError?: string,
): boolean {
    return !protocolError && !result.timedOut && (result.exitCode === 0 || !!summary);
}

export function resolveAntigravityModelIdentity(reportedModel: string | undefined, requestedModel: string | undefined, requireReportedModel: boolean): { modelUsed: string; error?: string } { const reported = reportedModel || undefined; const requested = requestedModel ? normalizeAntigravityModelId(requestedModel) : undefined; const missingReported = requireReportedModel && !!requested && !reported; const matches = !reported || !requested || antigravityModelIdsMatch(requested, reported); return { modelUsed: missingReported ? 'unknown' : matches && requested ? requested : reported ?? requested ?? 'unknown', error: missingReported ? `Antigravity stream did not report a model identity for requested model "${requested}"` : matches ? undefined : `Antigravity reported model "${reported}" but "${requested}" was requested` }; }

export function resolveAntigravityExecutionError(terminalStatus: 'success' | 'error' | undefined, protocolError: string | undefined, hasStreamEnvelopes: boolean, modelIdentityError: string | undefined): string | undefined { return resolveAntigravityProtocolError(terminalStatus, protocolError, hasStreamEnvelopes) ?? modelIdentityError; }

export function resolveAntigravityEvidenceConflict(stdoutModel: string | undefined, transcriptModel: string | undefined, stdoutConversation: string | undefined, transcriptConversation: string | undefined): string | undefined { if (stdoutConversation && transcriptConversation && stdoutConversation !== transcriptConversation) return `Conflicting Antigravity conversation identities: stdout reported "${stdoutConversation}" but transcript reported "${transcriptConversation}"`; const stdout = stdoutModel && normalizeAntigravityModelId(stdoutModel); const transcript = transcriptModel && normalizeAntigravityModelId(transcriptModel); return stdout && transcript && stdout !== transcript ? `Conflicting Antigravity model identities: stdout reported "${stdout}" but transcript reported "${transcript}"` : undefined; }

export function buildAgentEnvironmentArgs(
    repositoryInspection: boolean,
    ...sources: Array<Record<string, string> | undefined>
): string[] {
    const args: string[] = [];
    for (const source of sources) {
        if (!source) continue;
        for (const [key, value] of Object.entries(source)) {
            if (repositoryInspection && GITHUB_CREDENTIAL_ENV_PATTERN.test(key.toUpperCase())) continue;
            args.push('-e', `${key}=${value}`);
        }
    }
    return args;
}

export function assertRepositoryInspectionMode(repositoryInspection: boolean, readOnlyWorkspace: boolean): void {
    if (repositoryInspection && !readOnlyWorkspace) {
        throw new Error('Repository inspection requires a read-only workspace');
    }
}

export function getAntigravityTranscriptRoot(): string {
    return process.env.PROPR_ANTIGRAVITY_TRANSCRIPT_ROOT || DEFAULT_ANTIGRAVITY_TRANSCRIPT_ROOT;
}

export function mergeTokenUsage(
    primary: TokenUsage,
    fallback?: TokenUsage
): TokenUsage {
    return {
        input_tokens: primary.input_tokens ?? fallback?.input_tokens,
        output_tokens: primary.output_tokens ?? fallback?.output_tokens,
        cache_creation_input_tokens: primary.cache_creation_input_tokens ?? fallback?.cache_creation_input_tokens,
        cache_read_input_tokens: primary.cache_read_input_tokens ?? fallback?.cache_read_input_tokens,
        reasoning_output_tokens: primary.reasoning_output_tokens ?? fallback?.reasoning_output_tokens,
    };
}

/** Whether a transcript event's content was authored by the model (output) vs consumed by it (input). */
export function isModelAuthoredEvent(event: AntigravityOutputEvent): boolean {
    const role = (event as { role?: string }).role;
    if (role === 'assistant') return true;
    const type = (event as { type?: string }).type;
    // PLANNER_RESPONSE = model's text; CODE_ACTION = edits the model wrote.
    // VIEW_FILE / GREP_SEARCH / RUN_COMMAND content is dominated by results the
    // model reads, so treat those as input.
    return type === 'PLANNER_RESPONSE' || type === 'CODE_ACTION';
}

/**
 * Older/plain agy output reports no token usage, so estimate from the full transcript. The model
 * AUTHORS planner responses, code edits, and assistant messages (output); it
 * CONSUMES the prompt, file views, search results, command output, and history
 * (input). Counting only the prompt + final messages undercounts agentic runs
 * by ~10-100x. Reported counts win when present. This is an estimate (it can't
 * capture cumulative re-read context across agentic turns), but it lands in the
 * right order of magnitude instead of near zero.
 */
export function resolveTokenUsage(
    reported: TokenUsage,
    prompt: string,
    summary: string | undefined,
    conversationLog: AntigravityOutputEvent[]
): TokenUsage | undefined {
    if (reported.input_tokens || reported.output_tokens || reported.cache_read_input_tokens || reported.reasoning_output_tokens) return reported;

    let inputText = '';
    let outputText = '';
    for (const event of conversationLog) {
        const content = 'content' in event && typeof event.content === 'string' ? event.content : '';
        if (!content) continue;
        if (isModelAuthoredEvent(event)) outputText += `${content}\n`;
        else inputText += `${content}\n`;
    }

    // Fallbacks when the transcript has no usable content (e.g. plain-text
    // --print output, as in the analyze path): estimate from prompt + summary.
    if (!inputText && !outputText) {
        inputText = prompt;
        outputText = summary || '';
    } else if (!inputText) {
        inputText = prompt; // transcript had only model output; still count the prompt
    }

    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(outputText);
    return inputTokens || outputTokens
        ? { input_tokens: inputTokens, output_tokens: outputTokens }
        : undefined;
}

export function buildAntigravityShellCommand(cliCommand: string, repositoryInspection = false): string {
    // With no prompt flag, agy detects non-TTY stdin and enters print mode.
    // This is required because repo-context prompts routinely exceed Linux's
    // 128 KiB per-argument limit (MAX_ARG_STRLEN). Passing `--print -` does
    // not read stdin: agy treats `-` as the literal prompt. `"$@"` carries
    // only CLI flags such as `--model`, so all flags precede the stdin prompt.
    const safetyArgs = repositoryInspection
        ? '--sandbox --disable-slash-commands'
        : '--dangerously-skip-permissions';
    return ['set -e', `exec ${cliCommand} ${safetyArgs} "$@"`].join('\n');
}

export function buildContainerName(alias: string, taskType: string, shortTaskId: string, modelName?: string): string {
    const suffix = `-${shortTaskId}`;
    const rawPrefix = modelName
        ? `${alias}-${taskType}-${modelName}`
        : `${alias}-${taskType}`;
    const maxPrefixLength = Math.max(1, 120 - suffix.length);
    const sanitizedPrefix = rawPrefix.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, maxPrefixLength).replace(/[^a-zA-Z0-9]+$/, '');
    return `${sanitizedPrefix || 'antigravity'}${suffix}`.slice(0, 128);
}

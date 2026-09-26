/** Stable failure causes for final execution records; raw provider details stay internal. */
export type FailureKind = 'provider_error' | 'usage_limit' | 'timeout' | 'max_turns' | 'agent_error' | 'infrastructure';
export interface ExecutionFailure {
    failureKind?: FailureKind;
    /** Provider-reported reset only, never a locally estimated retry time. */
    usageResetAt?: string;
}

interface FailureInput extends ExecutionFailure {
    terminationReason?: 'timeout' | 'max_turns';
    timedOut?: boolean;
    agentRan?: boolean;
    infrastructure?: boolean;
    error?: unknown;
    /** Only CLI/transport diagnostics, never agent-authored result or summary text. */
    transportError?: unknown;
    now?: number;
}
const USAGE_LIMIT_PATTERN = /^(?:API Error: 429\b[^\n]*|Claude AI usage limit reached\|\d+|rate_limit_error|insufficient_quota)$/im;
const PROVIDER_ERROR_PATTERN = /^(?:API Error: 5\d\d\b[^\n]*|overloaded_error|overload_error|api_error)$/im;
const TIMEOUT_PATTERN = /(?:^|\n)(?:command|agent execution) timed out after \d+ms$/i;
const MAX_TURNS_PATTERN = /(?:error[_ -]max[_ -]turns|max(?:imum)?(?: number of)? (?:turns|steps|iterations)(?: reached| exceeded)?)/i;

/** Last resort for CLI versions that expose no structured failure. Never parses reset dates. */
function classifyFailureMessage(message: string): FailureKind | undefined {
    if (USAGE_LIMIT_PATTERN.test(message)) return 'usage_limit';
    if (PROVIDER_ERROR_PATTERN.test(message)) return 'provider_error';
    if (TIMEOUT_PATTERN.test(message)) return 'timeout';
    if (MAX_TURNS_PATTERN.test(message)) return 'max_turns';
    return undefined;
}
function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function iso(value: unknown): string | undefined {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function header(headers: unknown, name: string): string | undefined {
    const record = object(headers);
    if (typeof record.get === 'function') return record.get.call(headers, name) ?? undefined;
    const key = Object.keys(record).find(key => key.toLowerCase() === name);
    return key && typeof record[key] === 'string' ? record[key] as string : undefined;
}
function reportedReset(error: Record<string, unknown>, now: number): string | undefined {
    const explicit = iso(error.usageResetAt);
    if (explicit) return explicit;
    const headers = error.headers ?? object(error.response).headers;
    const retryAfter = header(headers, 'retry-after');
    if (retryAfter) {
        const time = /^\d+(?:\.\d+)?$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
        if (Number.isFinite(time) && Math.abs(time) <= 8.64e15) return new Date(time).toISOString();
    }
    const resets = ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']
        .map(name => iso(header(headers, name))).filter((value): value is string => !!value);
    return resets.sort().at(-1);
}

/** Structured signals precede text; lack of evidence that the agent ran is infrastructure. */
export function classifyExecutionFailure(input: FailureInput): Required<Pick<ExecutionFailure, 'failureKind'>> & ExecutionFailure {
    const error = object(input.error);
    const nested = object(error.error);
    const status = error.status ?? error.statusCode ?? object(error.response).status;
    const type = nested.type ?? (typeof error.error === 'string' ? error.error : undefined) ?? error.type ?? error.name;
    let failureKind: FailureKind | undefined = input.terminationReason ?? (input.timedOut ? 'timeout' : undefined);
    if (!failureKind && input.infrastructure) failureKind = 'infrastructure';
    if (!failureKind && (status === 429 || ['rate_limit', 'rate_limit_error', 'usage_limit', 'UsageLimitError', 'RateLimitError', 'insufficient_quota'].includes(String(type)))) failureKind = 'usage_limit';
    if (!failureKind && ((typeof status === 'number' && status >= 500 && status <= 599) || ['overloaded', 'overloaded_error', 'overload_error', 'server_error', 'api_error', 'InternalServerError'].includes(String(type)))) failureKind = 'provider_error';
    if (!failureKind && (error.timedOut === true || type === 'APIConnectionTimeoutError')) failureKind = 'timeout';
    if (!failureKind && type === 'error_max_turns') failureKind = 'max_turns';
    if (!failureKind && ['APIConnectionError', 'ECONNREFUSED', 'ENOENT', 'EACCES'].includes(String(error.code ?? type))) failureKind = 'infrastructure';
    failureKind ??= input.failureKind;
    const transport = object(input.transportError);
    const message = typeof input.transportError === 'string' ? input.transportError : String(transport.message ?? '');
    failureKind ??= classifyFailureMessage(message);
    failureKind ??= input.agentRan ? 'agent_error' : 'infrastructure';
    const usageResetAt = failureKind === 'usage_limit' ? iso(input.usageResetAt) ?? reportedReset(error, input.now ?? Date.now()) : undefined;
    return { failureKind, ...(usageResetAt ? { usageResetAt } : {}) };
}

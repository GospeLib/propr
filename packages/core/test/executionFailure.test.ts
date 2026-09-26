import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutionFailure } from '../src/agents/executionFailure.js';
import { processDockerResult } from '../src/agents/impl/utils/dockerResultProcessor.js';
import { parseStreamJsonOutput, UsageLimitError } from '../src/claude/claudeOutputParser.js';

const now = Date.parse('2026-09-25T12:00:00Z');
test('429 preserves Retry-After as an ISO reset time', () => {
    assert.deepEqual(classifyExecutionFailure({ error: { status: 429, headers: { 'Retry-After': '120' } }, now }),
        { failureKind: 'usage_limit', usageResetAt: '2026-09-25T12:02:00.000Z' });
});
test('HTTP date and provider reset headers are supported, invalid resets are absent', () => {
    for (const headers of [{ 'retry-after': 'Fri, 25 Sep 2026 12:02:00 GMT' },
        { 'anthropic-ratelimit-tokens-reset': '2026-09-25T12:02:00Z' }]) {
        assert.equal(classifyExecutionFailure({ error: { status: 429, headers }, now }).usageResetAt, '2026-09-25T12:02:00.000Z');
    }
    assert.deepEqual(classifyExecutionFailure({ error: { status: 429, headers: { 'retry-after': 'soon' } } }), { failureKind: 'usage_limit' });
});
test('529 and structured overloaded errors beat misleading text', () => {
    for (const error of [{ status: 529, message: 'quota' }, { error: { type: 'overloaded_error' } }]) {
        assert.deepEqual(classifyExecutionFailure({ error }), { failureKind: 'provider_error' });
    }
});
test('termination and infrastructure signals precede text; agent_error needs execution evidence', () => {
    for (const terminationReason of ['timeout', 'max_turns'] as const) {
        assert.deepEqual(classifyExecutionFailure({ terminationReason, error: 'overloaded' }), { failureKind: terminationReason });
    }
    assert.deepEqual(classifyExecutionFailure({ infrastructure: true, error: '429 from docker' }), { failureKind: 'infrastructure' });
    assert.deepEqual(classifyExecutionFailure({ error: 'failed' }), { failureKind: 'infrastructure' });
    assert.deepEqual(classifyExecutionFailure({ agentRan: true, error: 'could not solve task' }), { failureKind: 'agent_error' });
});
test('legacy text fallback classifies provider and usage failures without inventing resets', () => {
    assert.deepEqual(classifyExecutionFailure({ transportError: 'API Error: 529 {"error":{"type":"overloaded_error"}}' }), { failureKind: 'provider_error' });
    assert.deepEqual(classifyExecutionFailure({ transportError: 'Claude AI usage limit reached|1790337600' }), { failureKind: 'usage_limit' });
});
function docker(stdout: string, exitCode = 1, infrastructureFailure = false) {
    return { stdout, stderr: '', exitCode, messageTimestamps: new Map<string, string>(), infrastructureFailure };
}
test('Docker failures and structured CLI failures reach the agent response', () => {
    const neverStarted = processDockerResult(docker('', 125, true), 'task', 'claude', 1).response;
    assert.equal(neverStarted.failureKind, 'infrastructure');
    const failed = (extra: object) => processDockerResult(docker(JSON.stringify({ type: 'result', is_error: true, ...extra })), 'task', 'claude', 1).response;
    assert.equal(failed({ result: 'cannot implement' }).failureKind, 'agent_error');
    assert.equal(failed({ status: 529, error: { type: 'overloaded_error' } }).failureKind, 'provider_error');
    assert.equal(failed({ subtype: 'error_max_turns' }).failureKind, 'max_turns');
    assert.equal(failed({ status: 429, headers: { 'retry-after': 'Fri, 25 Sep 2026 12:02:00 GMT' } }).usageResetAt, '2026-09-25T12:02:00.000Z');
    assert.equal(processDockerResult({ ...docker(''), timedOut: true }, 'task', 'claude', 1).response.failureKind, 'timeout');
});
test('usage-limit requeue estimates are never represented as provider resets', () => {
    assert.throws(() => parseStreamJsonOutput(docker(JSON.stringify({ type: 'assistant', error: 'rate_limit' }))),
        (error: unknown) => error instanceof UsageLimitError && error.failureKind === 'usage_limit' && error.usageResetAt === undefined);
});

test('assistant rate-limit errors retain reported headers when requeued', () => {
    assert.throws(() => parseStreamJsonOutput(docker(JSON.stringify({ type: 'assistant', error: 'rate_limit',
        headers: { 'retry-after': 'Fri, 25 Sep 2026 12:02:00 GMT' } }))),
        (error: unknown) => error instanceof UsageLimitError && error.usageResetAt === '2026-09-25T12:02:00.000Z');
});

const agentFailureProse = [
    'The endpoint returns 503 and 429; could not implement the rate limit or quota handling.',
    'API Error: 503 {"error":{"type":"overloaded_error"}}',
    'API Error: 429 {"error":{"type":"rate_limit_error"}}',
    'overloaded_error',
    'Claude AI usage limit reached|1790337600',
    'maximum turns exceeded',
];
test('agent result prose cannot become transport or termination failures', () => {
    for (const result of agentFailureProse) {
        assert.equal(classifyExecutionFailure({ agentRan: true, error: result }).failureKind, 'agent_error');
        const output = docker(JSON.stringify({ type: 'result', is_error: true, result, num_turns: 1 }));
        assert.equal(parseStreamJsonOutput(output).failure?.failureKind, 'agent_error');
        assert.equal(processDockerResult(output, 'task', 'claude', 1).response.failureKind, 'agent_error');
    }
});
test('CLI stderr API errors retain provider and usage classifications', () => {
    for (const [stderr, expected] of [
        ['API Error: 503 {"error":{"type":"api_error"}}', 'provider_error'],
        ['API Error: 429 {"error":{"type":"rate_limit_error"}}', 'usage_limit'],
        ['overloaded_error', 'provider_error'],
    ]) {
        assert.equal(processDockerResult({ ...docker(''), stderr }, 'task', 'claude', 1).response.failureKind, expected);
    }
    assert.equal(classifyExecutionFailure({ agentRan: true, transportError: '503 429 rate limit quota' }).failureKind, 'agent_error');
});

test('legacy CLI usage diagnostics preserve their reported reset from stderr', () => {
    assert.throws(() => parseStreamJsonOutput({ ...docker(''), stderr: 'Claude AI usage limit reached|1790337600' }),
        (error: unknown) => error instanceof UsageLimitError && error.usageResetAt === '2026-09-25T12:00:00.000Z');
});

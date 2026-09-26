import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { processDockerResult } from '../packages/core/src/agents/impl/utils/dockerResultProcessor.js';
import { buildAgentOutcome, MAX_FINAL_OUTPUT_CHARACTERS } from '../src/jobs/executionOutcome.js';

// The agent module owns a Redis client at import; its conversions need none.
await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient: {} } });
const { agentResultToClaudeResponse, toClaudeResult, buildExecutionStateSummary } = await import('../src/jobs/issueJob/agent.js');

after(async () => { await closeConnection(); });

function assistant(id: string, text: string) {
    return JSON.stringify({ type: 'assistant', message: { id, model: 'claude-test', content: [{ type: 'text', text }] } });
}

function run(lines: string[], overrides: Record<string, unknown> = {}) {
    return { stdout: lines.join('\n'), stderr: '', exitCode: 1, messageTimestamps: new Map(), ...overrides };
}

test('a run stopped at the turn limit records the CLI turn count and its final output', () => {
    const { response } = processDockerResult(run([
        JSON.stringify({ type: 'system', session_id: 'session-1' }),
        assistant('m1', 'Reading the parser.'),
        assistant('m2', 'Parser done; edge-case tests remain.'),
        JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 250,
            session_id: 'session-1', total_cost_usd: 12.5, usage: { input_tokens: 10, output_tokens: 20 } }),
    ]), 'prompt', 'claude-test', 1000);

    assert.equal(response.success, false);
    assert.equal(response.terminationReason, 'max_turns');
    assert.equal(response.numTurns, 250);
    const claudeResult = agentResultToClaudeResponse(response);
    assert.equal(claudeResult.numTurns, 250);
    assert.equal(claudeResult.finalResult?.num_turns, 250);
    // LLM metrics read num_turns from finalResult; it was always 0 before.
    assert.equal(toClaudeResult(response).finalResult?.num_turns, 250);
    const outcome = buildAgentOutcome(claudeResult);
    assert.equal(outcome.numTurns, 250);
    assert.equal(outcome.failureClassification, 'max_turns');
    assert.equal(outcome.costUsd, 12.5);
    assert.equal(outcome.finalOutput, 'Parser done; edge-case tests remain.');
});

test('a run killed at its lease has no result line, so turns are counted from distinct assistant messages', () => {
    const { response } = processDockerResult(run([
        assistant('m1', 'Step one.'),
        assistant('m1', 'Step one, continued.'),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
        assistant('m2', 'Halfway through step two.'),
    ], { timedOut: true, exitCode: null }), 'prompt', 'claude-test', 1000);

    assert.equal(response.terminationReason, 'timeout');
    assert.equal(response.numTurns, 2);
    const outcome = buildAgentOutcome(agentResultToClaudeResponse(response));
    assert.equal(outcome.failureClassification, 'timeout');
    assert.equal(outcome.numTurns, 2);
    assert.equal(outcome.finalOutput, 'Halfway through step two.');
});

test('final output is redacted and bounded to the recovery checkpointText limit, keeping the latest text', () => {
    const summary = `ghp_${'a'.repeat(40)} ${'x'.repeat(MAX_FINAL_OUTPUT_CHARACTERS)}END`;
    const outcome = buildAgentOutcome({ success: false, executionTime: 1, output: null, logs: '', modifiedFiles: [],
        commitMessage: null, summary, error: 'failed' });
    assert.equal(outcome.finalOutput?.length, MAX_FINAL_OUTPUT_CHARACTERS);
    assert.ok(outcome.finalOutput?.endsWith('END'));
    assert.equal(outcome.failureClassification, 'agent_error');
    // No turn evidence: the count is unknown and absent, never a false 0.
    assert.equal(Object.hasOwn(outcome, 'numTurns'), false);
});

test('the claude_execution state records outcome evidence only for admitted executions', () => {
    const claudeResult = { success: false, executionTime: 5, output: null, logs: '', modifiedFiles: [], commitMessage: null,
        summary: 'Stopped mid-way.', error: 'timed out', failureKind: 'timeout' as const, terminationReason: 'timeout' as const, numTurns: 7, sessionId: 's', conversationId: 'c' };
    assert.deepEqual(buildExecutionStateSummary(claudeResult, false),
        { success: false, sessionId: 's', conversationId: 'c', executionTime: 5, failureKind: 'timeout',
            usageResetAt: undefined, terminationReason: 'timeout', error: 'timed out' });
    assert.deepEqual(JSON.parse(JSON.stringify(buildExecutionStateSummary(claudeResult, true))), {
        success: false, sessionId: 's', conversationId: 'c', executionTime: 5, failureKind: 'timeout', terminationReason: 'timeout',
        numTurns: 7, finalOutput: 'Stopped mid-way.', error: 'timed out' });
});

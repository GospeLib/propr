import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExecutionFailure } from '../packages/core/src/agents/executionFailure.js';
await mock.module('@propr/core', { namedExports: {
    classifyExecutionFailure,
    ClaudeResultPhases: { PROVISIONAL: 'provisional', FINAL: 'final' },
    TaskStates: { CLAUDE_EXECUTION: 'claude_execution' },
} });
const { finalClaudeExecutionResult, provisionalClaudeExecutionResult, recordFinalClaudeExecutionResult } = await import('../src/jobs/claudeExecutionResult.js');
test('provisional and successful results carry no failure metadata', () => {
    assert.equal('failureKind' in provisionalClaudeExecutionResult('session'), false);
    assert.equal('usageResetAt' in provisionalClaudeExecutionResult('session'), false);
    const success = finalClaudeExecutionResult({ success: true, failureKind: 'usage_limit', usageResetAt: '2026-09-25T12:00:00Z' });
    assert.equal('failureKind' in success, false);
    assert.equal('usageResetAt' in success, false);
});
test('all failed finals are classified and persistence keeps the same cause', async () => {
    const writes: unknown[] = [];
    const summary = await recordFinalClaudeExecutionResult({ updateHistoryMetadata: async (_id, _state, metadata) => { writes.push(metadata); } }, 'task',
        { success: false, failureKind: 'usage_limit', usageResetAt: '2026-09-25T12:00:00Z' });
    assert.deepEqual(writes, [{ claudeResult: summary }]);
    assert.equal(summary.failureKind, 'usage_limit');
    assert.equal(summary.usageResetAt, '2026-09-25T12:00:00.000Z');
    assert.equal(finalClaudeExecutionResult({ success: false }).failureKind, 'infrastructure');
    assert.equal(finalClaudeExecutionResult({ success: false, sessionId: 'ran' }).failureKind, 'agent_error');
    assert.deepEqual(finalClaudeExecutionResult({ success: false, terminationReason: 'timeout', failureKind: 'usage_limit', usageResetAt: '2026-09-25T12:00:00Z' }),
        { success: false, terminationReason: 'timeout', resultPhase: 'final', failureKind: 'timeout' });
});

test('final summary error prose never supplies a transport classification', () => {
    for (const error of ['The endpoint returns 503 and 429; rate limit implementation failed.',
        'API Error: 503 {"error":{"type":"overloaded_error"}}',
        'API Error: 429 {"error":{"type":"rate_limit_error"}}', 'overloaded_error']) {
        assert.equal(finalClaudeExecutionResult({ success: false, sessionId: 'ran', error }).failureKind, 'agent_error');
    }
});

import { test, describe, after } from 'node:test';
import assert from 'node:assert';

process.env.NODE_ENV = 'test';

import { resolveAnalysisOutcome } from '../packages/core/src/agents/impl/ClaudeAgent.js';
import type { ClaudeOutput } from '../packages/core/src/claude/claudeHelpers.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

/**
 * Regression tests for resolveAnalysisOutcome.
 *
 * Background: a Claude agent result line flagged with is_error (e.g. an API 400
 * "Prompt is too long") still carries text in `result`. That text must NOT be
 * treated as a successful analysis, otherwise downstream summarization JSON parsing
 * silently rejects it as a generic "No valid summaries parsed" error and the
 * retry/fallback/cooldown logic never sees the real failure.
 */
function buildOutput(overrides: Partial<ClaudeOutput>): ClaudeOutput {
  return {
    success: true,
    rawOutput: '',
    error: '',
    conversationLog: [],
    sessionId: null,
    finalResult: null,
    ...overrides
  } as ClaudeOutput;
}

describe('resolveAnalysisOutcome', () => {
  test('closed planning results reject API authentication, missing init and configured MCP', () => {
    for (const init of [undefined,
      { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', mcp_servers: [] },
      { type: 'system', subtype: 'init', apiKeySource: 'apiKeyHelper', mcp_servers: [] },
      { type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [{ name: 'credential-holder' }] }]) {
      const output = buildOutput({ rawOutput: init ? JSON.stringify(init) : '',
        finalResult: { type: 'result', is_error: false, result: '{}' } });
      assert.strictEqual((resolveAnalysisOutcome as any)(output, '', true).isSuccess, false);
    }
  });
  test('closed authenticated Max init uses observed apiKeySource none, not invented OAuth enum', () => {
    const output = buildOutput({ rawOutput: JSON.stringify({ type: 'system', subtype: 'init',
      apiKeySource: 'none', mcp_servers: [] }), finalResult: { type: 'result', is_error: false, result: '{}' } });
    assert.strictEqual((resolveAnalysisOutcome as any)(output, '', true).isSuccess, true);
  });
  after(async () => {
    await closeConnection();
  });

  test('treats an is_error result as a failure even when result text is present', () => {
    const output = buildOutput({
      success: false,
      finalResult: {
        type: 'result',
        is_error: true,
        result: 'Prompt is too long · the request is ~216519 tokens (limit 200000)'
      }
    });

    const outcome = resolveAnalysisOutcome(output, '');
    assert.strictEqual(outcome.isSuccess, false);
    assert.ok(!outcome.isSuccess && outcome.errorDetail.includes('Prompt is too long'));
  });

  test('treats a normal result with text as success', () => {
    const output = buildOutput({
      success: true,
      finalResult: { type: 'result', is_error: false, result: '{"summaries":[]}' }
    });

    assert.strictEqual(resolveAnalysisOutcome(output, '').isSuccess, true);
  });

  test('succeeds on the success flag even without a result string', () => {
    const output = buildOutput({ success: true, finalResult: { type: 'result' } });
    assert.strictEqual(resolveAnalysisOutcome(output, '').isSuccess, true);
  });

  test('falls back to stderr when there is no result and no success', () => {
    const output = buildOutput({ success: false, finalResult: null });
    const outcome = resolveAnalysisOutcome(output, 'docker exploded');
    assert.strictEqual(outcome.isSuccess, false);
    assert.ok(!outcome.isSuccess && outcome.errorDetail === 'docker exploded');
  });

  test('uses a default error message when stderr is empty', () => {
    const output = buildOutput({ success: false, finalResult: null });
    const outcome = resolveAnalysisOutcome(output, '');
    assert.ok(!outcome.isSuccess && outcome.errorDetail === 'No result returned');
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLlmMetricsPayload } from '@propr/core';

// claudeService.ts:272 used to report conversation-log length as num_turns, which
// counts every streamed event (system/tool/user/assistant), not model turns.
test('buildLlmMetricsPayload reports distinct assistant messages, not conversation-log length', () => {
    const conversationLog = [
        { type: 'system' },
        { type: 'assistant', message: { id: 'm1' } },
        { type: 'user' },
        { type: 'assistant', message: { id: 'm1' } }, // same streamed message, not a second turn
        { type: 'assistant', message: { id: 'm2' } },
    ];
    const payload = buildLlmMetricsPayload({
        success: true,
        executionTime: 10,
        model: 'claude-test',
        finalResult: { subtype: 'success' } as never,
        conversationLog: conversationLog as never,
        modifiedFiles: [],
        commitMessage: null,
        summary: null,
    } as never, 'fallback-model');

    // 5 events, but only 2 distinct assistant messages.
    assert.equal(payload.finalResult?.num_turns, 2);
});

test('buildLlmMetricsPayload never fabricates 0 turns when there is no conversation-log evidence', () => {
    const payload = buildLlmMetricsPayload({
        success: true,
        executionTime: 10,
        model: 'claude-test',
        finalResult: { subtype: 'success' } as never,
        conversationLog: [],
        modifiedFiles: [],
        commitMessage: null,
        summary: null,
    } as never, 'fallback-model');

    assert.equal(payload.finalResult?.num_turns, undefined);
});

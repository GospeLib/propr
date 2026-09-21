import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { countAgentTurns } from '../packages/core/src/agents/turnCount.js';
import { parseCodexStreamOutput } from '../packages/core/src/codex/codexHelpers.js';
import { parseOpenCodeJsonl } from '../packages/core/src/agents/impl/openCodeParsing.js';
import { parseVibeConversationLog } from '../packages/core/src/agents/impl/utils/vibeOutputParser.js';
import { parseAntigravityJsonl } from '../packages/core/src/agents/impl/utils/antigravityOutputParser.js';
import { CodexAgent } from '../packages/core/src/agents/impl/CodexAgent.js';
import { buildAgentOutcome } from '../src/jobs/executionOutcome.js';

await mock.module('../src/jobs/issueJob/config.js', { namedExports: { redisClient: {} } });
const { agentResultToClaudeResponse } = await import('../src/jobs/issueJob/agent.js');

after(async () => { await closeConnection(); });

const jsonl = (events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n');

test('codex: turns come from its own turn events, and a turn killed mid-way still counts', () => {
  const stdout = jsonl([
    { type: 'thread.started', thread_id: 't-1' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } },
  ]);
  assert.equal(countAgentTurns('codex', { events: parseCodexStreamOutput(stdout).conversationLog }), 2);
  assert.equal(countAgentTurns('codex', { events: parseCodexStreamOutput(jsonl([{ type: 'thread.started', thread_id: 't' }])).conversationLog }), 0);
  assert.equal(countAgentTurns('codex', { events: parseCodexStreamOutput('').conversationLog }), undefined);
});

test('codex adapter: a stopped execution result carries the truthful turn count, or none when there is no stream', () => {
  const agent = new CodexAgent({ id: 'fixture', alias: 'fixture', type: 'codex', enabled: true, dockerImage: 'fixture', supportedModels: [] });
  const build = (stdout: string) => (agent as unknown as { buildTaskExecutionResult(params: unknown): { numTurns?: number } })
    .buildTaskExecutionResult({
      parsedOutput: parseCodexStreamOutput(stdout), effectiveReasoningLevel: '', executionTime: 10, prompt: 'p', usageMetrics: null,
      result: { stdout, stderr: 'Command timed out after 10ms', exitCode: null, timedOut: true, messageTimestamps: new Map() },
    });
  assert.equal(build(jsonl([{ type: 'turn.started' }, { type: 'turn.completed' }, { type: 'turn.started' }])).numTurns, 2);
  assert.equal(build('').numTurns, undefined);
});

test('opencode: one model call per step, counting a step cut off before it finished', () => {
  const stdout = jsonl([
    { type: 'step_start', sessionID: 's', part: { type: 'step-start' } },
    { type: 'text', sessionID: 's', part: { type: 'text', text: 'Reading.' } },
    { type: 'step_finish', sessionID: 's', part: { type: 'step-finish', tokens: { input: 1, output: 1 } } },
    { type: 'step_start', sessionID: 's', part: { type: 'step-start' } },
    { type: 'tool_use', sessionID: 's', part: { type: 'tool', tool: 'bash' } },
  ]);
  assert.equal(countAgentTurns('opencode', { events: parseOpenCodeJsonl(stdout).conversationLog }), 2);
  assert.equal(countAgentTurns('opencode', { events: parseOpenCodeJsonl('').conversationLog }), undefined);
});

test('vibe: distinct assistant messages, from stdout or the session log of a killed run', () => {
  const messages = jsonl([
    { role: 'user', content: 'Do the task.' },
    { role: 'assistant', content: 'Looking.', message_id: 'a1', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file' },
    { role: 'assistant', content: 'Editing.', message_id: 'a2' },
    { role: 'assistant', content: 'Editing, continued.', message_id: 'a2' },
  ]);
  assert.equal(countAgentTurns('vibe', { events: parseVibeConversationLog(messages) }), 2);
  assert.equal(countAgentTurns('vibe', { events: parseVibeConversationLog('') }), undefined);
});

test('antigravity: the CLI-reported num_turns, else unknown rather than a guessed 0', () => {
  const init = { event: 'init', conversation_id: 'c-1', init: { model: 'gemini-3-pro' } };
  const step = { event: 'step_update', step_update: { conversation_id: 'c-1', step_index: 0, state: 'DONE', step_type: 'AGENT_RESPONSE', text_delta: 'Hi' } };
  const finished = parseAntigravityJsonl(jsonl([init, step,
    { event: 'result', result: { conversation_id: 'c-1', status: 'ERROR', num_turns: 14 } }]));
  assert.equal(countAgentTurns('antigravity', { events: finished.conversationLog }), 14);
  const killed = parseAntigravityJsonl(jsonl([init, step]));
  assert.equal(countAgentTurns('antigravity', { events: killed.conversationLog }), undefined);
});

test('claude: the result line wins; otherwise distinct assistant messages; no stream is unknown', () => {
  const log = [{ type: 'assistant', message: { id: 'm1' } }, { type: 'assistant', message: { id: 'm1' } }, { type: 'user' }];
  assert.equal(countAgentTurns('claude', { reportedTurns: 250, events: log }), 250);
  assert.equal(countAgentTurns('claude', { events: log }), 1);
  assert.equal(countAgentTurns('claude', { events: [] }), undefined);
});

test('an unknown turn count reaches the recorded outcome as absent, never as 0', () => {
  const stopped = { success: false, executionTimeMs: 5, logs: '', modifiedFiles: [], commitMessage: null, error: 'timed out',
    terminationReason: 'timeout' as const };
  const unknown = buildAgentOutcome(agentResultToClaudeResponse(stopped));
  assert.equal(Object.hasOwn(unknown, 'numTurns'), false);
  const counted = buildAgentOutcome(agentResultToClaudeResponse({ ...stopped, numTurns: 3 }));
  assert.equal(counted.numTurns, 3);
  assert.equal(buildAgentOutcome(agentResultToClaudeResponse({ ...stopped, numTurns: 0 })).numTurns, 0);
});

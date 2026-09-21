import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { parseStreamJsonOutput } from '../packages/core/src/claude/claudeHelpers.js';
import { getClaudeAnalysisText } from '../packages/core/src/agents/impl/utils/index.js';
import { closeConnection } from '@propr/core';

const SESSION = 'structured-continuation-session';
const PREFIX = '{"text":"a complete ';
const SUFFIX = 'structured answer","stories":[]}';
const COMPLETE = PREFIX + SUFFIX;
const message = (id: string, text: string) => ({ type: 'assistant', session_id: SESSION,
  parent_tool_use_id: null, request_id: `request-${id}`, uuid: `event-${id}`,
  message: { id, content: [{ type: 'text', text }] } });
const result = () => ({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION,
  num_turns: 1, terminal_reason: 'completed', stop_reason: 'end_turn', result: SUFFIX });
function select(events: unknown[], format: 'text' | 'json' = 'json') {
  return selectLines(events.map(event => JSON.stringify(event)).join('\n'), format);
}
function selectLines(stdout: string, format: 'text' | 'json' = 'json') {
  const parsed = parseStreamJsonOutput({ stdout,
    stderr: '', exitCode: 0, messageTimestamps: new Map() });
  return getClaudeAnalysisText(parsed, format);
}
const stream = () => [message('first', PREFIX), message('second', SUFFIX), result()];
after(closeConnection);

for (const scenario of ['valid schema tool delivery', 'missing structured result', 'null structured result', 'array result', 'failed result', 'incomplete terminal', 'damaged stream', 'max tokens', 'refusal']) {
  test(`native schema delivery is authoritative only when complete: ${scenario}`, () => {
    const document = { artifacts: [], questions: [] }, schema = { type: 'object' };
    const final: any = { ...result(), stop_reason: 'tool_use', result: 'not the structured document', structured_output: document };
    if (scenario === 'missing structured result') delete final.structured_output;
    if (scenario === 'null structured result') final.structured_output = null;
    if (scenario === 'array result') final.structured_output = [];
    if (scenario === 'failed result') final.is_error = true;
    if (scenario === 'incomplete terminal') delete final.terminal_reason;
    if (scenario === 'max tokens') final.stop_reason = 'max_tokens';
    if (scenario === 'refusal') final.stop_reason = 'refusal';
    const stdout = [JSON.stringify(message('first', '{"not":"authoritative"}')),
      ...(scenario === 'damaged stream' ? ['{"malformed'] : []), JSON.stringify(final)].join('\n');
    const parsed = parseStreamJsonOutput({ stdout, stderr: '', exitCode: 0, messageTimestamps: new Map() });
    if (scenario === 'valid schema tool delivery') assert.equal(getClaudeAnalysisText(parsed, 'json', schema), JSON.stringify(document));
    else assert.throws(() => getClaudeAnalysisText(parsed, 'json', schema), /structured output unavailable or incomplete/);
    assert.equal(getClaudeAnalysisText(parsed, 'text'), final.result, 'legacy text semantics remain independent');
  });
}

test('completed single-turn Claude auto-continuation preserves the complete exact JSON document', () => {
  assert.equal(select(stream()), COMPLETE);
  assert.deepEqual(JSON.parse(select(stream())), { text: 'a complete structured answer', stories: [] });
});
test('thinking-only message events are not output and do not duplicate an assistant message', () => {
  const thinking = { ...message('first', ''), message: { id: 'first', content: [{ type: 'thinking' }] } };
  assert.equal(select([thinking, ...stream()]), COMPLETE);
});
test('ordinary text analysis retains the CLI final-result semantics', () => {
  assert.equal(select(stream(), 'text'), SUFFIX);
});
test('an independently valid final JSON result wins over prior assistant text', () => {
  const final = { ...result(), result: '{"current":true}' };
  assert.equal(select([message('first', '{"obsolete":true}'), final]), final.result);
});
test('three segments preserve exact whitespace inside a JSON string', () => {
  const pieces = ['{"text":"left ', ' middle ', ' right","stories":[]}'];
  const events = pieces.map((text, index) => message(`part-${index}`, text));
  assert.equal(select([...events, { ...result(), result: pieces.at(-1) }]), pieces.join(''));
});
test('plain setup prelude before the CLI stream is compatible with reconstruction', () => {
  const raw = ['Skipping firewall setup', ...stream().map(event => JSON.stringify(event))].join('\n');
  assert.equal(selectLines(raw), COMPLETE);
});
for (const damaged of ['{"type":"assistant","message":', 'missing-frame-prefix']) {
  test(`malformed middle stream line cannot silently delete text: ${damaged}`, () => {
    const raw = [JSON.stringify(message('first', PREFIX)), damaged,
      JSON.stringify(message('second', SUFFIX)), JSON.stringify(result())].join('\n');
    assert.equal(selectLines(raw), SUFFIX);
    assert.equal(selectLines(raw, 'text'), SUFFIX, 'ordinary text compatibility');
  });
}
for (const scenario of ['foreign session', 'foreign terminal session', 'user turn', 'tool use', 'nested agent',
  'multiple turns', 'failed result', 'missing completion', 'different final suffix', 'duplicate text event',
  'missing message identity', 'malformed full JSON', 'max-token stop', 'non-success subtype', 'redacted thinking']) {
  test(`structured continuation refuses ${scenario} without manufacturing a document`, () => {
    const events: any[] = stream();
    if (scenario === 'foreign session') events[0].session_id = 'other-session';
    if (scenario === 'foreign terminal session') events[2].session_id = 'other-session';
    if (scenario === 'user turn') events.splice(1, 0, { type: 'user', session_id: SESSION, message: { content: 'continue' } });
    if (scenario === 'tool use') events[0].message.content.push({ type: 'tool_use', name: 'Read' });
    if (scenario === 'nested agent') events[0].parent_tool_use_id = 'tool-parent';
    if (scenario === 'multiple turns') events[2].num_turns = 2;
    if (scenario === 'failed result') events[2].is_error = true;
    if (scenario === 'missing completion') delete events[2].terminal_reason;
    if (scenario === 'different final suffix') events[2].result = 'different continuation';
    if (scenario === 'duplicate text event') events.splice(1, 0, events[0]);
    if (scenario === 'missing message identity') delete events[0].message.id;
    if (scenario === 'malformed full JSON') events[0].message.content[0].text = 'not JSON';
    if (scenario === 'max-token stop') events[2].stop_reason = 'max_tokens';
    if (scenario === 'non-success subtype') events[2].subtype = 'error_max_turns';
    if (scenario === 'redacted thinking') events[0].message.content.push({ type: 'redacted_thinking' });
    assert.equal(select(events), events.at(-1).result);
  });
}

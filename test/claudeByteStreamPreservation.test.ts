import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeConnection, executeDockerCommand } from '@propr/core';
import { parseStreamJsonOutput } from '../packages/core/src/claude/claudeHelpers.js';
import { getClaudeAnalysisText } from '../packages/core/src/agents/impl/utils/index.js';

const WRITE_DELAY_MS = 15;
const SESSION = 'byte-stream-session';
const MULTIBYTE_TEXT = 'é€🙂';
const STDERR_TEXT = `diagnostic ${MULTIBYTE_TEXT}`;
const PARTS = ['{"text":"', MULTIBYTE_TEXT, '","stories":[]}'];
const DOCUMENT = PARTS.join('');
const EVENTS = PARTS.map((text, index) => ({ type: 'assistant', session_id: SESSION,
  parent_tool_use_id: null, message: { id: `segment-${index}`, content: [{ type: 'text', text }] } }));
const RESULT = { type: 'result', subtype: 'success', is_error: false, session_id: SESSION,
  num_turns: 1, terminal_reason: 'completed', stop_reason: 'end_turn', result: PARTS.at(-1) };
after(closeConnection);

function writeScript(stdout: Buffer[], stderr: Buffer[] = []) {
  const writes = [...stdout.map(bytes => ({ stream: 'stdout', bytes: [...bytes] })),
    ...stderr.map(bytes => ({ stream: 'stderr', bytes: [...bytes] }))];
  return `const writes = ${JSON.stringify(writes)};
    async function emit() { for (const entry of writes) {
      await new Promise(resolve => process[entry.stream].write(Buffer.from(entry.bytes), resolve));
      await new Promise(resolve => setTimeout(resolve, ${WRITE_DELAY_MS}));
    } } emit();`;
}
function splitMultibyte(text: string): Buffer[] {
  return Array.from(text).flatMap(character => {
    const bytes = Buffer.from(character);
    return bytes.length > 1 ? [...bytes].map(byte => Buffer.from([byte])) : [bytes];
  });
}

test('real child stdout and stderr preserve every split two-, three-, and four-byte UTF-8 character', async () => {
  let terminal: { stdout: string; stderr: string; child: { pid: number }; childStopped: boolean } | undefined;
  const result = await executeDockerCommand(process.execPath,
    ['-e', writeScript(splitMultibyte(MULTIBYTE_TEXT), splitMultibyte(STDERR_TEXT))],
    { onTerminal(value) { terminal = value; } });
  assert.equal(result.stdout, MULTIBYTE_TEXT);
  assert.equal(result.stderr, STDERR_TEXT);
  assert.equal(terminal?.stdout, MULTIBYTE_TEXT);
  assert.equal(terminal?.stderr, STDERR_TEXT);
  assert.equal(terminal?.childStopped, true);
  assert.throws(() => process.kill(terminal!.child.pid, 0), /ESRCH/);
});

test('split JSON records produce one session callback and all message timestamps, including EOF without newline', async () => {
  const sessions: string[] = [];
  const stdout = EVENTS.map(event => JSON.stringify(event)).join('\n');
  const result = await executeDockerCommand(process.execPath,
    ['-e', writeScript(splitMultibyte(stdout))],
    { onSessionId(session) { sessions.push(session); } });
  assert.deepEqual(sessions, [SESSION]);
  assert.deepEqual([...result.messageTimestamps.keys()], EVENTS.map(event => event.message.id));
  assert.equal(result.stdout, stdout);
});

test('real child bytes through parser and selector preserve exact three-segment JSON, never a valid corrupted document', async () => {
  const stdout = [...EVENTS, RESULT].map(event => JSON.stringify(event)).join('\n');
  const chunks = stdout.split(MULTIBYTE_TEXT);
  const bytes = [Buffer.from(chunks[0]), ...splitMultibyte(MULTIBYTE_TEXT), Buffer.from(chunks[1])];
  const result = await executeDockerCommand(process.execPath, ['-e', writeScript(bytes)]);
  const selected = getClaudeAnalysisText(parseStreamJsonOutput(result), 'json');
  assert.equal(selected, DOCUMENT);
  assert.deepEqual(JSON.parse(selected), { text: MULTIBYTE_TEXT, stories: [] });
});

test('batched CRLF records and final EOF preserve exact output and wait for the sole session callback', async () => {
  const stdout = [...EVENTS, RESULT].map(event => JSON.stringify(event)).join('\r\n');
  const sessions: string[] = [];
  let terminalObserved = false;
  await executeDockerCommand(process.execPath, ['-e', writeScript([Buffer.from(stdout)])], {
    async onSessionId(session) {
      await new Promise(resolve => setTimeout(resolve, WRITE_DELAY_MS));
      sessions.push(session);
    },
    onTerminal(terminal) {
      assert.deepEqual(sessions, [SESSION]);
      assert.equal(terminal.stdout, stdout);
      assert.equal(terminal.messageTimestamps.size, EVENTS.length);
      terminalObserved = true;
    },
  });
  assert.equal(terminalObserved, true);
});

test('a malformed middle record stays retained and cannot become a silently shortened valid document', async () => {
  const stdout = [JSON.stringify(EVENTS[0]), '{"type":"assistant",',
    JSON.stringify(EVENTS[2]), JSON.stringify(RESULT)].join('\n');
  const result = await executeDockerCommand(process.execPath, ['-e', writeScript([Buffer.from(stdout)])]);
  const parsed = parseStreamJsonOutput(result);
  assert.equal(result.stdout, stdout);
  assert.equal(parsed.streamParseComplete, false);
  assert.equal(getClaudeAnalysisText(parsed, 'json'), RESULT.result);
});

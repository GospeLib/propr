import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
const SESSION = 'analysis-continuation-session';
const PREFIX = '{"text":"complete ';
const SUFFIX = 'answer","stories":[]}';
const assistant = (id: string, text: string) => ({ type: 'assistant', session_id: SESSION,
  parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } });
let events = [
  { type: 'system', subtype: 'init', session_id: SESSION, apiKeySource: 'none', mcp_servers: [] },
  assistant('first', PREFIX), assistant('second', SUFFIX),
  { type: 'result', subtype: 'success', session_id: SESSION, is_error: false, num_turns: 1,
    terminal_reason: 'completed', stop_reason: 'end_turn', result: SUFFIX },
];
let calls = 0;
await mock.module('../packages/core/src/agents/impl/utils/usageTrackingWrapper.js', { namedExports: {
  executeWithUsageTracking: async () => {
    calls += 1;
    return { result: { stdout: events.map(value => JSON.stringify(value)).join('\n'), stderr: '',
      exitCode: 0, messageTimestamps: new Map() }, usageMetrics: null };
  },
  extractMetricRecords: () => [], isAgentTankEnabled: async () => false,
  humanizeMetricKey: (key: string) => key,
} });
const { ClaudeAgent } = await import('../packages/core/src/agents/impl/ClaudeAgent.js');
after(async () => {
  const { closeConnection } = await import('../packages/core/src/db/connection.js'); await closeConnection();
  const built = await import('@propr/core'); await built.closeConnection();
});

test('actual ClaudeAgent structured-analysis caller returns all single-turn JSON segments without another execution', async () => {
  const agent = new ClaudeAgent({ id: 'fixture', alias: 'fixture', type: 'claude', enabled: true,
    dockerImage: 'fixture-image', configPath: '/tmp/continuation-fixture', supportedModels: [], defaultModel: 'sonnet' });
  mock.method(agent as unknown as { resolveEffectiveReasoningLevel(): Promise<string> },
    'resolveEffectiveReasoningLevel', async () => '');
  const response = await agent.analyze('Return the requested JSON envelope.', {
    analysisProfile: 'planning-artifact', responseFormat: 'json', suppressLlmLog: true,
  });
  assert.equal(response.success, true);
  assert.equal(response.response, PREFIX + SUFFIX);
  assert.equal(response.sessionId, SESSION);
  assert.equal(calls, 1);
});

test('actual ClaudeAgent returns schema-delivered artifacts without double encoding and retains CLI schema input', async () => {
  const schema = { type: 'object', required: ['artifacts', 'questions'], properties: {
    artifacts: { type: 'array', items: { type: 'object' } }, questions: { type: 'array', items: { type: 'object' } },
  } };
  const document = { artifacts: [{ artifact: 'test-cases', files: { 'test-cases.md': 'quote " here; é€🙂' } }], questions: [] };
  events = [events[0], { type: 'result', subtype: 'success', session_id: SESSION, is_error: false,
    num_turns: 1, terminal_reason: 'completed', stop_reason: 'tool_use', result: '', structured_output: document } as any];
  const agent = new ClaudeAgent({ id: 'fixture', alias: 'fixture', type: 'claude', enabled: true,
    dockerImage: 'fixture-image', configPath: '/tmp/continuation-fixture', supportedModels: [], defaultModel: 'sonnet' });
  mock.method(agent as unknown as { resolveEffectiveReasoningLevel(): Promise<string> },
    'resolveEffectiveReasoningLevel', async () => '');
  let input: unknown;
  const response = await agent.analyze('Return the requested artifact object.', {
    analysisProfile: 'planning-artifact', responseFormat: 'json', responseSchema: schema, suppressLlmLog: true,
    executionCallbacks: { onInputPrepared: async value => { input = value; } },
  } as any);
  assert.equal(response.success, true);
  assert.equal(response.response, JSON.stringify(document));
  assert.deepEqual((input as any).responseSchema, schema);
});

test('actual schema -> native ClaudeAgent -> API -> Ezer preserves artifacts and rejects schema substitution before execution',
  { skip: !process.env.EZER_PLANNING_SOURCE_ROOT }, async () => {
    const source = process.env.EZER_PLANNING_SOURCE_ROOT!;
    const { createProprAgentProvider, planningResponseSchemaDigest } = await import(pathToFileURL(join(source, 'services/ezer/src/conversation/index.ts')).href);
    const { PLANNING_AUTHOR_RESPONSE_SCHEMA: schema, decodePlanningAuthorArtifacts } = await import(pathToFileURL(join(source, 'services/ezer/src/planning/author-schema.ts')).href);
    const { planningAuthorRequest } = await import(pathToFileURL(join(source, 'services/ezer/src/planning/author-request.ts')).href);
    const { createAgentRoutes } = await import('../packages/api/routes/index.js');
    const { getAgentRegistry } = await import('@propr/core');
    const artifactKinds = schema.properties.artifacts.items.anyOf.map((item: any) => item.properties.artifact.const);
    const document = { artifacts: artifactKinds.map((artifact: string) => ({
      artifact, files: [{ path: artifact === 'stories' ? 'stories/S01.md' : `${artifact}.md`, content: '# quote " and é€🙂' }],
    })), questions: [] };
    events = [events[0], { type: 'assistant', session_id: SESSION, parent_tool_use_id: null,
      message: { id: 'structured-message', content: [{ type: 'tool_use', id: 'structured-tool', name: 'StructuredOutput', input: document }] } } as any,
    { type: 'user', session_id: SESSION, parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'structured-tool', content: 'Structured output provided successfully' }] } } as any,
    { type: 'result', subtype: 'success', session_id: SESSION, is_error: false,
      num_turns: 1, terminal_reason: 'completed', stop_reason: 'tool_use', result: '', structured_output: document } as any];
    const agent = new ClaudeAgent({ id: 'fixture', alias: 'fixture', type: 'claude', enabled: true,
      dockerImage: 'fixture-image', configPath: '/tmp/continuation-fixture', supportedModels: [], defaultModel: 'sonnet' });
    mock.method(agent as unknown as { resolveEffectiveReasoningLevel(): Promise<string> },
      'resolveEffectiveReasoningLevel', async () => '');
    const registry = getAgentRegistry(), originalInitialize = registry.ensureInitialized, originalGet = registry.getAgentById;
    registry.ensureInitialized = async () => undefined;
    registry.getAgentById = () => agent;
    const checkpoints: Record<string, any>[] = [];
    const routes = createAgentRoutes({ stateManager: {
      async createTaskState() {}, async updateTaskState() {},
      async updateHistoryMetadata(_task, _state, metadata) { checkpoints.push(metadata); },
    } });
    const handler = routes.router.stack.find(layer => layer.route?.path === '/chat')!.route!.stack[0].handle;
    let scenario = 'matching', publication: any;
    const provider = createProprAgentProvider({ baseUrl: 'http://native.fixture', agentId: 'fixture', internalSecret: 'fixture',
      fetchImpl: async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (scenario === 'omitted') delete body.queries[0].responseSchema;
        if (scenario === 'foreign') body.queries[0].responseSchema = { type: 'object' };
        const req = Object.assign(new EventEmitter(), { body });
        const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
          status() { return res; }, json(value: unknown) { publication = value; } });
        await handler(req as never, res as never, () => undefined);
        return new Response(JSON.stringify(publication));
      },
    });
    try {
      const request = planningAuthorRequest('Return artifacts directly', 'Exact original input', 'operation', 'fixture/planning', schema);
      const before = calls, result = await provider.respond(request);
      assert.deepEqual(JSON.parse(result.text), document);
      assert.equal(decodePlanningAuthorArtifacts(JSON.parse(result.text).artifacts).length, artifactKinds.length);
      assert.deepEqual(checkpoints.find(value => value.providerCliInput)?.providerCliInput.responseSchema, schema);
      assert.equal(result.execution.responseSchemaDigest, planningResponseSchemaDigest(request));
      assert.equal(calls, before + 1);
      for (scenario of ['omitted', 'foreign']) await assert.rejects(provider.respond(request), /response schema binding/);
      assert.equal(calls, before + 1, 'schema substitution never starts another paid execution');
    } finally { registry.ensureInitialized = originalInitialize; registry.getAgentById = originalGet; }
  });

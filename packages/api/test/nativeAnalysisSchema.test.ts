import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { closeConnection, type Agent, type AnalyzeOptions } from '@propr/core';
import { nativeAnalysis, type NativeAnalysisBinding } from '../routes/nativeAnalysis.js';

const PROMPT = 'exact original planning input';
const SCHEMA = { type: 'object', additionalProperties: false, required: ['artifacts'],
  properties: { artifacts: { type: 'array', items: { type: 'string' } } } };
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const binding = () => ({ requestId: 'request', operationId: 'operation', repository: 'fixture/planning',
  inputDigest: digest('logical input'), providerInputDigest: digest(PROMPT), responseSchemaDigest: digest(JSON.stringify(SCHEMA)) });
after(closeConnection);

for (const scenario of ['missing digest', 'foreign digest', 'missing schema', 'malformed schema']) {
  test(`native schema admission refuses ${scenario} before creating task or calling author`, async () => {
    let admitted = false, authored = false;
    const execution: NativeAnalysisBinding = binding();
    let responseSchema: unknown = SCHEMA;
    if (scenario === 'missing digest') delete execution.responseSchemaDigest;
    if (scenario === 'foreign digest') execution.responseSchemaDigest = digest('foreign');
    if (scenario === 'missing schema') responseSchema = undefined;
    if (scenario === 'malformed schema') responseSchema = [];
    await assert.rejects(nativeAnalysis({ config: { type: 'claude' }, async analyze() { authored = true; } } as unknown as Agent,
      PROMPT, { options: { analysisProfile: 'planning-artifact', responseSchema: responseSchema as AnalyzeOptions['responseSchema'] }, binding: execution,
        signal: new AbortController().signal, dependencies: { stateManager: {
          async createTaskState() { admitted = true; }, async updateTaskState() {}, async updateHistoryMetadata() {},
        } } }), /response schema/);
    assert.equal(admitted, false);
    assert.equal(authored, false);
  });
}

for (const scenario of ['matching', 'omitted CLI schema', 'changed CLI schema', 'missing input checkpoint']) {
  test(`schema receipt derives from the persisted actual CLI input: ${scenario}`, async () => {
    const checkpoints: Record<string, unknown>[] = [];
    const agent = { config: { type: 'claude', id: 'fixture', alias: 'fixture' },
      async analyze(prompt: string, options: AnalyzeOptions) {
        if (scenario !== 'missing input checkpoint') await options.executionCallbacks!.onInputPrepared!({ prompt, systemPrompt: 'fixture',
          ...(scenario === 'omitted CLI schema' ? {} : { responseSchema: scenario === 'changed CLI schema' ? { type: 'object' } : SCHEMA }) });
        return { success: true, response: '{"artifacts":[]}', modelUsed: 'fixture' };
      },
    } as unknown as Agent;
    const pending = nativeAnalysis(agent, PROMPT, { options: { analysisProfile: 'planning-artifact', responseSchema: SCHEMA },
      binding: binding(), signal: new AbortController().signal, dependencies: { stateManager: {
        async createTaskState() {}, async updateTaskState() {},
        async updateHistoryMetadata(_task, _state, metadata) { checkpoints.push(metadata); },
      } } });
    if (scenario.includes('CLI schema')) await assert.rejects(pending, /CLI response schema binding changed/);
    else {
      const result = await pending;
      assert.equal(result.execution.responseSchemaDigest, scenario === 'matching' ? binding().responseSchemaDigest : undefined);
      assert.equal(checkpoints.some(value => value.providerCliInput !== undefined), scenario === 'matching');
    }
  });
}

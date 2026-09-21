import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { DockerCommandOptions } from '../packages/core/src/claude/docker/dockerExecutor.js';
process.env.NODE_ENV = 'test';
const TIMEOUT_MS = 100;
const TASK_ID = 'analysis-timeout-fixture';
let observed: DockerCommandOptions | undefined;
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', { namedExports: { ExecutionAbortedError: class extends Error {}, stopDockerContainer: async () => {}, findTaskContainer: async () => null, findRunningDockerContainerForTask: async () => null, inspectLegacyDockerContainerLivenessForTask: async () => "not_found", runWithExecutionAbortSignal: async (_s: unknown, f: () => Promise<unknown>) => f(), runWithPlannerAbortContext: async (_s: unknown, f: () => Promise<unknown>) => f(), buildPlannerAbortSignalKey: () => "fixture", plannerAbortSignalKeyForTask: () => "fixture", clearWorkerAbortSignal: async () => {}, checkAbortSignal: async () => false, shouldTerminateAfterAbortLookupFailure: () => false, ensureAgentBundleImage: async () => {}, ensureAgentDockerImage: async () => {}, detectContainerId: () => {}, executeDockerCommand: async (_command: string, _args: string[], options: DockerCommandOptions) => {
  observed = options;
  return { exitCode: 0, timedOut: true, timeoutMs: TIMEOUT_MS, stdout: JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Partial review must never become acceptance'}}), stderr: `Command timed out after ${TIMEOUT_MS}ms`, messageTimestamps: new Map() };
} } });

const { CodexAgent } = await import('../packages/core/src/agents/impl/CodexAgent.ts');
after(async () => { const { closeConnection } = await import('../packages/core/src/db/connection.js'); await closeConnection(); });
test('retains analysis timeout output by task while refusing partial review as success', async () => {
  const agent = new CodexAgent({ id:'fixture',alias:'fixture',type:'codex',enabled:true,dockerImage:'fixture-image',supportedModels:[] });
  mock.method(agent as unknown as { buildDockerArgs(): string[] }, 'buildDockerArgs', () => []);
  mock.method(agent as unknown as { resolveEffectiveReasoningLevel(): Promise<string> }, 'resolveEffectiveReasoningLevel', async () => '');
  const result = await agent.analyze('Review fixture', { taskId:TASK_ID,timeoutMs:TIMEOUT_MS,readOnlyWorkspacePath:'/fixture',suppressLlmLog:true });
  assert.equal(result.success,false);
  assert.match(result.error ?? '', /timed out after 100ms/);
  assert.equal(observed?.timeout,TIMEOUT_MS);
  assert.equal(observed?.taskId,TASK_ID);
  assert.equal(observed?.streamToRedis,true);
  assert.equal(observed?.preserveOutputOnTimeout,true);
});

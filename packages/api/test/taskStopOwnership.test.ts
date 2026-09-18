import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { createClient } from 'redis';
import knex from 'knex';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnalyzeOptions } from '@propr/core';

const REDIS_URL = process.env.PROPR_STOP_TEST_REDIS_URL;
const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
const publishedStates: unknown[] = [];
await mock.module('../../core/src/db/connection.js', { namedExports: {
  db: database, closeConnection: async () => undefined,
  createKnexConfigForMigrations: () => { throw Error('Fixture does not run application migrations'); },
  runMigrations: async () => { throw Error('Fixture does not run application migrations'); },
} });
await mock.module('../../core/src/utils/eventPublisher.js', {
  namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async (update: unknown) => { publishedStates.push(update); return true; } }),
    closeEventPublisher: async () => undefined, EventPublisher: class {} },
});
const { WorkerStateManager, TaskStates } = await import('../../core/src/utils/workerStateManager.js');
const { MAX_ATOMIC_UPDATE_ATTEMPTS } = await import('../../core/src/utils/workerStateTransition.js');
const { stopTaskExecution } = await import('../routes/dockerRoutes.js');
const { closeConnection, clearWorkerAbortSignalWithClient, buildPlannerAbortSignalKey } = await import('@propr/core');
const redis = createClient({ url: REDIS_URL });
const address = new URL(REDIS_URL ?? 'redis://127.0.0.1:6379');
const manager = REDIS_URL ? new WorkerStateManager({ redis: { host: address.hostname, port: Number(address.port) } }) : undefined;
const keys: string[] = [];
const CURRENT = { admissionId: 'owned-admission', operationId: 'owned-operation', containerId: 'owned-container' };
const REPLACEMENT = { admissionId: 'new-admission', operationId: 'new-operation', containerId: 'new-container' };

for (const terminalRecorded of [false, true])
test(`native producer -> API -> Ezer preserves paid output and settlement authority: ${terminalRecorded}`,
  { skip: !REDIS_URL || !process.env.EZER_PLANNING_SOURCE_ROOT }, async () => {
    const source = process.env.EZER_PLANNING_SOURCE_ROOT!;
    const { createProprAgentProvider } = await import(pathToFileURL(join(source, 'services/ezer/src/conversation/providers.ts')).href);
    const { createInitialDraftAuthor } = await import(pathToFileURL(join(source, 'services/ezer/src/planning/initial-draft-author.ts')).href);
    const { createAgentRoutes } = await import('../routes/agentRoutes.js');
    const { getAgentRegistry } = await import('@propr/core');
    const artifacts = ['analysis', 'epic', 'architecture', 'contract', 'stories', 'test-cases'].map(artifact => ({
      artifact, files: { [artifact === 'stories' ? 'stories/S01.md' : `${artifact}.md`]: '# Fixture candidate' },
    }));
    const paid = JSON.stringify({ artifacts: artifacts.map(item => ({ artifact: item.artifact,
      files: Object.entries(item.files).map(([path, content]) => ({ path, content })) })), questions: [] });
    const registry = getAgentRegistry();
    const originalInitialize = registry.ensureInitialized;
    const originalGet = registry.getAgentById;
    const root = await mkdtemp(join(tmpdir(), 'native-settlement-contract-'));
    let calls = 0;
    type Envelope = { results: Array<{ response: string; execution: {
      taskId: string; terminalRecorded: boolean; settlementError?: string;
    } }> };
    let envelope: Envelope | undefined;
    await database.schema.createTable('author_events', table => { table.increments('id'); table.text('payload'); });
    const trigger = 'reject_native_completion';
    if (!terminalRecorded) await database.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON task_history WHEN NEW.state = 'completed' BEGIN SELECT RAISE(FAIL, 'injected native completion failure'); END`);
    registry.ensureInitialized = async () => undefined;
    registry.getAgentById = () => ({ config: { id: 'paid-fixture', alias: 'paid-fixture', type: 'claude', defaultModel: 'fixture' },
      async analyze(_prompt: string, options: AnalyzeOptions) {
        calls += 1;
        await options.executionCallbacks!.onInputPrepared!({ prompt: _prompt, systemPrompt: 'fixture',
          responseSchema: options.responseSchema });
        await options.executionCallbacks!.onTerminal!({ childStopped: true, containerCessation: 'stopped',
          child: { pid: 17, containerName: 'fixture' }, exitCode: 0, signal: null, aborted: false,
          stdout: paid, stderr: '', messageTimestamps: new Map() });
        return { success: true, response: paid, modelUsed: 'fixture' };
      },
    }) as never;
    try {
      await mkdir(join(root, 'epics', 'EP-native-settlement'), { recursive: true });
      await writeFile(join(root, 'epics', 'EP-native-settlement', 'epic.md'), '# Original');
      for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Fixture'],
        ['config', 'user.email', 'fixture@example.test'], ['add', '.'], ['commit', '-m', 'docs: fixture']])
        execFileSync('git', args, { cwd: root, stdio: 'pipe' });
      const routes = createAgentRoutes({ stateManager: manager! });
      const handler = routes.router.stack.find(layer => layer.route?.path === '/chat')!.route!.stack[0].handle;
      const provider = createProprAgentProvider({ baseUrl: 'http://native.fixture', agentId: 'paid-fixture', internalSecret: 'fixture',
        fetchImpl: async (_url: unknown, init: RequestInit) => {
          const req = Object.assign(new EventEmitter(), { body: JSON.parse(String(init.body)) });
          const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
            status() { return res; }, json(body: unknown) { envelope = body as Envelope; } });
          await handler(req as never, res as never, () => undefined);
          return new Response(JSON.stringify(envelope));
        },
      });
      let materialized = false;
      const author = createInitialDraftAuthor({ projectRoot: root, journal: {}, author: provider,
        repository: () => 'fixture/planning', instruction: 'Exact fixture instruction', readFiles: async () => ({ 'epic.md': '# Original' }),
        append: async (_context: unknown, payload: unknown) => database('author_events').insert({ payload: JSON.stringify(payload) }),
        persistDraft: async () => { materialized = true; return { state: 'SUCCEEDED' }; },
      });
      const outcome = author({ operationId: 'native-fixture-operation', principalId: 'owner', sessionId: 'fixture' },
        'EP-native-settlement', [], []);
      if (terminalRecorded) assert.equal((await outcome).state, 'SUCCEEDED');
      else await assert.rejects(outcome, /NATIVE_PLANNING_EXECUTION_UNVERIFIED/);
      assert.ok(envelope);
      const observed = envelope.results[0];
      assert.equal(observed.response, paid);
      assert.equal(observed.execution.terminalRecorded, terminalRecorded);
      if (!terminalRecorded) assert.match(observed.execution.settlementError ?? '', /history was not persisted/);
      else assert.equal(observed.execution.settlementError, undefined);
      const taskId = observed.execution.taskId;
      keys.push(`worker:state:${taskId}`);
      const history = await database('task_history').where({ task_id: taskId });
      assert.equal(history.filter(row => row.state === TaskStates.COMPLETED).length, terminalRecorded ? 1 : 0);
      assert.equal(history.some(row => row.state === TaskStates.FAILED), false);
      assert.equal(JSON.parse(history.find(row => row.state === TaskStates.CLAUDE_EXECUTION).metadata).terminal.stdout, paid);
      assert.equal((await manager!.getTaskState(taskId))?.state, terminalRecorded ? TaskStates.COMPLETED : TaskStates.CLAUDE_EXECUTION);
      const retained = (await database('author_events')).map(row => JSON.parse(row.payload));
      if (!terminalRecorded) assert.equal(retained.find(row => row.kind === 'planning.author.response.unverified').response, paid);
      else assert.equal(retained.some(row => row.kind === 'planning.author.response.unverified'), false);
      assert.equal(materialized, terminalRecorded);
      assert.equal(calls, 1);
      console.log(JSON.stringify({ proof: 'native-api-ezer-settlement', taskId,
        nativeTerminalStdoutRetained: true, ezerUnverifiedResponseRetained: !terminalRecorded, terminalRecorded,
        candidateMaterializationCalled: materialized, authorCalls: calls,
        recovery: terminalRecorded ? 'settled-result-accepted' : 'retained-nonresumable' }));
    } finally {
      registry.ensureInitialized = originalInitialize;
      registry.getAgentById = originalGet;
      if (!terminalRecorded) await database.raw(`DROP TRIGGER ${trigger}`);
      await database.schema.dropTable('author_events');
      await rm(root, { recursive: true, force: true });
    }
  });

for (const interleaving of ['progress', 'metadata-at-cas', 'metadata-every-cas', 'replacement-after-conflict', 'already-completed', 'same-binding-new-attempt', 'replacement', 'replacement-at-cas']) {
  test(`task-scoped merge cancellation tolerates only same-attempt progress: ${interleaving}`, { skip: !REDIS_URL }, async () => {
    const taskId = await fixture();
    let injectedMetadata = false;
    let markAttempts = 0;
    const result = await stopTaskExecution(taskId, { redisClient: redis, ensureCancelled: true,
      cancellationReason: 'pr_merged', getQueue: async () => ({ getJobs: async () => [] }),
      stopContainer: async () => {
        await manager!.updateTaskState(taskId, TaskStates.POST_PROCESSING);
        if (interleaving === 'already-completed') await manager!.updateTaskState(taskId, TaskStates.COMPLETED);
        if (interleaving === 'same-binding-new-attempt') await manager!.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { historyMetadata: CURRENT });
        if (interleaving === 'replacement') await replace(taskId);
        return { success: true, cessation: 'stopped' };
      },
      markCancelled: async (id, by, metadata, expectation) => {
        markAttempts++;
        assert.ok(expectation, 'fresh CAS is still required for task-scoped cancellation');
        if ((['metadata-at-cas', 'replacement-after-conflict'].includes(interleaving) && !injectedMetadata) || interleaving === 'metadata-every-cas') {
          injectedMetadata = true;
          await manager!.updateHistoryMetadata(id, TaskStates.CLAUDE_EXECUTION, { sessionId: 'same-attempt-checkpoint' });
        }
        if (interleaving === 'replacement-after-conflict' && markAttempts === 2) await replace(taskId);
        if (interleaving === 'replacement-at-cas') await replace(taskId);
        return manager!.markTaskCancelledIfCurrent(id, expectation, by, metadata);
      },
    });
    const expected = ['progress', 'metadata-at-cas'].includes(interleaving);
    assert.equal(result.cancellationRecorded, expected);
    if (interleaving === 'metadata-every-cas') assert.equal(markAttempts, MAX_ATOMIC_UPDATE_ATTEMPTS);
    if (interleaving === 'metadata-at-cas') assert.equal(markAttempts, 2);
    if (interleaving === 'replacement-after-conflict') assert.equal(markAttempts, 2);
    const rows = await database('task_history').where({ task_id: taskId, state: TaskStates.CANCELLED });
    assert.equal(rows.length, expected ? 1 : 0);
    if (rows.length) assert.equal(JSON.parse(rows[0].metadata).cancellationReason, 'pr_merged');
  });
}

test('a completed legacy stop consumes only its own marker, not a later task-wide stop intent', { skip: !REDIS_URL }, async () => {
  const taskId = await fixture();
  const replacement = JSON.stringify({ requestedBy: 'later-owner', reason: 'new-task-stop-intent' });
  await stopTaskExecution(taskId, { redisClient: redis, getQueue: async () => ({ getJobs: async () => [] }),
    stopContainer: async () => {
      await redis.set(`worker:abort:${taskId}`, replacement);
      return { success: true, cessation: 'stopped' };
    },
    markCancelled: async () => ({}),
  });
  assert.equal(await redis.get(`worker:abort:${taskId}`), replacement);
});

before(async () => {
  if (!REDIS_URL) return;
  await redis.connect();
  await database.schema.createTable('tasks', table => {
    table.string('task_id').primary(); table.string('job_id'); table.string('correlation_id');
    table.string('repository'); table.integer('issue_number'); table.string('task_type');
    table.string('model_name'); table.string('created_at'); table.text('initial_job_data');
  });
  await database.schema.createTable('task_history', table => {
    table.increments('history_id'); table.string('task_id'); table.string('state');
    table.string('timestamp'); table.string('reason'); table.text('metadata');
  });
});
after(async () => {
  if (redis.isOpen) { for (const key of keys) await redis.del(key); await redis.quit(); }
  await manager?.close(); await database.destroy(); await closeConnection();
});

async function fixture() {
  const taskId = `planning-stop-proof-${randomUUID()}`;
  keys.push(`worker:state:${taskId}`, `worker:abort:${taskId}`, `conversation:${taskId}`);
  keys.push(buildPlannerAbortSignalKey(taskId, CURRENT.containerId), buildPlannerAbortSignalKey(taskId, REPLACEMENT.containerId));
  await manager!.createTaskState(taskId, { number: 1, repoOwner: 'fixture', repoName: 'stop' });
  await manager!.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { historyMetadata: { containerId: 'old-absent' } });
  await manager!.updateTaskState(taskId, TaskStates.PROCESSING);
  await manager!.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { historyMetadata: CURRENT });
  return taskId;
}
async function replace(taskId: string) {
  await manager!.updateTaskState(taskId, TaskStates.PROCESSING);
  await manager!.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { historyMetadata: REPLACEMENT });
}
const queue = async () => ({ getJobs: async () => { throw Error('Execution-scoped stop must not remove future queued attempts'); } });

test('failed SQLite cancellation history leaves the owned execution retryable, then records exactly one terminal row', { skip: !REDIS_URL }, async () => {
  const taskId = await fixture();
  const trigger = 'reject_fixture_cancellation';
  await database.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON task_history WHEN NEW.state = 'cancelled' BEGIN SELECT RAISE(FAIL, 'injected history failure'); END`);
  const options = { redisClient: redis, expectedExecution: CURRENT, getQueue: queue,
    stopContainer: async () => ({ success: true }),
    markCancelled: async (id: string, by: string, metadata: object, expectation: Parameters<InstanceType<typeof WorkerStateManager>['markTaskCancelledIfCurrent']>[1] | undefined) => {
      assert.ok(expectation);
      return manager!.markTaskCancelledIfCurrent(id, expectation, by, metadata);
    } };
  try {
    const beforeEvents = publishedStates.length;
    const failed = await stopTaskExecution(taskId, options);
    assert.equal(failed.cancellationRecorded, false);
    assert.equal((await database('task_history').where({ task_id: taskId, state: TaskStates.CANCELLED })).length, 0);
    assert.equal((await manager!.getTaskState(taskId))?.state, TaskStates.CLAUDE_EXECUTION);
    assert.equal(publishedStates.length, beforeEvents, 'unpersisted cancellation must not be published');
  } finally { await database.raw(`DROP TRIGGER ${trigger}`); }
  const retried = await stopTaskExecution(taskId, options);
  assert.equal(retried.cancellationRecorded, true);
  assert.equal((await database('task_history').where({ task_id: taskId, state: TaskStates.CANCELLED })).length, 1);
  console.log(JSON.stringify({ proof: 'durable-stop-retry', taskId, cancelledRows: 1 }));
});

test('strict conditional transition reconciles failed history without overwriting a concurrent replacement', { skip: !REDIS_URL }, async () => {
  const taskId = await fixture();
  const before = (await manager!.getTaskState(taskId))!;
  const replacement = { ...before, version: before.version! + 2,
    history: [...before.history, { state: TaskStates.CLAUDE_EXECUTION, metadata: REPLACEMENT }] };
  const client = Reflect.get(manager!, 'redis') as import('ioredis').Redis;
  const originalEval = client.eval.bind(client);
  let raced = false;
  const hook = mock.method(client, 'eval', async (script: string, count: number, ...args: string[]) => {
    if (!raced && args[0] === `worker:state:${taskId}` && JSON.parse(args[1]).state === TaskStates.CANCELLED) {
      raced = true;
      await redis.set(args[0], JSON.stringify(replacement));
    }
    return originalEval(script, count, ...args);
  });
  const trigger = 'reject_fixture_conditional';
  await database.raw(`CREATE TRIGGER ${trigger} BEFORE INSERT ON task_history WHEN NEW.state = 'cancelled' BEGIN SELECT RAISE(FAIL, 'injected conditional failure'); END`);
  try {
    const beforeEvents = publishedStates.length;
    await assert.rejects(manager!.updateTaskStateIfCurrentDetailed(taskId, before, TaskStates.CANCELLED,
      { requireDurableHistory: true }), /Task history was not persisted/);
    assert.equal(raced, true);
    assert.deepEqual(await manager!.getTaskState(taskId), replacement);
    assert.equal(publishedStates.length, beforeEvents);
    assert.equal((await database('task_history').where({ task_id: taskId, state: TaskStates.CANCELLED })).length, 0);
  } finally { hook.mock.restore(); await database.raw(`DROP TRIGGER ${trigger}`); }
});

for (const interleaving of ['none', 'before-marker-cas', 'during-stop', 'at-terminal-cas']) {
  test(`real Redis and SQLite stop binding interleaving: ${interleaving}`, { skip: !REDIS_URL }, async () => {
    const taskId = await fixture();
    const stopped: string[] = [];
    const adapter = {
      get: redis.get.bind(redis), set: redis.set.bind(redis), del: redis.del.bind(redis), rPush: redis.rPush.bind(redis),
      eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
        if (interleaving === 'before-marker-cas') await replace(taskId);
        return redis.eval(script, options);
      },
    };
    const pending = stopTaskExecution(taskId, {
      redisClient: adapter, expectedExecution: CURRENT, getQueue: queue,
      stopContainer: async (containerId, _timeout, options) => {
        assert.equal(options?.requireObservedCessation, true);
        stopped.push(containerId);
        if (interleaving === 'during-stop') await replace(taskId);
        return { success: true };
      },
      markCancelled: async (id, by, metadata, expectation) => {
        assert.ok(expectation);
        if (interleaving === 'at-terminal-cas') await replace(taskId);
        return manager!.markTaskCancelledIfCurrent(id, expectation, by, metadata);
      },
    });
    if (interleaving === 'before-marker-cas') {
      await assert.rejects(pending, /execution-changed/);
      assert.deepEqual(stopped, []);
      assert.equal(await redis.get(buildPlannerAbortSignalKey(taskId, CURRENT.containerId)), null);
    } else {
      const result = await pending;
      assert.deepEqual(stopped, [CURRENT.containerId]);
      assert.equal(result.cancellationRecorded, interleaving === 'none');
      assert.equal(JSON.parse((await redis.get(buildPlannerAbortSignalKey(taskId, CURRENT.containerId)))!).containerId, CURRENT.containerId);
    }
    const current = await manager!.getTaskState(taskId);
    const terminalRows = await database('task_history').where({ task_id: taskId, state: TaskStates.CANCELLED });
    assert.equal(terminalRows.length, interleaving === 'none' ? 1 : 0);
    assert.equal(current?.state, interleaving === 'none' ? TaskStates.CANCELLED : TaskStates.CLAUDE_EXECUTION);
    if (interleaving !== 'none') assert.equal(current?.history.at(-1)?.metadata?.containerId, REPLACEMENT.containerId);
    console.log(JSON.stringify({ proof: 'real-redis-sqlite-stop', taskId, interleaving, cancelledRows: terminalRows.length, state: current?.state }));
  });
}

test('real Redis compare-delete preserves a replacement marker after the consumer read', { skip: !REDIS_URL }, async () => {
  const taskId = await fixture();
  const key = `worker:abort:${taskId}`;
  await redis.set(key, JSON.stringify({ requestedBy: 'legacy' }));
  const replacement = JSON.stringify({ containerId: REPLACEMENT.containerId });
  await clearWorkerAbortSignalWithClient(taskId, {
    get: redis.get.bind(redis),
    eval: async (script, keyCount, ...args) => {
      await redis.set(key, replacement);
      return redis.eval(script, { keys: args.slice(0, keyCount), arguments: args.slice(keyCount) });
    },
  });
  assert.equal(await redis.get(key), replacement);
});

test('real Redis retains both owned signals when a replacement stop overlaps a pending stop', { skip: !REDIS_URL }, async () => {
  const taskId = await fixture();
  const options = { redisClient: redis, getQueue: queue,
    markCancelled: async () => { throw Error('Unobserved cessation must not settle'); } };
  const stopped: string[] = [];
  const oldResult = await stopTaskExecution(taskId, { ...options, expectedExecution: CURRENT,
    stopContainer: async containerId => {
      stopped.push(containerId);
      await replace(taskId);
      const newResult = await stopTaskExecution(taskId, { ...options, expectedExecution: REPLACEMENT,
        stopContainer: async replacementId => { stopped.push(replacementId); return { success: false, error: 'pending observation' }; } });
      assert.equal(newResult.containerStopped, false);
      return { success: false, error: 'pending observation' };
    },
  });
  assert.equal(oldResult.containerStopped, false);
  assert.deepEqual(stopped, [CURRENT.containerId, REPLACEMENT.containerId]);
  for (const execution of [CURRENT, REPLACEMENT]) {
    assert.equal(JSON.parse((await redis.get(buildPlannerAbortSignalKey(taskId, execution.containerId)))!).containerId, execution.containerId);
  }
  assert.equal(await redis.get(`worker:abort:${taskId}`), null);
  assert.equal((await database('task_history').where({ task_id: taskId, state: TaskStates.CANCELLED })).length, 0);
});

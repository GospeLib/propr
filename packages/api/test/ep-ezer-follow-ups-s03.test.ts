/**
 * EP-ezer-follow-ups-S03 — live control surface (TC-007, TC-008).
 *
 * Drives the real Express route table that `server.ts` registers, the real
 * `stopTaskExecution` stop path (abort marker, Docker container stop, queued
 * job removal) and the real EP-ezer-follow-ups-S02 `EzerStreamingService`.
 * Only the external systems (Redis, BullMQ, the Docker daemon and the task
 * state store) are replaced with fixtures, so every assertion below is about
 * production behaviour rather than a stand-in.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express, { type RequestHandler } from 'express';
import { closeConnection } from '@propr/core';
import { EzerStreamingService, type EzerEventEnvelope } from '../ep-ezer-follow-ups-s02.js';
import { createEzerControlRoutes } from '../routes/ep-ezer-follow-ups-s03.js';
import { stopTaskExecution, type StopTaskQueue, type StopTaskRedisClient } from '../routes/dockerRoutes.js';
import { assertNoDuplicateRoutes, registerRouteEntries, type RouteEntry } from '../routeRegistry.js';

after(async () => closeConnection());

const OPERATION = 'op-live';
const EXECUTION = 'exe-live';
const ATTEMPT = 'att-live';
const TASK = 'task-live';
const GENERATION = 'gen-live';
const OWNER = { id: 'user-1', username: 'owner' };
const OTHER = { id: 'user-2', username: 'intruder' };

interface RedisCall { method: string; key: string; value?: string }

/** Minimal Redis fixture with the exact surface stopTaskExecution uses. */
function createRedisFixture(): StopTaskRedisClient & { calls: RedisCall[]; store: Map<string, string> } {
  const store = new Map<string, string>();
  const calls: RedisCall[] = [];
  store.set(`worker:state:${TASK}`, JSON.stringify({
    history: [
      { state: 'processing' },
      { state: 'claude_execution', metadata: { containerId: 'container-1', containerName: 'propr-agent-live' } },
    ],
  }));
  return {
    calls,
    store,
    get: (key: string) => {
      calls.push({ method: 'get', key });
      return Promise.resolve(store.get(key) ?? null);
    },
    set: (key: string, value: string) => {
      calls.push({ method: 'set', key, value });
      store.set(key, value);
      return Promise.resolve('OK');
    },
    rPush: (key: string, value: string) => {
      calls.push({ method: 'rPush', key, value });
      return Promise.resolve(1);
    },
    del: (key: string) => {
      calls.push({ method: 'del', key });
      store.delete(key);
      return Promise.resolve(1);
    },
  };
}

interface Harness {
  app: express.Express;
  streaming: EzerStreamingService;
  redis: ReturnType<typeof createRedisFixture>;
  stoppedContainers: string[];
  cancellations: Array<{ taskId: string; cancelledBy: string }>;
  container: { present: boolean };
  principal: { id: string; username: string };
}

function createHarness(): Harness {
  const redis = createRedisFixture();
  const streaming = new EzerStreamingService();
  const stoppedContainers: string[] = [];
  const cancellations: Harness['cancellations'] = [];
  const container = { present: true };
  const harness = { principal: OWNER } as Harness;

  const queue: StopTaskQueue = { getJobs: () => Promise.resolve([]) };
  const ezerControlRoutes = createEzerControlRoutes({
    getStreamProjection: () => streaming,
    // The same call server.ts makes, with only the external systems replaced.
    stopTask: (taskId, context) => stopTaskExecution(taskId, {
      redisClient: redis,
      ...context,
      getQueue: () => Promise.resolve(queue),
      markCancelled: (id, cancelledBy) => {
        cancellations.push({ taskId: id, cancelledBy });
        return Promise.resolve(undefined);
      },
      stopContainer: (containerId: string) => {
        stoppedContainers.push(containerId);
        container.present = false;
        return Promise.resolve({ success: true });
      },
    }),
    registryOptions: {
      // Stands in for `docker ps` over the attempt's propr.task.* labels.
      observeAttempt: (taskId, attemptGeneration) => {
        assert.equal(taskId, TASK);
        assert.equal(attemptGeneration, GENERATION);
        return Promise.resolve(container.present ? { id: 'container-1', name: 'propr-agent-live' } : null);
      },
      pollIntervalMs: 5,
      cessationTargetMs: 500,
    },
  });

  const app = express();
  app.use(express.json());
  const authenticate: RequestHandler = (req, _res, next) => {
    req.user = harness.principal as Express.User;
    req.authorization = { role: 'member', permissions: [], source: 'implicit' };
    next();
  };
  app.use('/api', authenticate);
  const routes: RouteEntry[] = [
    ['post', '/api/ezer/operations/:operationId/attempts', ezerControlRoutes.registerAttempt],
    ['post', '/api/ezer/operations/:operationId/control', ezerControlRoutes.postControl],
    ['get', '/api/ezer/operations/:operationId/control', ezerControlRoutes.getControlState],
    ['post', '/api/ezer/operations/:operationId/steer/consume', ezerControlRoutes.consumeSteer],
  ];
  assertNoDuplicateRoutes(routes);
  registerRouteEntries(app, routes);

  Object.assign(harness, { app, streaming, redis, stoppedContainers, cancellations, container });
  return harness;
}

async function withHarness(callback: (harness: Harness, origin: string) => Promise<void>): Promise<void> {
  const harness = createHarness();
  const server = harness.app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    await callback(harness, `http://127.0.0.1:${port}`);
  } finally {
    harness.streaming.close();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

async function post(origin: string, path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function get(origin: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function register(origin: string, overrides: Record<string, unknown> = {}) {
  return post(origin, `/api/ezer/operations/${OPERATION}/attempts`, {
    executionId: EXECUTION,
    attemptId: ATTEMPT,
    taskId: TASK,
    attemptGeneration: GENERATION,
    sessionId: 'ses-live',
    requestId: 'req-live',
    ...overrides,
  });
}

function control(origin: string, payload: Record<string, unknown>) {
  return post(origin, `/api/ezer/operations/${OPERATION}/control`, {
    sessionId: 'ses-live',
    executionId: EXECUTION,
    attemptId: ATTEMPT,
    requestId: 'req-live',
    ...payload,
  });
}

function journalEnvelope(overrides: Partial<EzerEventEnvelope> = {}): EzerEventEnvelope {
  return {
    type: 'progress',
    requestId: 'req-live',
    sessionId: 'ses-live',
    operationId: OPERATION,
    executionId: EXECUTION,
    attemptId: ATTEMPT,
    cursor: '1',
    ts: new Date().toISOString(),
    summary: 'Analysing the repository.',
    ...overrides,
  };
}

/** Waits for the background cessation confirmation to settle. */
async function waitForSettlement(origin: string, commandId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await get(origin, `/api/ezer/operations/${OPERATION}/control`);
    const commands = state.body.commands as Array<Record<string, unknown>>;
    const match = commands.find(entry => entry.commandId === commandId);
    if (match && match.status === 'settled') return match;
    await new Promise<void>(resolve => { setTimeout(resolve, 10); });
  }
  throw new Error(`Cessation confirmation for ${commandId} never settled`);
}

describe('EP-ezer-follow-ups-S03 live control propagation (AC-S03-1)', () => {
  test('cancel acknowledges fast, really stops the job and confirms cessation', async () => {
    await withHarness(async (harness, origin) => {
      const registration = await register(origin);
      assert.equal(registration.status, 201);

      // The operation is live in the S02 projection: a real journal event
      // reaches a subscriber before any control command is issued.
      const delivered: Array<{ event: string; payload: unknown }> = [];
      await harness.streaming.resume(OPERATION, {
        id: 'socket-1',
        send: (event, payload) => { delivered.push({ event, payload }); },
      });
      assert.equal(harness.streaming.ingest(journalEnvelope()).accepted, true);
      assert.equal(delivered.filter(entry => entry.event === 'ezer:stream:event').length, 1);

      const startedAt = Date.now();
      const response = await control(origin, { type: 'cancel', commandId: 'cmd-cancel' });
      const ackElapsedMs = Date.now() - startedAt;

      assert.equal(response.status, 202);
      const ack = response.body.ack as Record<string, unknown>;
      assert.equal(ack.type, 'control-ack');
      assert.equal(ack.state, 'accepted');
      assert.equal(ack.attemptId, ATTEMPT);
      assert.equal(ack.cessation, 'pending', 'the ack is never reported as completion');
      assert.equal(ack.withinAckTarget, true);
      assert.ok(ackElapsedMs <= 2000, `control-ack took ${ackElapsedMs}ms`);
      assert.deepEqual(response.body.confirmation, { status: 'pending', report: null });

      const settled = await waitForSettlement(origin, 'cmd-cancel');
      const report = settled.report as Record<string, unknown>;
      assert.equal(report.state, 'stopped');
      assert.equal(report.confirmed, true);
      assert.equal(report.withinTarget, true);
      const evidence = report.evidence as Record<string, unknown>;
      assert.equal(evidence.containerStopped, true);
      assert.equal(evidence.observedContainer, null);

      // The real stop path ran: abort marker written, container stopped, marker
      // cleared after the direct stop, cancellation recorded.
      assert.ok(harness.redis.calls.some(call => call.method === 'set' && call.key === `worker:abort:${TASK}`));
      assert.deepEqual(harness.stoppedContainers, ['container-1']);
      assert.ok(harness.redis.calls.some(call => call.method === 'del' && call.key === `worker:abort:${TASK}`));
      assert.deepEqual(harness.cancellations, [{ taskId: TASK, cancelledBy: OWNER.username }]);

      // Late publication from the cancelled attempt is refused by the live
      // S02 projection, which the control plane fenced.
      const late = harness.streaming.ingest(journalEnvelope({ cursor: '2', summary: 'Late output.' }));
      assert.equal(late.accepted, false);
      assert.equal(late.accepted === false ? late.reason : null, 'fenced-attempt');
      assert.equal(delivered.filter(entry => entry.event === 'ezer:stream:event').length, 1);
    });
  });

  test('a duplicate cancel dedups and does not stop the job twice', async () => {
    await withHarness(async (harness, origin) => {
      await register(origin);
      const first = await control(origin, { type: 'cancel', commandId: 'cmd-dup' });
      assert.equal(first.status, 202);
      await waitForSettlement(origin, 'cmd-dup');

      const repeat = await control(origin, { type: 'cancel', commandId: 'cmd-dup' });
      assert.equal(repeat.status, 200);
      assert.equal((repeat.body.ack as Record<string, unknown>).state, 'deduplicated');
      assert.deepEqual(harness.stoppedContainers, ['container-1'], 'the container is stopped exactly once');
      assert.equal(harness.cancellations.length, 1);
    });
  });

  test('a cancel for a superseded attempt is refused without touching the replacement', async () => {
    await withHarness(async (harness, origin) => {
      await register(origin);
      const replacement = await register(origin, { attemptId: 'att-replacement', taskId: 'task-replacement' });
      assert.equal(replacement.status, 201);

      const response = await control(origin, { type: 'cancel', commandId: 'cmd-stale' });
      assert.equal(response.status, 409);
      const error = response.body.error as Record<string, unknown>;
      assert.equal(error.code, 'SUPERSEDED_ATTEMPT');
      assert.ok(error.retryPath);
      assert.ok(error.diagnosticId);
      assert.deepEqual(harness.stoppedContainers, [], 'the replacement attempt was not stopped');

      const state = await get(origin, `/api/ezer/operations/${OPERATION}/control`);
      const attempts = state.body.attempts as Array<Record<string, unknown>>;
      const current = attempts.find(attempt => attempt.attemptId === 'att-replacement');
      assert.equal(current?.phase, 'active');
      assert.equal(current?.fenced, false);
    });
  });

  test('pause checkpoints and stops, then grants exactly one resume', async () => {
    await withHarness(async (harness, origin) => {
      await register(origin, { pauseSupport: 'checkpoint-stop' });

      const paused = await control(origin, { type: 'pause', commandId: 'cmd-pause' });
      assert.equal(paused.status, 202);
      assert.equal((paused.body.ack as Record<string, unknown>).cessation, 'pending');

      const settled = await waitForSettlement(origin, 'cmd-pause');
      const report = settled.report as Record<string, unknown>;
      assert.equal(report.state, 'checkpointed');
      assert.equal(report.phase, 'paused');
      assert.deepEqual(harness.stoppedContainers, ['container-1']);
      // A checkpoint-pause suspends the attempt; it is not a cancellation.
      assert.deepEqual(harness.cancellations, [{ taskId: TASK, cancelledBy: OWNER.username }]);

      const firstResume = await control(origin, { type: 'resume', commandId: 'cmd-resume-a' });
      assert.equal(firstResume.status, 202);
      const resume = (firstResume.body.ack as Record<string, unknown>).resume as Record<string, unknown>;
      assert.ok(resume.continuationId);

      const secondResume = await control(origin, { type: 'resume', commandId: 'cmd-resume-b' });
      assert.equal(secondResume.status, 409);
      assert.equal((secondResume.body.error as Record<string, unknown>).code, 'RESUME_ALREADY_CLAIMED');
    });
  });

  test('pause is refused, not faked, when the execution cannot be suspended', async () => {
    await withHarness(async (harness, origin) => {
      await register(origin, { pauseSupport: 'unsupported' });

      const response = await control(origin, { type: 'pause', commandId: 'cmd-pause' });
      assert.equal(response.status, 409);
      const error = response.body.error as Record<string, unknown>;
      assert.equal(error.code, 'PAUSE_UNSUPPORTED');
      assert.match(String(error.remainingActivity), /remains active/);
      assert.deepEqual(harness.stoppedContainers, []);

      const state = await get(origin, `/api/ezer/operations/${OPERATION}/control`);
      const attempts = state.body.attempts as Array<Record<string, unknown>>;
      assert.equal(attempts[0].phase, 'active');
      assert.equal(attempts[0].fenced, false);
    });
  });

  test('a malformed command and an unknown attempt are both refused explicitly', async () => {
    await withHarness(async (_harness, origin) => {
      await register(origin);
      const malformed = await control(origin, { type: 'explode', commandId: 'cmd-bad' });
      assert.equal(malformed.status, 400);
      assert.equal(malformed.body.code, 'INVALID_COMMAND');

      const unknown = await control(origin, { type: 'cancel', commandId: 'cmd-nowhere', attemptId: 'ghost' });
      assert.equal(unknown.status, 404);
      assert.equal((unknown.body.error as Record<string, unknown>).code, 'UNKNOWN_ATTEMPT');
    });
  });

  test('another principal cannot control or read the operation', async () => {
    await withHarness(async (harness, origin) => {
      await register(origin);
      harness.principal = OTHER;

      const response = await control(origin, { type: 'cancel', commandId: 'cmd-intruder' });
      assert.equal(response.status, 403);
      assert.deepEqual(harness.stoppedContainers, []);

      const state = await get(origin, `/api/ezer/operations/${OPERATION}/control`);
      assert.equal(state.status, 403);
    });
  });
});

describe('EP-ezer-follow-ups-S03 live steering (AC-S03-2)', () => {
  test('steer revisions are ordered, then applied when the execution consumes them', async () => {
    await withHarness(async (_harness, origin) => {
      await register(origin);
      const first = await control(origin, { type: 'steer', commandId: 'cmd-s1', payload: { focus: 'api' } });
      const second = await control(origin, { type: 'steer', commandId: 'cmd-s2', payload: { focus: 'docs' } });

      assert.equal((first.body.ack as Record<string, unknown>).steerVersion, 1);
      assert.equal((first.body.ack as Record<string, unknown>).steerState, 'accepted');
      assert.equal((second.body.ack as Record<string, unknown>).steerVersion, 2);

      const beforeState = await get(origin, `/api/ezer/operations/${OPERATION}/control`);
      const beforeSteer = (beforeState.body.attempts as Array<Record<string, unknown>>)[0].steer as Array<Record<string, unknown>>;
      assert.deepEqual(beforeSteer.map(revision => revision.state), ['accepted', 'accepted']);

      const consumed = await post(origin, `/api/ezer/operations/${OPERATION}/steer/consume`, {
        executionId: EXECUTION, attemptId: ATTEMPT,
      });
      assert.equal(consumed.status, 200);
      const applied = consumed.body.applied as Array<Record<string, unknown>>;
      assert.deepEqual(applied.map(revision => revision.version), [1, 2]);
      assert.deepEqual(applied.map(revision => revision.state), ['applied', 'applied']);
      assert.deepEqual(applied.map(revision => revision.payload), [{ focus: 'api' }, { focus: 'docs' }]);

      // Prior evidence survives the transition and nothing is handed out twice.
      const afterSteer = (consumed.body.attempt as Record<string, unknown>).steer as Array<Record<string, unknown>>;
      assert.deepEqual(afterSteer.map(revision => revision.acceptedAt), beforeSteer.map(revision => revision.acceptedAt));
      const again = await post(origin, `/api/ezer/operations/${OPERATION}/steer/consume`, {
        executionId: EXECUTION, attemptId: ATTEMPT,
      });
      assert.deepEqual(again.body.applied, []);
    });
  });

  test('a duplicate steer dedups and a conflicting payload is rejected', async () => {
    await withHarness(async (_harness, origin) => {
      await register(origin);
      await control(origin, { type: 'steer', commandId: 'cmd-s1', payload: { focus: 'api', steps: [1, 2] } });

      const duplicate = await control(origin, {
        type: 'steer', commandId: 'cmd-s1', payload: { steps: [1, 2], focus: 'api' },
      });
      assert.equal(duplicate.status, 200);
      assert.equal((duplicate.body.ack as Record<string, unknown>).state, 'deduplicated');

      const conflict = await control(origin, {
        type: 'steer', commandId: 'cmd-s1', payload: { focus: 'something-else' },
      });
      assert.equal(conflict.status, 409);
      assert.equal((conflict.body.error as Record<string, unknown>).code, 'IDEMPOTENCY_KEY_CONFLICT');

      const state = await get(origin, `/api/ezer/operations/${OPERATION}/control`);
      const steer = (state.body.attempts as Array<Record<string, unknown>>)[0].steer as Array<Record<string, unknown>>;
      assert.equal(steer.length, 1);
      assert.deepEqual(steer[0].payload, { focus: 'api', steps: [1, 2] });
    });
  });

  test('steering a cancelled attempt is refused and never redirects a replacement', async () => {
    await withHarness(async (_harness, origin) => {
      await register(origin);
      await control(origin, { type: 'cancel', commandId: 'cmd-cancel' });
      await waitForSettlement(origin, 'cmd-cancel');

      const late = await control(origin, { type: 'steer', commandId: 'cmd-late', payload: { focus: 'late' } });
      assert.equal(late.status, 409);
      assert.equal((late.body.error as Record<string, unknown>).code, 'ATTEMPT_FENCED');

      await register(origin, { attemptId: 'att-replacement', taskId: 'task-replacement' });
      const state = await get(origin, `/api/ezer/operations/${OPERATION}/control`);
      const replacement = (state.body.attempts as Array<Record<string, unknown>>)
        .find(attempt => attempt.attemptId === 'att-replacement');
      assert.deepEqual(replacement?.steer, [], 'the refused steer did not land on the replacement attempt');
    });
  });
});

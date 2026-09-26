/* eslint-disable max-lines -- AC-S03-1 and AC-S03-2 each require several
   positive, negative and race conditions to be exercised against one shared
   control-plane fixture, so they are kept in a single mapped test file. */
/**
 * EP-ezer-follow-ups-S03 — control propagation over the live route surface.
 *
 * AC-S03-1 (TC-007): pause/resume/cancel target the exact active attempt, are
 * acknowledged within the 2s design target, and either confirm real cessation
 * within 10s or explicitly report still-running with a reason and a recovery.
 * AC-S03-2 (TC-008): steering is ordered and versioned with distinct
 * accepted/applied states; duplicates dedup and conflicts reject.
 *
 * The commands run through the real `createEzerControlRoutes` handlers, the
 * real S02 journal projection and the real `stopTaskExecution` propagation
 * path, with isolated Redis/queue/container fixtures standing in for live
 * infrastructure.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express, { type Response } from 'express';
import { closeConnection } from '@propr/core';
import { assertNoDuplicateRoutes, registerRouteEntries, type RouteEntry } from '../routeRegistry.js';
import {
  EzerStreamingService,
  EZER_STREAM_EVENT,
  type EzerEventEnvelope,
} from '../ep-ezer-follow-ups-s02.js';
import type { FlatRequest } from '../requestTypes.js';
import { createEzerControlRoutes } from '../routes/ep-ezer-follow-ups-s03.js';
import { stopTaskExecution } from '../routes/dockerRoutes.js';

after(async () => { await closeConnection(); });

const OPERATION_ID = 'op-ezer-1';
const TASK_ID = 'task-ezer-1';
const CONTAINER_ID = 'abc123def456';

interface Harness {
  streaming: EzerStreamingService;
  routes: ReturnType<typeof createEzerControlRoutes>;
  events: EzerEventEnvelope[];
  redisData: Map<string, string>;
  state: { containerRunning: boolean; containerStopSucceeds: boolean };
  stoppedContainers: string[];
  cancelMarks: string[];
  cursor: () => string;
  ingest: (overrides?: Partial<EzerEventEnvelope>) => ReturnType<EzerStreamingService['ingest']>;
  post: (body: unknown, operationId?: string) => Promise<{ statusCode: number; body: Record<string, unknown> }>;
  get: (operationId?: string) => Promise<{ statusCode: number; body: Record<string, unknown> }>;
}

function createResponse() {
  const captured = { statusCode: 200, body: {} as Record<string, unknown> };
  const res = {
    status(code: number) { captured.statusCode = code; return res; },
    json(payload: Record<string, unknown>) { captured.body = payload; return res; },
  };
  return { res: res as unknown as Response, captured };
}

function createRequest(operationId: string, body: unknown): FlatRequest {
  return {
    params: { operationId },
    body,
    user: { id: 'user-1', username: 'owner' },
    authorization: { permissions: [] },
  } as unknown as FlatRequest;
}

async function createHarness(): Promise<Harness> {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const wait = async (ms: number) => { clock += ms; };
  const redisData = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const state = { containerRunning: true, containerStopSucceeds: true };
  const stoppedContainers: string[] = [];
  const cancelMarks: string[] = [];
  let cursorValue = 100;

  const redisClient = {
    get: async (key: string) => redisData.get(key) ?? null,
    set: async (key: string, value: string) => { redisData.set(key, value); return 'OK'; },
    del: async (key: string) => { redisData.delete(key); return 1; },
    // f730c101: legacy markers are consumed with atomic compare-and-delete.
    eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
      const [key] = options.keys;
      if (redisData.get(key) !== options.arguments[0]) return 0;
      return redisData.delete(key) ? 1 : 0;
    },
    rPush: async (key: string, value: string) => {
      lists.set(key, [...(lists.get(key) ?? []), value]);
      return 1;
    },
  };

  redisData.set(`worker:state:${TASK_ID}`, JSON.stringify({
    history: [{ state: 'claude_execution', metadata: { containerId: CONTAINER_ID } }],
  }));

  /** The real stop path, with the queue/state-manager/container seams isolated. */
  const stopTask: typeof stopTaskExecution = (taskIdOrJobId, options) => stopTaskExecution(taskIdOrJobId, {
    ...options,
    getQueue: async () => ({ getJobs: async () => [] }),
    createTaskState: async () => undefined,
    markCancelled: async (taskId, cancelledBy) => {
      cancelMarks.push(`${taskId}:${cancelledBy}`);
      // Mirrors the real state manager: cancellation becomes the terminal state.
      const raw = redisData.get(`worker:state:${taskId}`);
      const parsed = raw ? JSON.parse(raw) as { history: unknown[] } : { history: [] };
      parsed.history.push({ state: 'cancelled', metadata: {} });
      redisData.set(`worker:state:${taskId}`, JSON.stringify(parsed));
    },
    stopContainer: async (containerId: string) => {
      if (!state.containerStopSucceeds) return { success: false, error: 'daemon busy' };
      stoppedContainers.push(containerId);
      state.containerRunning = false;
      return { success: true };
    },
  });

  const streaming = new EzerStreamingService({
    now,
    // Heartbeats belong to S02 and would only add noise to control assertions.
    scheduleTimer: () => null,
    cancelTimer: () => {},
  });
  const events: EzerEventEnvelope[] = [];
  await streaming.resume(OPERATION_ID, {
    id: 'subscriber-1',
    send: (event, payload) => {
      if (event === EZER_STREAM_EVENT) events.push(payload as EzerEventEnvelope);
    },
  });

  const routes = createEzerControlRoutes({
    redisClient: redisClient as never,
    getStreaming: () => streaming,
    stopTaskExecution: stopTask,
    observeContainerStatus: (containerId: string) => {
      if (containerId !== CONTAINER_ID) return '';
      return state.containerRunning ? 'Up 3 minutes' : '';
    },
    now,
    wait,
  });

  const ingest: Harness['ingest'] = overrides => streaming.ingest({
    type: 'progress',
    requestId: 'req-1',
    sessionId: 'session-1',
    operationId: OPERATION_ID,
    executionId: 'exec-1',
    attemptId: 'attempt-1',
    cursor: String(++cursorValue),
    ts: new Date(now()).toISOString(),
    summary: 'Working on the request.',
    ...overrides,
  });

  const post: Harness['post'] = async (body, operationId = OPERATION_ID) => {
    const { res, captured } = createResponse();
    await routes.postControl(createRequest(operationId, body), res);
    return captured;
  };

  const get: Harness['get'] = async (operationId = OPERATION_ID) => {
    const { res, captured } = createResponse();
    await routes.getControlState(createRequest(operationId, {}), res);
    return captured;
  };

  return {
    streaming, routes, events, redisData, state, stoppedContainers, cancelMarks,
    cursor: () => String(cursorValue), ingest, post, get,
  };
}

function command(overrides: Record<string, unknown>): Record<string, unknown> {
  return { sessionId: 'session-1', requestId: 'req-1', ...overrides };
}

function typesOf(events: EzerEventEnvelope[]): string[] {
  return events.map(event => event.type);
}

describe('AC-S03-1 — pause, resume and cancellation propagation', () => {
  test('cancel targets the active attempt, acks immediately and confirms real cessation', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.events.length = 0;

    const response = await harness.post(command({
      command: 'cancel', commandId: 'cmd-cancel-1', taskId: TASK_ID,
    }));

    assert.equal(response.statusCode, 202);
    const ack = response.body.ack as Record<string, unknown>;
    assert.equal(ack.state, 'accepted');
    assert.equal(ack.meansCompleted, false);
    assert.equal(ack.withinAckTarget, true);
    assert.ok((ack.ackLatencyMs as number) <= 2_000);
    assert.deepEqual(ack.target, { executionId: 'exec-1', attemptId: 'attempt-1' });

    const confirmation = response.body.confirmation as Record<string, unknown>;
    assert.equal(confirmation.status, 'confirmed');
    assert.equal(confirmation.withinCessationTarget, true);
    const evidence = confirmation.evidence as Record<string, unknown>;
    assert.equal(evidence.stopped, true);
    assert.equal(evidence.fenced, true);
    const cessation = evidence.cessation as Record<string, unknown>;
    assert.equal(cessation.containerEvidence, 'absent');
    assert.equal(cessation.workerState, 'cancelled');
    assert.equal(cessation.abortMarkerCleared, true);

    // The container and the cancellation record are real effects, not claims.
    assert.deepEqual(harness.stoppedContainers, [CONTAINER_ID]);
    assert.deepEqual(harness.cancelMarks, [`${TASK_ID}:owner`]);

    // An acknowledgement is published before, and separately from, the result.
    assert.deepEqual(typesOf(harness.events), ['control-ack', 'result']);
  });

  test('a cancelled attempt cannot publish late output', async () => {
    const harness = await createHarness();
    harness.ingest();
    await harness.post(command({ command: 'cancel', commandId: 'cmd-cancel-2', taskId: TASK_ID }));
    harness.events.length = 0;

    const late = harness.ingest({ summary: 'Late output from the cancelled attempt.' });

    assert.equal(late.accepted, false);
    assert.equal(late.accepted === false && late.reason, 'fenced-attempt');
    assert.deepEqual(harness.events, []);
  });

  test('an unstoppable container is reported still-running, never as stopped', async () => {
    const harness = await createHarness();
    harness.state.containerStopSucceeds = false;
    harness.ingest();

    const response = await harness.post(command({
      command: 'cancel', commandId: 'cmd-cancel-3', taskId: TASK_ID,
    }));
    const confirmation = response.body.confirmation as Record<string, unknown>;

    assert.equal(confirmation.status, 'unconfirmed');
    assert.equal((confirmation.evidence as Record<string, unknown>).stopped, false);
    assert.equal(confirmation.reasonCode, 'CESSATION_UNCONFIRMED');
    assert.match(confirmation.reason as string, /still up/);
    assert.match(confirmation.reason as string, /abort marker/);
    assert.ok(confirmation.recovery);
    assert.match(confirmation.summary as string, /is not confirmed stopped/);
    // The still-running report reaches subscribers as a blocker, not a result.
    assert.deepEqual(typesOf(harness.events).slice(-1), ['progress']);
    assert.equal(harness.events.at(-1)?.detail?.kind, 'blocker');
  });

  test('a cancel with no task binding fences the attempt without claiming a stop', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.post(command({ command: 'cancel', commandId: 'cmd-cancel-4' }));
    const confirmation = response.body.confirmation as Record<string, unknown>;

    assert.equal(confirmation.status, 'unconfirmed');
    assert.equal(confirmation.reasonCode, 'TASK_BINDING_UNKNOWN');
    assert.equal((confirmation.evidence as Record<string, unknown>).stopped, false);
    assert.equal((confirmation.evidence as Record<string, unknown>).fenced, true);
    assert.deepEqual(harness.stoppedContainers, []);
    // Fencing still holds, so the attempt cannot publish after the refusal.
    assert.equal(harness.ingest().accepted, false);
  });

  test('a racing second cancel neither double-stops nor invents a new fence', async () => {
    const harness = await createHarness();
    harness.ingest();
    const first = await harness.post(command({ command: 'cancel', commandId: 'cmd-race-a', taskId: TASK_ID }));
    const second = await harness.post(command({ command: 'cancel', commandId: 'cmd-race-b', taskId: TASK_ID }));

    assert.equal((first.body.confirmation as Record<string, unknown>).status, 'confirmed');
    const secondConfirmation = second.body.confirmation as Record<string, unknown>;
    assert.equal(secondConfirmation.status, 'confirmed');
    const evidence = secondConfirmation.evidence as Record<string, unknown>;
    assert.equal(evidence.alreadyFenced, true);
    assert.deepEqual((evidence.cessation as Record<string, unknown>).jobPresence, 'inactive');
    assert.deepEqual(harness.stoppedContainers, [CONTAINER_ID]);

    const state = (await harness.get()).body;
    assert.deepEqual(state.fencedAttempts, [{ executionId: 'exec-1', attemptId: 'attempt-1' }]);
  });

  test('a command aimed at a superseded attempt is refused and changes nothing', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ attemptId: 'attempt-2', summary: 'Replacement attempt started.' });
    harness.events.length = 0;

    const response = await harness.post(command({
      command: 'cancel', commandId: 'cmd-stale', taskId: TASK_ID,
      executionId: 'exec-1', attemptId: 'attempt-1',
    }));

    assert.equal(response.statusCode, 409);
    assert.equal((response.body.error as Record<string, unknown>).code, 'ATTEMPT_MISMATCH');
    assert.deepEqual(harness.stoppedContainers, []);
    assert.deepEqual(harness.events, []);
    // The replacement attempt keeps running and keeps publishing.
    assert.equal(harness.ingest({ attemptId: 'attempt-2' }).accepted, true);
    assert.deepEqual((await harness.get()).body.commands, []);
  });

  test('pause refuses an actively running attempt instead of reporting it paused', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.post(command({ command: 'pause', commandId: 'cmd-pause-1' }));
    const confirmation = response.body.confirmation as Record<string, unknown>;

    assert.equal(confirmation.status, 'refused');
    assert.equal(confirmation.reasonCode, 'PAUSE_NOT_SUPPORTED_FOR_ACTIVE_ATTEMPT');
    const evidence = confirmation.evidence as Record<string, unknown>;
    assert.equal(evidence.paused, false);
    assert.equal(evidence.stillRunning, true);
    assert.ok(confirmation.recovery);
    assert.equal((await harness.get()).body.paused, false);
  });

  test('pause checkpoints between attempts and exactly one resume continues it', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ type: 'result', summary: 'Attempt finished.' });
    const checkpointCursor = harness.cursor();

    const paused = await harness.post(command({ command: 'pause', commandId: 'cmd-pause-2' }));
    const pauseConfirmation = paused.body.confirmation as Record<string, unknown>;
    assert.equal(pauseConfirmation.status, 'confirmed');
    assert.equal((pauseConfirmation.evidence as Record<string, unknown>).mode, 'checkpointed');
    assert.equal(
      ((pauseConfirmation.evidence as Record<string, unknown>).pause as Record<string, unknown>).checkpointCursor,
      checkpointCursor,
    );

    const secondPause = await harness.post(command({ command: 'pause', commandId: 'cmd-pause-3' }));
    assert.equal((secondPause.body.confirmation as Record<string, unknown>).reasonCode, 'ALREADY_PAUSED');

    const resumed = await harness.post(command({ command: 'resume', commandId: 'cmd-resume-1' }));
    const resumeEvidence = (resumed.body.confirmation as Record<string, unknown>).evidence as Record<string, unknown>;
    assert.equal((resumed.body.confirmation as Record<string, unknown>).status, 'confirmed');
    assert.equal(resumeEvidence.continuationsCreated, 1);
    assert.equal(resumeEvidence.resumedFromCursor, checkpointCursor);

    const secondResume = await harness.post(command({ command: 'resume', commandId: 'cmd-resume-2' }));
    const secondConfirmation = secondResume.body.confirmation as Record<string, unknown>;
    assert.equal(secondConfirmation.status, 'refused');
    assert.equal(secondConfirmation.reasonCode, 'ALREADY_RESUMED');
    assert.equal(
      ((secondConfirmation.evidence as Record<string, unknown>).continuationsCreated), 1,
    );
    assert.equal((await harness.get()).body.continuationsCreated, 1);
  });

  test('resume refuses to duplicate an attempt that is already running', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.post(command({ command: 'resume', commandId: 'cmd-resume-3' }));
    const confirmation = response.body.confirmation as Record<string, unknown>;

    assert.equal(confirmation.status, 'refused');
    assert.equal(confirmation.reasonCode, 'ATTEMPT_ALREADY_ACTIVE');
    assert.equal((confirmation.evidence as Record<string, unknown>).continuationsCreated, 0);
  });
});

describe('AC-S03-2 — ordered, versioned steering with accepted and applied states', () => {
  test('steering is accepted, then applied only when subsequent activity follows it', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.events.length = 0;

    const accepted = await harness.post(command({
      command: 'steer', commandId: 'cmd-steer-1', payload: { focus: 'tests first' },
    }));
    const confirmation = accepted.body.confirmation as Record<string, unknown>;
    assert.equal(confirmation.status, 'confirmed');
    const evidence = confirmation.evidence as Record<string, unknown>;
    assert.equal(evidence.version, 1);
    assert.equal(evidence.applied, false);
    assert.deepEqual(typesOf(harness.events), ['control-ack', 'result']);

    let steering = (await harness.get()).body.steering as Record<string, unknown>[];
    assert.equal(steering[0].state, 'accepted');
    assert.equal(steering[0].appliedAt, undefined);

    // Real subsequent activity on the steered attempt is what "applied" means.
    harness.ingest({ summary: 'Following the redirected input.' });

    steering = (await harness.get()).body.steering as Record<string, unknown>[];
    assert.equal(steering[0].state, 'applied');
    assert.equal(steering[0].appliedAtCursor, harness.cursor());
    assert.ok(harness.events.some(event =>
      event.type === 'progress' && /Steering revision v1 applied/.test(event.summary)));
  });

  test('a later revision is ordered after the first and preserves its evidence', async () => {
    const harness = await createHarness();
    harness.ingest();
    await harness.post(command({ command: 'steer', commandId: 'cmd-order-1', payload: { focus: 'a' } }));
    harness.ingest();
    await harness.post(command({ command: 'steer', commandId: 'cmd-order-2', payload: { focus: 'b' } }));

    const steering = (await harness.get()).body.steering as Record<string, unknown>[];
    assert.deepEqual(steering.map(revision => revision.version), [1, 2]);
    assert.deepEqual(steering.map(revision => revision.state), ['applied', 'accepted']);
    assert.deepEqual(steering[0].payload, { focus: 'a' });
    assert.deepEqual(steering[1].payload, { focus: 'b' });
    assert.notEqual(steering[0].payloadFingerprint, steering[1].payloadFingerprint);
  });

  test('a duplicate commandId with an identical payload dedups to the original ack', async () => {
    const harness = await createHarness();
    harness.ingest();
    const body = command({ command: 'steer', commandId: 'cmd-dup', payload: { focus: 'tests', depth: 2 } });
    const first = await harness.post(body);
    // Key order must not matter to the fingerprint of an identical payload.
    const replay = await harness.post(command({
      command: 'steer', commandId: 'cmd-dup', payload: { depth: 2, focus: 'tests' },
    }));

    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.deduplicated, true);
    assert.equal(replay.body.duplicateDeliveries, 1);
    assert.deepEqual(replay.body.ack, first.body.ack);
    assert.equal(((await harness.get()).body.steering as unknown[]).length, 1);
  });

  test('a conflicting payload under the same commandId is rejected and redirects nothing', async () => {
    const harness = await createHarness();
    harness.ingest();
    await harness.post(command({ command: 'steer', commandId: 'cmd-conflict', payload: { focus: 'a' } }));
    harness.events.length = 0;

    const conflict = await harness.post(command({
      command: 'steer', commandId: 'cmd-conflict', payload: { focus: 'redirected elsewhere' },
    }));

    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.redirected, false);
    assert.equal((conflict.body.error as Record<string, unknown>).code, 'IDEMPOTENCY_CONFLICT');
    assert.ok((conflict.body.error as Record<string, unknown>).retryPath);
    assert.deepEqual(harness.events, []);
    const steering = (await harness.get()).body.steering as Record<string, unknown>[];
    assert.equal(steering.length, 1);
    assert.deepEqual(steering[0].payload, { focus: 'a' });
  });

  test('a fenced attempt cannot be steered and its replacement is not redirected', async () => {
    const harness = await createHarness();
    harness.ingest();
    await harness.post(command({ command: 'cancel', commandId: 'cmd-fence', taskId: TASK_ID }));

    const response = await harness.post(command({
      command: 'steer', commandId: 'cmd-steer-fenced', payload: { focus: 'too late' },
    }));
    const confirmation = response.body.confirmation as Record<string, unknown>;

    assert.equal(confirmation.status, 'refused');
    assert.equal(confirmation.reasonCode, 'ATTEMPT_NOT_STEERABLE');
    assert.equal((confirmation.evidence as Record<string, unknown>).redirected, false);
    assert.equal(((await harness.get()).body.steering as unknown[]).length, 0);
  });

  test('a steer without an object payload is refused before any state changes', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.post(command({ command: 'steer', commandId: 'cmd-bad' }));

    assert.equal(response.statusCode, 400);
    assert.equal((response.body.error as Record<string, unknown>).code, 'INVALID_CONTROL_REQUEST');
    assert.deepEqual((await harness.get()).body.commands, []);
  });
});

describe('the control plane over its registered HTTP routes', () => {
  /**
   * Mounts the handlers on the exact paths `server.ts` registers them under,
   * through the same `registerRouteEntries` helper, and drives them over real
   * HTTP — so the delivered behaviour is exercised on the live route surface
   * rather than only through directly invoked handler functions.
   */
  test('a cancel issued over HTTP stops the real container and streams ack then result', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.events.length = 0;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'user-1', username: 'owner' } as Express.User;
      req.authorization = { role: 'member', permissions: [], source: 'implicit' };
      next();
    });
    const routes: RouteEntry[] = [
      ['post', '/api/ezer/operations/:operationId/control', harness.routes.postControl as never],
      ['get', '/api/ezer/operations/:operationId/control', harness.routes.getControlState as never],
    ];
    assertNoDuplicateRoutes(routes);
    registerRouteEntries(app, routes);

    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}/api/ezer/operations/${OPERATION_ID}/control`;

      const posted = await fetch(origin, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(command({
          command: 'cancel', commandId: 'cmd-http-cancel', taskId: TASK_ID,
        })),
      });
      assert.equal(posted.status, 202);
      const body = await posted.json() as Record<string, Record<string, unknown>>;
      assert.equal(body.ack.state, 'accepted');
      assert.equal(body.confirmation.status, 'confirmed');

      const read = await fetch(origin);
      assert.equal(read.status, 200);
      const state = await read.json() as Record<string, unknown>;
      assert.deepEqual(state.fencedAttempts, [{ executionId: 'exec-1', attemptId: 'attempt-1' }]);
      assert.equal((state.commands as unknown[]).length, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }

    assert.deepEqual(harness.stoppedContainers, [CONTAINER_ID]);
    assert.deepEqual(typesOf(harness.events), ['control-ack', 'result']);
  });
});

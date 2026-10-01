/* eslint-disable max-lines -- AC-S04-1 and AC-S04-2 each require many positive,
   negative and repeat conditions (four distinct provider faults, silence,
   timeout, reconnect, dedup, conflict, checkpoint and budget) against one
   shared fixture, so they are kept in a single mapped test file. */
/**
 * EP-ezer-follow-ups-S04 — actionable errors and reconnect/retry idempotency,
 * over the live route surface.
 *
 * AC-S04-1 (TC-009): provider failures, long silence, a real credential 401
 * versus a quota 403/429, and a timeout each expose code/diagnosticId, a known
 * cause or a truthful `unknown`, what was saved, what is still running, and a
 * bounded recovery path carrying the actual reset/Retry-After metadata.
 * AC-S04-2 (TC-010): disconnect/reconnect and a same-session retry resume the
 * journal cursor with no duplicate accepted action; the same command key with a
 * different payload rejects; timeout → owned abort marker → exact
 * child/container cessation → terminal record fences late output; and a valid
 * checkpoint recovery adds no author call and invents neither approval nor
 * completion.
 *
 * Everything runs through the real `createEzerRecoveryRoutes` handlers, the
 * real S02 journal projection, the shared S03 cessation observer and the real
 * `stopTaskExecution` propagation path, with isolated Redis/queue/container
 * fixtures standing in for live infrastructure.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express from 'express';
import type { Response } from 'express';
import { closeConnection } from '@propr/core';
import { assertNoDuplicateRoutes, registerRouteEntries, type RouteEntry } from '../routeRegistry.js';
import {
  compareEzerCursors,
  EzerStreamingService,
  EZER_STREAM_EVENT,
  type EzerEventEnvelope,
  type EzerJournalReader,
} from '../ep-ezer-follow-ups-s02.js';
import type { FlatRequest } from '../requestTypes.js';
import { createEzerRecoveryRoutes } from '../routes/ep-ezer-follow-ups-s04.js';
import { stopTaskExecution } from '../routes/dockerRoutes.js';

after(async () => { await closeConnection(); });

const OPERATION_ID = 'op-ezer-s04';
const TASK_ID = 'task-ezer-s04';
const CONTAINER_ID = 'abc123def456';
const START_MS = 1_700_000_000_000;
/** The seven fields `contract.md` requires of every error object. */
const CONTRACT_ERROR_FIELDS = [
  'code', 'message', 'diagnosticId', 'knownCause', 'persistedState', 'remainingActivity', 'retryPath',
] as const;

type Body = Record<string, unknown>;

interface Harness {
  streaming: EzerStreamingService;
  routes: ReturnType<typeof createEzerRecoveryRoutes>;
  events: EzerEventEnvelope[];
  state: { containerRunning: boolean; containerStopSucceeds: boolean };
  stoppedContainers: string[];
  cancelMarks: string[];
  clock: { now: number };
  cursor: () => string;
  advance: (ms: number) => void;
  ingest: (overrides?: Partial<EzerEventEnvelope>) => ReturnType<EzerStreamingService['ingest']>;
  postFailure: (body: unknown, operationId?: string) => Promise<{ statusCode: number; body: Body }>;
  postRecovery: (body: unknown, operationId?: string) => Promise<{ statusCode: number; body: Body }>;
  getRecovery: (operationId?: string) => Promise<{ statusCode: number; body: Body }>;
  reconnect: (subscriberId: string, afterCursor?: string) => Promise<EzerEventEnvelope[]>;
}

function createResponse() {
  const captured = { statusCode: 200, body: {} as Body };
  const res = {
    status(code: number) { captured.statusCode = code; return res; },
    json(payload: Body) { captured.body = payload; return res; },
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
  const clock = { now: START_MS };
  const now = () => clock.now;
  const wait = async (ms: number) => { clock.now += ms; };
  const redisData = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const state = { containerRunning: true, containerStopSucceeds: true };
  const stoppedContainers: string[] = [];
  const cancelMarks: string[] = [];
  const journal: EzerEventEnvelope[] = [];
  let cursorValue = 100;

  const redisClient = {
    get: async (key: string) => redisData.get(key) ?? null,
    set: async (key: string, value: string) => { redisData.set(key, value); return 'OK'; },
    del: async (key: string) => { redisData.delete(key); return 1; },
    rPush: async (key: string, value: string) => {
      lists.set(key, [...(lists.get(key) ?? []), value]);
      return 1;
    },
    /**
     * The exact semantics of the worker's compare-and-delete abort script, so
     * the real abort-marker consumption path runs rather than being skipped.
     */
    eval: async (_script: string, options: { keys: string[]; arguments: string[] }) => {
      const [key] = options.keys;
      const [expected] = options.arguments;
      if (redisData.get(key) !== expected) return 0;
      redisData.delete(key);
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

  // The canonical journal: reconnect replay reads only from here, never from
  // the projection's own memory.
  const journalReader: EzerJournalReader = {
    readAfter: async (operationId, afterCursor) => journal.filter(entry =>
      entry.operationId === operationId
      && (afterCursor === null || compareEzerCursors(entry.cursor, afterCursor) > 0)),
    hasOperation: async () => true,
  };

  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerSeq = 0;
  const streaming = new EzerStreamingService({
    journal: journalReader,
    now,
    scheduleTimer: (fn, ms) => {
      timerSeq += 1;
      timers.set(timerSeq, { at: clock.now + ms, fn });
      return timerSeq;
    },
    cancelTimer: handle => { timers.delete(handle as number); },
  });

  const advance = (ms: number): void => {
    const target = clock.now + ms;
    for (;;) {
      let dueId: number | null = null;
      let due: { at: number; fn: () => void } | null = null;
      for (const [id, timer] of timers) {
        if (timer.at <= target && (!due || timer.at < due.at)) { due = timer; dueId = id; }
      }
      if (due === null || dueId === null) break;
      clock.now = due.at;
      timers.delete(dueId);
      due.fn();
    }
    clock.now = Math.max(clock.now, target);
  };

  const events: EzerEventEnvelope[] = [];
  await streaming.resume(OPERATION_ID, {
    id: 'subscriber-1',
    send: (event, payload) => {
      if (event === EZER_STREAM_EVENT) events.push(payload as EzerEventEnvelope);
    },
  });

  const routes = createEzerRecoveryRoutes({
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
  // The production startup call: the silence watch is armed before any request.
  routes.watchSilence();

  const ingest: Harness['ingest'] = overrides => {
    const envelope: EzerEventEnvelope = {
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
    };
    const result = streaming.ingest(envelope);
    if (result.accepted) journal.push(result.envelope);
    return result;
  };

  const drive = async (
    handler: (req: FlatRequest, res: Response) => Promise<void>,
    operationId: string,
    body: unknown,
  ) => {
    const { res, captured } = createResponse();
    await handler(createRequest(operationId, body), res);
    return captured;
  };

  return {
    streaming, routes, events, state, stoppedContainers, cancelMarks, clock,
    cursor: () => String(cursorValue),
    advance, ingest,
    postFailure: (body, operationId = OPERATION_ID) => drive(routes.postFailure, operationId, body),
    postRecovery: (body, operationId = OPERATION_ID) => drive(routes.postRecovery, operationId, body),
    getRecovery: (operationId = OPERATION_ID) => drive(routes.getRecovery, operationId, {}),
    reconnect: async (subscriberId, afterCursor) => {
      const received: EzerEventEnvelope[] = [];
      await streaming.resume(OPERATION_ID, {
        id: subscriberId,
        send: (event, payload) => {
          if (event === EZER_STREAM_EVENT) received.push(payload as EzerEventEnvelope);
        },
      }, afterCursor);
      return received;
    },
  };
}

function command(overrides: Body): Body {
  return { sessionId: 'session-1', requestId: 'req-1', ...overrides };
}

function providerFailure(failure: Body, overrides: Body = {}): Body {
  return command({ commandId: `cmd-${Math.random().toString(36).slice(2)}`, failure, ...overrides });
}

function errorOf(body: Body): Body {
  return body.error as Body;
}

function assertContractShape(error: Body): void {
  for (const field of CONTRACT_ERROR_FIELDS) {
    assert.equal(typeof error[field], 'string', `${field} must be present on the contract error object`);
    assert.ok((error[field] as string).length > 0, `${field} must not be empty`);
  }
}

describe('AC-S04-1 — actionable errors with a named or truthfully unknown cause', () => {
  test('a provider failure with no status reports an unknown cause rather than guessing one', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.events.length = 0;

    const response = await harness.postFailure(providerFailure({
      kind: 'provider', message: 'socket hang up', source: 'the Claude CLI',
    }));

    assert.equal(response.statusCode, 201);
    const error = errorOf(response.body);
    assertContractShape(error);
    assert.equal(error.code, 'PROVIDER_FAILED');
    // The cause is not determinable, and the contract's word for that is used.
    assert.equal(error.knownCause, 'unknown');
    assert.match(error.persistedState as string, new RegExp(`cursor ${harness.cursor()}`));
    assert.match(error.remainingActivity as string, /attempt-1 of execution exec-1 is still running/);
    assert.match(error.retryPath as string, /bounded recovery attempts remain/);
    const recovery = error.recovery as Body;
    assert.equal(recovery.failureClass, 'provider');
    assert.equal(recovery.credentialFault, false);
    assert.equal(recovery.quotaFault, false);

    // The same structured error reaches subscribers, with the contract fields.
    const published = harness.events.at(-1);
    assert.equal(published?.type, 'error');
    assert.equal(published?.diagnosticId, error.diagnosticId);
    assertContractShape(published?.error as unknown as Body);
  });

  test('a real credential 401 is distinguished from quota and carries no reset time', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.postFailure(providerFailure({
      kind: 'provider', status: 401, source: 'the Anthropic API',
      message: 'invalid x-api-key',
    }));

    const error = errorOf(response.body);
    assertContractShape(error);
    assert.equal(error.code, 'PROVIDER_CREDENTIAL_REJECTED');
    assert.match(error.knownCause as string, /rejected the request credential \(HTTP 401\)/);
    assert.match(error.message as string, /not quota exhaustion/);
    const recovery = error.recovery as Body;
    assert.equal(recovery.failureClass, 'credential');
    assert.equal(recovery.credentialFault, true);
    assert.equal(recovery.quotaFault, false);
    // A credential fault has no reset: waiting for one would be a false hope.
    assert.equal(recovery.retryAfterSeconds, null);
    assert.equal(recovery.retryNotBefore, null);
    assert.equal(recovery.resetSource, 'none');
    assert.equal(recovery.retryable, false);
    assert.match(error.retryPath as string, /Replace the provider credential/);
    assert.match(error.retryPath as string, /credentialRepaired":true/);
  });

  test('a GitHub 403 quota exhaustion carries the provider\'s actual reset time', async () => {
    const harness = await createHarness();
    harness.ingest();
    const resetEpochSeconds = Math.floor(START_MS / 1_000) + 900;

    const response = await harness.postFailure(providerFailure({
      kind: 'provider', status: 403, source: 'GitHub',
      message: 'API rate limit exceeded',
      headers: {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(resetEpochSeconds),
        'X-RateLimit-Limit': '5000',
        // An echoed credential must never be stored or reported.
        authorization: 'Bearer ghs_secret',
      },
    }));

    const error = errorOf(response.body);
    assertContractShape(error);
    assert.equal(error.code, 'PROVIDER_QUOTA_EXHAUSTED');
    assert.match(error.knownCause as string, /exhausted quota \(HTTP 403\)/);
    assert.match(error.message as string, /not a credential failure/);
    const recovery = error.recovery as Body;
    assert.equal(recovery.quotaFault, true);
    assert.equal(recovery.credentialFault, false);
    assert.equal(recovery.resetSource, 'ratelimit-reset-header');
    assert.equal(recovery.retryAfterSeconds, 900);
    assert.equal(recovery.retryNotBefore, new Date(resetEpochSeconds * 1_000).toISOString());
    assert.match(error.retryPath as string, new RegExp(`Do not retry before ${recovery.retryNotBefore}`));
    assert.equal(JSON.stringify(response.body).includes('ghs_secret'), false);
  });

  test('a 429 carries the Retry-After the provider actually supplied', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.postFailure(providerFailure({
      kind: 'provider', status: 429, source: 'the Anthropic API',
      headers: { 'Retry-After': '42' },
    }));

    const recovery = (errorOf(response.body).recovery) as Body;
    assert.equal(errorOf(response.body).code, 'PROVIDER_RATE_LIMITED');
    assert.equal(recovery.resetSource, 'retry-after-header');
    assert.equal(recovery.retryAfterSeconds, 42);
    assert.equal(recovery.retryNotBefore, new Date(START_MS + 42_000).toISOString());
  });

  test('a 403 with no rate-limit metadata is reported as neither credential nor quota', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.postFailure(providerFailure({
      kind: 'provider', status: 403, source: 'GitHub', message: 'Resource not accessible by integration',
    }));

    const error = errorOf(response.body);
    assert.equal(error.code, 'PROVIDER_FORBIDDEN');
    assert.equal(error.knownCause, 'unknown');
    assert.match(error.message as string, /neither a confirmed credential failure nor a confirmed quota failure/);
    const recovery = error.recovery as Body;
    assert.equal(recovery.credentialFault, false);
    assert.equal(recovery.quotaFault, false);
    // No provider reset exists, so the bound is declared as a local one.
    assert.equal(recovery.resetSource, 'bounded-local-backoff');
  });

  test('long silence escalates from a heartbeat to one structured error per episode', async () => {
    const harness = await createHarness();
    harness.streaming.registerOperation({ operationId: OPERATION_ID, requestId: 'req-1', sessionId: 'session-1' });
    harness.ingest();
    harness.events.length = 0;

    // Two heartbeat intervals of silence are still only liveness pings.
    harness.advance(20_000);
    assert.deepEqual(harness.events.map(event => event.type), ['heartbeat', 'heartbeat']);

    harness.advance(10_000);
    const escalation = harness.events.at(-1);
    assert.equal(escalation?.type, 'error');
    assertContractShape(escalation?.error as unknown as Body);
    assert.equal(escalation?.error?.code, 'PROVIDER_SILENT');
    assert.equal(escalation?.error?.knownCause, 'unknown');
    assert.match(escalation?.error?.message as string, /No observable activity has been published for 30000ms/);
    assert.match(escalation?.error?.remainingActivity as string, /attempt-1 of execution exec-1 is still running/);
    assert.match(escalation?.error?.retryPath as string, /Nothing was retried and nothing was stopped/);

    // Continued silence repeats the heartbeat but not the escalation.
    harness.advance(30_000);
    assert.equal(harness.events.filter(event => event.type === 'error').length, 1);

    // Real activity ends the episode; a new silence escalates again.
    harness.ingest({ summary: 'Activity resumed.' });
    harness.advance(30_000);
    assert.equal(harness.events.filter(event => event.type === 'error').length, 2);

    // Silence is an observation, not a fault: it spends no recovery budget.
    const state = (await harness.getRecovery()).body;
    assert.equal(state.technicalFailures, 0);
    assert.equal(state.attemptsRemaining, 3);
  });

  test('a timeout surfaces saved state, remaining activity and a bounded recovery path', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.postFailure(providerFailure(
      { kind: 'timeout', timeoutMs: 540_000 }, { taskId: TASK_ID },
    ));

    const error = errorOf(response.body);
    assertContractShape(error);
    assert.equal(error.code, 'EXECUTION_TIMEOUT');
    assert.match(error.knownCause as string, /exceeded its 540000ms execution lease/);
    assert.match(error.persistedState as string, new RegExp(`cursor ${harness.cursor()}`));
    assert.match(error.remainingActivity as string, /was fenced and aborted/);
    assert.match(error.retryPath as string, /resume-from-checkpoint/);
    assert.match(error.retryPath as string, /3 of 3 bounded recovery attempts remain/);
    assert.equal((error.recovery as Body).failureClass, 'timeout');
  });

  test('a malformed failure report is refused before anything is recorded', async () => {
    const harness = await createHarness();
    harness.ingest();

    const missingKind = await harness.postFailure(command({ commandId: 'cmd-bad-1', failure: { kind: 'guess' } }));
    assert.equal(missingKind.statusCode, 400);
    assert.equal(errorOf(missingKind.body).code, 'INVALID_FAILURE_REPORT');

    const missingSession = await harness.postFailure({ commandId: 'cmd-bad-2', failure: { kind: 'provider' } });
    assert.equal(missingSession.statusCode, 400);

    const state = (await harness.getRecovery()).body;
    assert.deepEqual(state.failures, []);
    assert.equal(state.technicalFailures, 0);
  });
});

describe('AC-S04-2 — reconnect, idempotency, the timeout fence and bounded recovery', () => {
  test('a timeout fences, aborts the owned marker, confirms cessation and records a terminal failure', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.events.length = 0;

    const response = await harness.postFailure(providerFailure(
      { kind: 'timeout', timeoutMs: 540_000 }, { taskId: TASK_ID, commandId: 'cmd-timeout-1' },
    ));

    assert.equal(response.statusCode, 201);
    assert.equal(response.body.fenced, true);
    assert.deepEqual(response.body.target, { executionId: 'exec-1', attemptId: 'attempt-1' });

    // The abort reached the real job: an owned marker, then the exact container.
    assert.deepEqual(harness.stoppedContainers, [CONTAINER_ID]);
    assert.deepEqual(harness.cancelMarks, [`${TASK_ID}:owner`]);

    const cessation = response.body.cessation as Body;
    assert.equal(cessation.stopped, true);
    assert.equal(cessation.workerState, 'cancelled');
    assert.equal(cessation.containerEvidence, 'absent');
    assert.equal(cessation.abortMarkerCleared, true);

    const terminal = response.body.terminalRecord as Body;
    assert.equal(terminal.state, 'failed');
    assert.equal(terminal.classification, 'technical-partial-failure');
    assert.equal(terminal.cessationConfirmed, true);
    assert.equal(terminal.fencesLateOutput, true);
    // The owned marker was written, and the worker's consumption was observed
    // rather than assumed: nothing is left outstanding.
    assert.deepEqual(terminal.abortMarker,
      { written: true, pending: false, consumed: true, taskId: TASK_ID });
    assert.equal(terminal.cancellationRecorded, true);

    // Late output from the timed-out attempt cannot publish.
    const late = harness.ingest({ summary: 'Late output from the timed-out attempt.' });
    assert.equal(late.accepted, false);
    assert.equal(late.accepted === false && late.reason, 'fenced-attempt');
    assert.deepEqual(harness.events.map(event => event.type), ['error']);
  });

  test('a timeout whose container cannot be stopped is never recorded as ceased', async () => {
    const harness = await createHarness();
    harness.state.containerStopSucceeds = false;
    harness.ingest();

    const response = await harness.postFailure(providerFailure(
      { kind: 'timeout', timeoutMs: 540_000 }, { taskId: TASK_ID, commandId: 'cmd-timeout-2' },
    ));

    const cessation = response.body.cessation as Body;
    assert.equal(cessation.stopped, false);
    assert.match(cessation.reason as string, /still up/);
    const terminal = response.body.terminalRecord as Body;
    assert.equal(terminal.cessationConfirmed, false);
    // The fence predates the stop, so late output is refused regardless.
    assert.equal(terminal.fencesLateOutput, true);
    assert.equal(harness.ingest().accepted, false);
  });

  test('a timeout with no task binding fences the attempt without claiming an abort', async () => {
    const harness = await createHarness();
    harness.ingest();

    const response = await harness.postFailure(providerFailure(
      { kind: 'timeout' }, { commandId: 'cmd-timeout-3' },
    ));

    const cessation = response.body.cessation as Body;
    assert.equal(cessation.stopped, false);
    assert.match(cessation.reason as string, /No ProPR task binding is known/);
    assert.deepEqual((response.body.terminalRecord as Body).abortMarker,
      { written: false, pending: false, consumed: false, taskId: null });
    assert.deepEqual(harness.stoppedContainers, []);
    assert.equal(harness.ingest().accepted, false);
  });

  test('disconnect and reconnect resume the journal cursor with no redelivery or duplicate action', async () => {
    const harness = await createHarness();
    harness.ingest({ summary: 'first' });
    const acknowledged = harness.cursor();
    harness.ingest({ summary: 'second' });
    harness.ingest({ type: 'result', summary: 'attempt finished' });

    const failure = await harness.postFailure(providerFailure(
      { kind: 'provider', status: 500, source: 'the Anthropic API' }, { commandId: 'cmd-reconnect-fail' },
    ));
    assert.equal(failure.statusCode, 201);

    // The client dropped its socket; it reconnects at its last acknowledged cursor.
    harness.streaming.detachSubscriber('subscriber-1');
    const replayed = await harness.reconnect('subscriber-2', acknowledged);
    assert.deepEqual(replayed.map(event => event.summary), ['second', 'attempt finished']);
    assert.ok(replayed.every(event => compareEzerCursors(event.cursor, acknowledged) > 0));

    // Past the bounded backoff the 500 imposed, so the retry itself is eligible.
    harness.clock.now += 61_000;
    // The same session retries under the same key; exactly one action is accepted.
    const retry = command({ commandId: 'cmd-reconnect-retry', action: 'retry' });
    const first = await harness.postRecovery(retry);
    assert.equal(first.statusCode, 202);
    assert.equal(first.body.granted, true);
    const replay = await harness.postRecovery(retry);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.deduplicated, true);
    assert.equal(replay.body.duplicateDeliveries, 1);
    assert.equal(replay.body.granted, true);

    const state = (await harness.getRecovery()).body;
    assert.equal(state.recoveriesGranted, 1);
    assert.equal((state.grants as unknown[]).length, 1);
    assert.equal(((first.body.recovery as Body).replayFrom), harness.cursor());
  });

  test('the same command key with a different payload is rejected and grants nothing', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ type: 'result', summary: 'attempt finished' });
    await harness.postFailure(providerFailure(
      { kind: 'provider', status: 500 }, { commandId: 'cmd-conflict-fail' },
    ));
    harness.clock.now += 61_000;
    const accepted = await harness.postRecovery(command({ commandId: 'cmd-conflict', action: 'retry' }));
    assert.equal(accepted.statusCode, 202);

    const conflict = await harness.postRecovery(command({
      commandId: 'cmd-conflict', action: 'resume-from-checkpoint',
    }));

    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.body.granted, false);
    assert.equal(errorOf(conflict.body).code, 'IDEMPOTENCY_CONFLICT');
    assert.ok(errorOf(conflict.body).retryPath);
    assert.equal((await harness.getRecovery()).body.recoveriesGranted, 1);

    // A failure report replayed under a key already used by a recovery conflicts too.
    const crossSurface = await harness.postFailure(command({
      commandId: 'cmd-conflict', failure: { kind: 'provider', status: 500 },
    }));
    assert.equal(crossSurface.statusCode, 409);
  });

  test('an identical failure report dedups instead of recording a second failure', async () => {
    const harness = await createHarness();
    harness.ingest();
    const report = command({
      commandId: 'cmd-dup-failure',
      failure: { kind: 'provider', status: 429, headers: { 'Retry-After': '30' }, source: 'the Anthropic API' },
    });

    const first = await harness.postFailure(report);
    // Key order inside the payload must not change the fingerprint.
    const replay = await harness.postFailure(command({
      commandId: 'cmd-dup-failure',
      failure: { source: 'the Anthropic API', headers: { 'retry-after': '30' }, status: 429, kind: 'provider' },
    }));

    assert.equal(replay.statusCode, 200);
    assert.equal(replay.body.deduplicated, true);
    assert.equal((replay.body.error as Body).diagnosticId, (first.body.error as Body).diagnosticId);
    const state = (await harness.getRecovery()).body;
    assert.equal(state.technicalFailures, 1);
    assert.equal((state.failures as unknown[]).length, 1);
  });

  test('a valid checkpoint recovery adds no author call and invents no approval or completion', async () => {
    const harness = await createHarness();
    harness.ingest();
    await harness.postFailure(providerFailure(
      { kind: 'timeout', timeoutMs: 540_000 }, { taskId: TASK_ID, commandId: 'cmd-ckpt-timeout' },
    ));
    const checkpointCursor = harness.cursor();

    const resumed = await harness.postRecovery(command({
      commandId: 'cmd-ckpt-resume', action: 'resume-from-checkpoint',
    }));

    assert.equal(resumed.statusCode, 202);
    assert.equal(resumed.body.granted, true);
    const recovery = resumed.body.recovery as Body;
    assert.equal(recovery.authorCallRequired, false);
    assert.match(recovery.authorCallReason as string, /no new author call is made/);
    assert.equal(recovery.resumeCursor, checkpointCursor);
    assert.equal(recovery.replayFrom, checkpointCursor);
    // The recovery resumes a cursor. It approves nothing and completes nothing.
    assert.equal(resumed.body.approvalGranted, false);
    assert.equal(resumed.body.completionClaimed, false);
    const state = (await harness.getRecovery()).body;
    assert.equal(state.approvalGranted, false);
    assert.equal(state.completionClaimed, false);
    assert.equal(state.checkpointValid, true);

    // A retry, by contrast, is honest that it needs a new author call.
    harness.ingest({ attemptId: 'attempt-2', type: 'result', summary: 'replacement finished' });
    const retried = await harness.postRecovery(command({ commandId: 'cmd-ckpt-retry', action: 'retry' }));
    assert.equal((retried.body.recovery as Body).authorCallRequired, true);
  });

  test('checkpoint recovery is refused once the journal has advanced past the saved cursor', async () => {
    const harness = await createHarness();
    harness.ingest();
    await harness.postFailure(providerFailure(
      { kind: 'timeout', timeoutMs: 540_000 }, { taskId: TASK_ID, commandId: 'cmd-stale-ckpt' },
    ));
    // A replacement attempt publishes and then finishes, moving the journal on.
    harness.ingest({ attemptId: 'attempt-2', type: 'result', summary: 'replacement finished' });

    const refused = await harness.postRecovery(command({
      commandId: 'cmd-stale-resume', action: 'resume-from-checkpoint',
    }));

    assert.equal(refused.statusCode, 202);
    assert.equal(refused.body.granted, false);
    assert.equal(errorOf(refused.body).code, 'CHECKPOINT_INVALID');
    assert.match(errorOf(refused.body).knownCause as string, /journal has advanced/);
    assert.match(errorOf(refused.body).retryPath as string, /does require a new author call/);
    assert.equal(refused.body.approvalGranted, false);
    assert.equal(refused.body.completionClaimed, false);
    assert.equal((await harness.getRecovery()).body.recoveriesGranted, 0);
  });

  test('recovery is bounded and no refusal or grant resets the recorded failure count', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ type: 'result', summary: 'attempt finished' });
    for (const index of [1, 2, 3, 4]) {
      await harness.postFailure(providerFailure(
        { kind: 'provider', status: 500, message: `attempt ${index}` }, { commandId: `cmd-bounded-fail-${index}` },
      ));
    }
    assert.equal((await harness.getRecovery()).body.technicalFailures, 4);
    harness.clock.now += 61_000;

    const granted: number[] = [];
    for (const index of [1, 2, 3]) {
      const response = await harness.postRecovery(command({ commandId: `cmd-bounded-${index}`, action: 'retry' }));
      assert.equal(response.body.granted, true);
      granted.push((response.body.recovery as Body).attemptsRemaining as number);
      // A granted recovery never decrements the recorded failure count.
      assert.equal((response.body.recovery as Body).technicalFailures, 4);
    }
    assert.deepEqual(granted, [2, 1, 0]);

    const exhausted = await harness.postRecovery(command({ commandId: 'cmd-bounded-4', action: 'retry' }));
    assert.equal(exhausted.statusCode, 409);
    assert.equal(exhausted.body.granted, false);
    assert.equal(errorOf(exhausted.body).code, 'RECOVERY_BUDGET_EXHAUSTED');
    assert.match(errorOf(exhausted.body).retryPath as string, /deliberately not reset/);

    const state = (await harness.getRecovery()).body;
    assert.equal(state.technicalFailures, 4);
    assert.equal(state.recoveriesGranted, 3);
    assert.equal(state.attemptsRemaining, 0);
  });

  test('a retry before the known quota reset is refused with that reset time', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ type: 'result', summary: 'attempt finished' });
    const resetEpochSeconds = Math.floor(START_MS / 1_000) + 900;
    await harness.postFailure(providerFailure({
      kind: 'provider', status: 403, source: 'GitHub', message: 'API rate limit exceeded',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) },
    }, { commandId: 'cmd-quota-fail' }));

    const early = await harness.postRecovery(command({ commandId: 'cmd-quota-early', action: 'retry' }));
    assert.equal(early.statusCode, 409);
    assert.equal(errorOf(early.body).code, 'RETRY_BEFORE_RESET');
    assert.match(errorOf(early.body).message as string, new RegExp(new Date(resetEpochSeconds * 1_000).toISOString()));
    assert.match(errorOf(early.body).retryPath as string, /ratelimit-reset-header/);
    assert.equal((await harness.getRecovery()).body.recoveriesGranted, 0);

    // After the provider's own reset time, the same key is accepted.
    harness.clock.now = resetEpochSeconds * 1_000;
    const afterReset = await harness.postRecovery(command({ commandId: 'cmd-quota-early', action: 'retry' }));
    assert.equal(afterReset.statusCode, 202);
    assert.equal(afterReset.body.granted, true);
    assert.equal((await harness.getRecovery()).body.recoveriesGranted, 1);
  });

  test('a later unrelated failure retires neither a live quota reset nor a credential repair', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ type: 'result', summary: 'attempt finished' });
    const resetEpochSeconds = Math.floor(START_MS / 1_000) + 3_600;
    await harness.postFailure(providerFailure({
      kind: 'provider', status: 429, source: 'the Anthropic API',
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) },
    }, { commandId: 'cmd-layer-quota' }));
    await harness.postFailure(providerFailure(
      { kind: 'provider', status: 401, source: 'the Anthropic API' }, { commandId: 'cmd-layer-credential' },
    ));
    // A later fault with a shorter bound must not look like the whole story.
    await harness.postFailure(providerFailure(
      { kind: 'provider', status: 500, source: 'the Anthropic API' }, { commandId: 'cmd-layer-500' },
    ));

    const state = (await harness.getRecovery()).body;
    assert.equal(state.credentialRepairRequired, true);
    assert.equal(state.retryNotBefore, new Date(resetEpochSeconds * 1_000).toISOString());

    // Past the 500's own bounded backoff, the standing gates still hold.
    harness.clock.now += 61_000;
    const credentialBlocked = await harness.postRecovery(command({ commandId: 'cmd-layer-a', action: 'retry' }));
    assert.equal(errorOf(credentialBlocked.body).code, 'RECOVERY_REQUIRES_CREDENTIAL_REPAIR');
    const quotaBlocked = await harness.postRecovery(command({
      commandId: 'cmd-layer-b', action: 'retry', credentialRepaired: true,
    }));
    assert.equal(errorOf(quotaBlocked.body).code, 'RETRY_BEFORE_RESET');
    assert.match(errorOf(quotaBlocked.body).message as string,
      new RegExp(new Date(resetEpochSeconds * 1_000).toISOString()));
    assert.equal((await harness.getRecovery()).body.recoveriesGranted, 0);

    // Past the provider's own reset, and with the repair asserted, it proceeds.
    harness.clock.now = resetEpochSeconds * 1_000;
    const granted = await harness.postRecovery(command({
      commandId: 'cmd-layer-c', action: 'retry', credentialRepaired: true,
    }));
    assert.equal(granted.body.granted, true);
    assert.equal((await harness.getRecovery()).body.credentialRepairRequired, false);
  });

  test('a retry after a credential rejection requires the credential to be repaired first', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ type: 'result', summary: 'attempt finished' });
    await harness.postFailure(providerFailure(
      { kind: 'provider', status: 401, source: 'the Anthropic API' }, { commandId: 'cmd-cred-fail' },
    ));

    const blind = await harness.postRecovery(command({ commandId: 'cmd-cred-retry', action: 'retry' }));
    assert.equal(blind.statusCode, 409);
    assert.equal(errorOf(blind.body).code, 'RECOVERY_REQUIRES_CREDENTIAL_REPAIR');
    assert.match(errorOf(blind.body).retryPath as string, /not a quota failure/);
    assert.equal((await harness.getRecovery()).body.recoveriesGranted, 0);

    const repaired = await harness.postRecovery(command({
      commandId: 'cmd-cred-retry-2', action: 'retry', credentialRepaired: true,
    }));
    assert.equal(repaired.statusCode, 202);
    assert.equal(repaired.body.granted, true);
  });

  test('a recovery is refused while an attempt is still publishing', async () => {
    const harness = await createHarness();
    harness.ingest();
    await harness.postFailure(providerFailure(
      { kind: 'provider', status: 500 }, { commandId: 'cmd-active-fail' },
    ));

    const refused = await harness.postRecovery(command({ commandId: 'cmd-active-retry', action: 'retry' }));

    assert.equal(refused.statusCode, 409);
    assert.equal(errorOf(refused.body).code, 'ATTEMPT_STILL_ACTIVE');
    assert.match(errorOf(refused.body).remainingActivity as string, /attempt-1 of execution exec-1 continues unchanged/);
    assert.equal((await harness.getRecovery()).body.recoveriesGranted, 0);

    // The refusal is resendable under the same key once its cause is cleared.
    harness.ingest({ type: 'result', summary: 'attempt finished' });
    harness.clock.now += 61_000;
    const granted = await harness.postRecovery(command({ commandId: 'cmd-active-retry', action: 'retry' }));
    assert.equal(granted.statusCode, 202);
    assert.equal(granted.body.granted, true);
  });

  test('a failure aimed at a superseded attempt is refused and changes nothing', async () => {
    const harness = await createHarness();
    harness.ingest();
    harness.ingest({ attemptId: 'attempt-2', summary: 'Replacement attempt started.' });

    const response = await harness.postFailure(command({
      commandId: 'cmd-stale-target', failure: { kind: 'timeout' },
      taskId: TASK_ID, executionId: 'exec-1', attemptId: 'attempt-1',
    }));

    assert.equal(response.statusCode, 409);
    assert.equal(errorOf(response.body).code, 'ATTEMPT_MISMATCH');
    assert.deepEqual(harness.stoppedContainers, []);
    // The replacement attempt keeps running and keeps publishing.
    assert.equal(harness.ingest({ attemptId: 'attempt-2' }).accepted, true);
    assert.deepEqual((await harness.getRecovery()).body.failures, []);
  });
});

describe('the failure and recovery plane over its registered HTTP routes', () => {
  /**
   * Mounts the handlers on the exact paths `server.ts` registers them under,
   * through the same `registerRouteEntries` helper, and drives them over real
   * HTTP — so the delivered behaviour is exercised on the live route surface
   * rather than only through directly invoked handler functions.
   */
  test('a timeout reported over HTTP stops the real container, then recovery resumes its cursor', async () => {
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
      ['post', '/api/ezer/operations/:operationId/failures', harness.routes.postFailure as never],
      ['post', '/api/ezer/operations/:operationId/recovery', harness.routes.postRecovery as never],
      ['get', '/api/ezer/operations/:operationId/recovery', harness.routes.getRecovery as never],
    ];
    assertNoDuplicateRoutes(routes);
    registerRouteEntries(app, routes);

    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.once('listening', resolve));
      const { port } = server.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}/api/ezer/operations/${OPERATION_ID}`;
      const json = { 'content-type': 'application/json' };

      const reported = await fetch(`${base}/failures`, {
        method: 'POST', headers: json,
        body: JSON.stringify(command({
          commandId: 'cmd-http-timeout', taskId: TASK_ID, failure: { kind: 'timeout', timeoutMs: 540_000 },
        })),
      });
      assert.equal(reported.status, 201);
      const failureBody = await reported.json() as Record<string, Body>;
      assert.equal(failureBody.error.code, 'EXECUTION_TIMEOUT');
      assert.equal((failureBody.terminalRecord).cessationConfirmed, true);

      const recovered = await fetch(`${base}/recovery`, {
        method: 'POST', headers: json,
        body: JSON.stringify(command({ commandId: 'cmd-http-resume', action: 'resume-from-checkpoint' })),
      });
      assert.equal(recovered.status, 202);
      const recoveryBody = await recovered.json() as Record<string, Body>;
      assert.equal(recoveryBody.recovery.authorCallRequired, false);
      assert.equal(recoveryBody.approvalGranted as unknown as boolean, false);

      const read = await fetch(`${base}/recovery`);
      assert.equal(read.status, 200);
      const state = await read.json() as Body;
      assert.equal(state.technicalFailures, 1);
      assert.equal(state.recoveriesGranted, 1);
      assert.deepEqual(state.fencedAttempts, [{ executionId: 'exec-1', attemptId: 'attempt-1' }]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }

    assert.deepEqual(harness.stoppedContainers, [CONTAINER_ID]);
    assert.deepEqual(harness.cancelMarks, [`${TASK_ID}:owner`]);
    assert.deepEqual(harness.events.map(event => event.type), ['error']);
  });
});

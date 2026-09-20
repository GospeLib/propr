import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { TASK_UPDATE, type TaskUpdatePayload } from '@propr/shared';
import {
  compareEzerCursors,
  EzerStreamingService,
  EZER_STREAM_EVENT,
  EZER_STREAM_SUBSCRIBED,
  type EzerEventEnvelope,
  type EzerJournalReader,
} from '../ep-ezer-follow-ups-s02.js';
import {
  loadDurableTaskRevision,
  readCachedTaskRevision,
  shouldBroadcastTaskUpdate,
  SocketService,
} from '../services/socketService.js';

after(async () => { await closeConnection(); });

describe('SocketService task update ordering', () => {
  test('accepts legacy events only before a versioned stream is established', () => {
    assert.equal(shouldBroadcastTaskUpdate(undefined, undefined), true);
    assert.equal(shouldBroadcastTaskUpdate(undefined, 1), true);
    assert.equal(shouldBroadcastTaskUpdate(5, undefined), false);
  });

  test('accepts a legacy event without seeding from durable versioned state', async () => {
    let durableReads = 0;
    const broadcasts: Array<{ rooms: string[]; payload: TaskUpdatePayload }> = [];
    const service = Object.create(SocketService.prototype) as SocketService;
    const internals = service as unknown as {
      io: {
        to: (room: string) => {
          to: (additionalRoom: string) => unknown;
          emit: (event: string, payload: TaskUpdatePayload) => void;
        };
      };
      queueDeps: {
        redisClient: { get: (key: string) => Promise<string | null> };
      };
      taskRevisions: Map<string, { version: number; expiresAt: number }>;
      handleTaskUpdate: (payload: TaskUpdatePayload) => Promise<void>;
    };
    internals.io = {
      to: room => {
        const rooms = [room];
        const operator = {
          to: (additionalRoom: string) => {
            rooms.push(additionalRoom);
            return operator;
          },
          emit: (_event: string, emittedPayload: TaskUpdatePayload) => {
            broadcasts.push({ rooms, payload: emittedPayload });
          },
        };
        return operator;
      },
    };
    internals.queueDeps = {
      redisClient: {
        get: async () => {
          durableReads += 1;
          return JSON.stringify({ version: 20 });
        },
      },
    };
    internals.taskRevisions = new Map();
    const payload: TaskUpdatePayload = {
      eventType: TASK_UPDATE,
      taskId: 'legacy-task',
      state: 'processing',
      timestamp: new Date(0).toISOString(),
    };

    await internals.handleTaskUpdate(payload);

    assert.equal(durableReads, 0);
    assert.deepEqual(broadcasts, [
      { rooms: ['instance:operational', 'task:legacy-task'], payload },
    ]);
  });

  test('rejects malformed incoming revisions before they can poison the cache', () => {
    assert.equal(shouldBroadcastTaskUpdate(undefined, -1), false);
    assert.equal(shouldBroadcastTaskUpdate(undefined, 1.5), false);
    assert.equal(shouldBroadcastTaskUpdate(undefined, Number.MAX_SAFE_INTEGER + 1), false);
  });

  test('permits equality only for the first event after a durable seed', () => {
    assert.equal(shouldBroadcastTaskUpdate(5, 4), false);
    assert.equal(shouldBroadcastTaskUpdate(5, 5), false);
    assert.equal(shouldBroadcastTaskUpdate(5, 5, true), true);
    assert.equal(shouldBroadcastTaskUpdate(5, 6), true);
  });

  test('expires socket revision cache entries so recreated task IDs can reseed', () => {
    const entry = { version: 42, expiresAt: 30_000 };

    assert.equal(readCachedTaskRevision(entry, 29_999), 42);
    assert.equal(readCachedTaskRevision(entry, 30_000), undefined);
  });

  test('seeds ordering from durable task state after restart or cache eviction', async () => {
    const values = new Map([
      ['worker:state:task-1', JSON.stringify({ version: 20 })],
    ]);

    const revision = await loadDurableTaskRevision(async key => values.get(key) ?? null, 'task-1');

    assert.equal(revision, 20);
    assert.equal(shouldBroadcastTaskUpdate(revision, 19), false);
    assert.equal(shouldBroadcastTaskUpdate(revision, 20, true), true);
    assert.equal(shouldBroadcastTaskUpdate(revision, 20), false);
    assert.equal(shouldBroadcastTaskUpdate(revision, 21), true);
  });

  test('uses the configured worker-state key namespaces', async () => {
    const requestedKeys: string[] = [];
    const revision = await loadDurableTaskRevision(async key => {
      requestedKeys.push(key);
      return JSON.stringify({ version: 8 });
    }, 'task-custom', {
      keyPrefix: 'custom:state:',
    });

    assert.deepEqual(requestedKeys, ['custom:state:task-custom']);
    assert.equal(revision, 8);
  });

  test('ignores negative, fractional, and unsafe durable revisions', async () => {
    for (const malformed of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const revision = await loadDurableTaskRevision(
        async () => JSON.stringify({ version: malformed }),
        'task-malformed',
      );
      assert.equal(revision, undefined);
    }
  });
});

interface EzerHarness {
  service: EzerStreamingService;
  advance: (ms: number) => void;
  subscriber: (id: string) => {
    id: string;
    received: Array<{ event: string; payload: EzerEventEnvelope | Record<string, unknown> }>;
    send: (event: string, payload: unknown) => void;
  };
}

function createEzerHarness(options: { journal?: EzerJournalReader } = {}): EzerHarness {
  const clock = { now: 0 };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let timerSeq = 0;
  const service = new EzerStreamingService({
    journal: options.journal,
    now: () => clock.now,
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
    clock.now = target;
  };
  const subscriber = (id: string) => {
    const received: Array<{ event: string; payload: EzerEventEnvelope | Record<string, unknown> }> = [];
    return {
      id, received,
      send: (event: string, payload: unknown) => { received.push({ event, payload: payload as EzerEventEnvelope }); },
    };
  };
  return { service, advance, subscriber };
}

function envelope(overrides: Partial<EzerEventEnvelope> = {}): EzerEventEnvelope {
  return {
    type: 'progress', requestId: 'req-1', sessionId: 'ses-1', operationId: 'op-1',
    executionId: 'exe-1', attemptId: 'att-1', cursor: '1',
    ts: '1970-01-01T00:00:00.000Z', summary: 'working', ...overrides,
  };
}

function streamed(sub: ReturnType<EzerHarness['subscriber']>): EzerEventEnvelope[] {
  return sub.received
    .filter(entry => entry.event === EZER_STREAM_EVENT)
    .map(entry => entry.payload as EzerEventEnvelope);
}

describe('EP-ezer-follow-ups-S02 incremental progress streaming (TC-005 lane)', () => {
  test('acknowledges a subscription immediately and heartbeats through provider silence', async () => {
    const { service, advance, subscriber } = createEzerHarness();
    service.registerOperation({ operationId: 'op-1', requestId: 'req-1', sessionId: 'ses-1' });
    const sub = subscriber('viewer-1');
    await service.resume('op-1', sub);

    assert.equal(sub.received[0]?.event, EZER_STREAM_SUBSCRIBED);
    assert.equal((sub.received[0]?.payload as Record<string, unknown>).operationId, 'op-1');
    assert.equal((sub.received[0]?.payload as Record<string, unknown>).pending, true);

    advance(9_999);
    assert.equal(streamed(sub).length, 0);
    advance(1);
    const [firstHeartbeat] = streamed(sub);
    assert.equal(firstHeartbeat.type, 'heartbeat');
    assert.equal(firstHeartbeat.requestId, 'req-1');
    assert.equal(firstHeartbeat.sessionId, 'ses-1');
    assert.equal(firstHeartbeat.operationId, 'op-1');
    assert.ok(firstHeartbeat.diagnosticId);
    assert.match(firstHeartbeat.summary, /still pending/);

    advance(10_000);
    const heartbeats = streamed(sub).filter(event => event.type === 'heartbeat');
    assert.equal(heartbeats.length, 2);
    assert.notEqual(heartbeats[0].diagnosticId, heartbeats[1].diagnosticId);
  });

  test('real progress resets the heartbeat clock and is delivered within the same tick', async () => {
    const { service, advance, subscriber } = createEzerHarness();
    service.registerOperation({ operationId: 'op-1' });
    const sub = subscriber('viewer-1');
    await service.resume('op-1', sub);

    advance(9_000);
    const result = service.ingest(envelope({
      cursor: '1',
      ts: new Date(9_000).toISOString(),
      detail: { kind: 'start' },
    }));
    assert.equal(result.accepted, true);
    // Delivery is synchronous with ingestion: no simulated latency at all,
    // well inside the 2s design target.
    assert.equal(streamed(sub).length, 1);
    assert.equal(service.getMetrics().maxProjectionDelayMs, 0);

    advance(9_999);
    assert.equal(streamed(sub).filter(event => event.type === 'heartbeat').length, 0);
    advance(1);
    const heartbeats = streamed(sub).filter(event => event.type === 'heartbeat');
    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].cursor, '1');
    assert.equal(heartbeats[0].executionId, 'exe-1');
    assert.equal(heartbeats[0].attemptId, 'att-1');
  });

  test('delivers delay, retry, and blocker transitions with their actionable detail', async () => {
    const { service, subscriber } = createEzerHarness();
    const sub = subscriber('viewer-1');
    await service.resume('op-1', sub);

    service.ingest(envelope({ cursor: '1', detail: { kind: 'start' }, summary: 'accepted' }));
    service.ingest(envelope({ cursor: '2', detail: { kind: 'delay', reason: 'provider silent' } }));
    service.ingest(envelope({
      cursor: '3',
      detail: { kind: 'retry', reason: 'provider timeout', nextAttemptAt: '1970-01-01T00:01:00.000Z' },
    }));
    service.ingest(envelope({
      cursor: '4',
      detail: { kind: 'blocker', cause: 'quota exhausted', nextAction: 'waiting for reset' },
    }));

    const events = streamed(sub);
    assert.deepEqual(events.map(event => event.detail?.kind), ['start', 'delay', 'retry', 'blocker']);
    assert.equal(events[2].detail?.reason, 'provider timeout');
    assert.equal(events[2].detail?.nextAttemptAt, '1970-01-01T00:01:00.000Z');
    assert.equal(events[3].detail?.cause, 'quota exhausted');
    assert.equal(events[3].detail?.nextAction, 'waiting for reset');
  });

  test('never replays a completed answer as incremental output and stops heartbeats after the result', async () => {
    const { service, advance, subscriber } = createEzerHarness();
    const sub = subscriber('viewer-1');
    await service.resume('op-1', sub);

    service.ingest(envelope({ cursor: '1', detail: { kind: 'start' } }));
    service.ingest(envelope({ type: 'result', cursor: '2', summary: 'final answer saved' }));

    const lateProgress = service.ingest(envelope({ cursor: '3', summary: 'replayed chunk' }));
    assert.deepEqual(lateProgress, { accepted: false, reason: 'completed-answer-replay' });
    const duplicateResult = service.ingest(envelope({ type: 'result', cursor: '4', summary: 'final again' }));
    assert.deepEqual(duplicateResult, { accepted: false, reason: 'duplicate-result' });

    advance(30_000);
    const events = streamed(sub);
    assert.deepEqual(events.map(event => event.type), ['progress', 'result']);
    assert.equal(events.filter(event => event.type === 'heartbeat').length, 0);
  });

  test('strips undeclared fields so hidden reasoning cannot transit the projection', async () => {
    const { service, subscriber } = createEzerHarness();
    const sub = subscriber('viewer-1');
    await service.resume('op-1', sub);

    const result = service.ingest({
      ...envelope({ cursor: '1' }),
      reasoning: 'secret chain of thought',
      detail: { kind: 'intermediate', reason: 'safe', chainOfThought: 'secret' },
    });

    assert.equal(result.accepted, true);
    const [event] = streamed(sub);
    assert.equal('reasoning' in event, false);
    assert.equal(event.detail?.reason, 'safe');
    assert.equal('chainOfThought' in (event.detail ?? {}), false);
  });

  test('refuses envelopes missing required correlation fields', () => {
    const { service } = createEzerHarness();
    const missingAttempt = { ...envelope(), attemptId: undefined };
    assert.deepEqual(service.ingest(missingAttempt), { accepted: false, reason: 'missing-field' });
    assert.deepEqual(service.ingest('not-an-envelope'), { accepted: false, reason: 'malformed' });
    assert.deepEqual(
      service.ingest(envelope({ ts: 'not-a-timestamp' })),
      { accepted: false, reason: 'invalid-timestamp' },
    );
  });
});

describe('EP-ezer-follow-ups-S02 cursor continuity and reconnect (TC-006 lane)', () => {
  test('orders cursors numerically and by length for opaque encodings', () => {
    assert.ok(compareEzerCursors('2', '10') < 0);
    assert.ok(compareEzerCursors('0010', '9') > 0);
    assert.equal(compareEzerCursors('7', '7'), 0);
    assert.ok(compareEzerCursors('a-2', 'a-10') < 0);
  });

  test('enforces monotonic cursors with no duplicate deliveries', async () => {
    const { service, subscriber } = createEzerHarness();
    const sub = subscriber('viewer-1');
    await service.resume('op-1', sub);

    assert.equal(service.ingest(envelope({ cursor: '2' })).accepted, true);
    assert.deepEqual(service.ingest(envelope({ cursor: '2' })), { accepted: false, reason: 'stale-cursor' });
    assert.deepEqual(service.ingest(envelope({ cursor: '1' })), { accepted: false, reason: 'stale-cursor' });

    assert.equal(streamed(sub).length, 1);
    assert.equal(service.getMetrics().dropped, 2);
  });

  test('resumes from the acknowledged cursor via journal replay without redelivery', async () => {
    const journalEvents = [
      envelope({ cursor: '1', detail: { kind: 'start' } }),
      envelope({ cursor: '2', detail: { kind: 'intermediate' } }),
      envelope({ type: 'result', cursor: '3', summary: 'final answer' }),
    ];
    const readRequests: Array<string | null> = [];
    const journal: EzerJournalReader = {
      readAfter: async (_operationId, afterCursor) => {
        readRequests.push(afterCursor);
        return journalEvents.filter(event => afterCursor === null || compareEzerCursors(event.cursor, afterCursor) > 0);
      },
      hasOperation: async () => true,
    };
    const { service, subscriber } = createEzerHarness({ journal });

    const sub = subscriber('reconnecting-cli');
    await service.resume('op-1', sub, '1');

    assert.deepEqual(readRequests, ['1']);
    const events = streamed(sub);
    assert.deepEqual(events.map(event => event.cursor), ['2', '3']);
    // The completed answer arrives exactly once, typed as the terminal result,
    // never re-chunked into synthetic incremental progress.
    assert.deepEqual(events.map(event => event.type), ['progress', 'result']);
  });

  test('holds live events during replay and flushes them in order without duplicates', async () => {
    let resolveReplay: (events: unknown[]) => void = () => {};
    const journal: EzerJournalReader = {
      readAfter: () => new Promise(resolve => { resolveReplay = resolve; }),
    };
    const { service, subscriber } = createEzerHarness({ journal });
    const sub = subscriber('viewer-1');

    const resuming = service.resume('op-1', sub, '0');
    // A real state change lands while the journal replay is still in flight.
    service.ingest(envelope({ cursor: '3', summary: 'live event' }));
    resolveReplay([
      envelope({ cursor: '1', detail: { kind: 'start' } }),
      envelope({ cursor: '2', detail: { kind: 'intermediate' } }),
    ]);
    await resuming;

    assert.deepEqual(streamed(sub).map(event => event.cursor), ['1', '2', '3']);
  });

  test('fences superseded attempts so a stale attempt cannot publish into its replacement', async () => {
    const { service, subscriber } = createEzerHarness();
    const sub = subscriber('viewer-1');
    await service.resume('op-1', sub);

    assert.equal(service.ingest(envelope({ cursor: '1', attemptId: 'att-1' })).accepted, true);
    assert.equal(service.ingest(envelope({ cursor: '2', attemptId: 'att-2' })).accepted, true);
    assert.deepEqual(
      service.ingest(envelope({ cursor: '3', attemptId: 'att-1' })),
      { accepted: false, reason: 'fenced-attempt' },
    );
    assert.deepEqual(streamed(sub).map(event => event.attemptId), ['att-1', 'att-2']);
  });

  test('an explicitly fenced attempt is refused even before a replacement exists', () => {
    const { service } = createEzerHarness();
    service.fenceAttempt('op-9', 'exe-1', 'att-1');
    assert.deepEqual(
      service.ingest(envelope({ operationId: 'op-9', cursor: '1', attemptId: 'att-1' })),
      { accepted: false, reason: 'fenced-attempt' },
    );
  });

  test('refuses replay honestly when no journal reader is configured, then keeps streaming live', async () => {
    const { service, subscriber } = createEzerHarness();
    const sub = subscriber('reconnecting-cli');
    await service.resume('op-1', sub, '4');

    const [refusal] = streamed(sub);
    assert.equal(refusal.type, 'error');
    assert.equal(refusal.error?.code, 'REPLAY_UNAVAILABLE');
    assert.ok(refusal.error?.retryPath);
    assert.ok(refusal.error?.persistedState);

    assert.equal(service.ingest(envelope({ cursor: '5', summary: 'live after refusal' })).accepted, true);
    const events = streamed(sub);
    assert.equal(events.length, 2);
    assert.equal(events[1].cursor, '5');
  });

  test('authorizes subscriptions like task rooms: known operations, owner-scoped when recorded', async () => {
    const { service } = createEzerHarness();
    const owner = { user: { id: 'user-1' }, authorization: { permissions: [] as string[] } };
    const other = { user: { id: 'user-2' }, authorization: { permissions: [] as string[] } };
    const admin = { user: { id: 'user-3' }, authorization: { permissions: ['instance.manage_settings'] } };

    assert.equal(await service.authorizeSubscription('missing-op', owner), false);
    service.registerOperation({ operationId: 'op-open' });
    assert.equal(await service.authorizeSubscription('op-open', other), true);
    service.registerOperation({ operationId: 'op-owned', ownerUserId: 'user-1' });
    assert.equal(await service.authorizeSubscription('op-owned', owner), true);
    assert.equal(await service.authorizeSubscription('op-owned', other), false);
    assert.equal(await service.authorizeSubscription('op-owned', admin), true);
  });
});

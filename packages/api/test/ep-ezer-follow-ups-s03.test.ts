/* eslint-disable max-lines -- TC-007 and TC-008 require every positive,
   negative, duplicate and race condition to be exercised; they share the
   fixtures above and are kept in the mapped test file. */
/**
 * EP-ezer-follow-ups-S03 — TC-007 (control acknowledgement vs. real cessation)
 * and TC-008 (steering) at the control-plane layer.
 *
 * The production `EzerControlService`, its HTTP handlers and the real S02
 * projection run unmodified. The execution control port is a fixture that
 * returns the same outcome shapes `ExecutionControlRegistry` produces, so the
 * contract obligations — ack is never completion, exact-attempt targeting,
 * idempotency, and ordered accepted-vs-applied steering — are exercised here
 * while `packages/core/test/ep-ezer-follow-ups-s03.test.ts` exercises the real
 * marker/child/container cessation underneath them.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import express from 'express';
import { closeConnection } from '@propr/core';
import type {
  AttemptCancellationOutcome,
  AttemptPauseOutcome,
  AttemptResumeOutcome,
  AttemptSteerOutcome,
} from '@propr/core';
import {
  EzerStreamingService,
  EZER_STREAM_EVENT,
  sanitizeEzerEnvelope,
  type EzerEventEnvelope,
} from '../ep-ezer-follow-ups-s02.js';
import {
  createEzerControlRoutes,
  ezerIdempotencyKey,
  ezerPayloadFingerprint,
  parseEzerControlCommand,
  EzerControlService,
  EZER_CONTROL_ACK_TARGET_MS,
  type EzerControlCommand,
  type EzerControlStream,
  type EzerExecutionControlPort,
} from '../routes/ep-ezer-follow-ups-s03.js';

after(async () => { await closeConnection(); });

const OPERATION_ID = 'op-311';
const EXECUTION_ID = 'execution-7';
const ATTEMPT_A = 'attempt-a';
const ATTEMPT_B = 'attempt-b';

function command(overrides: Partial<EzerControlCommand> & Pick<EzerControlCommand, 'type' | 'commandId'>): EzerControlCommand {
  return {
    requestId: 'req-1',
    sessionId: 'session-1',
    operationId: OPERATION_ID,
    executionId: EXECUTION_ID,
    attemptId: ATTEMPT_A,
    ...overrides,
  };
}

const STOPPED: AttemptCancellationOutcome = {
  outcome: 'stopped',
  joinedInFlight: false,
  evidence: {
    markerPublished: true, markerCleared: true, childExited: true,
    containersRemaining: [], containersObserved: true, elapsedMs: 42,
  },
};

const STILL_RUNNING: AttemptCancellationOutcome = {
  outcome: 'still-running',
  joinedInFlight: false,
  reason: 'Cessation was not confirmed within 10000ms: container(s) still present: container-stuck.',
  recovery: 'Re-issue the cancel with a new commandId, or stop the task directly.',
  evidence: {
    markerPublished: true, markerCleared: false, childExited: false,
    containersRemaining: ['container-stuck'], containersObserved: true, elapsedMs: 10_000,
  },
};

interface PortCall { method: string; executionId: string; attemptId: string; version?: number; payload?: unknown }

/** Execution control fixture mirroring `ExecutionControlRegistry`'s contract. */
class FakePort implements EzerExecutionControlPort {
  readonly calls: PortCall[] = [];
  activeAttemptId: string | null = ATTEMPT_A;
  cancelOutcome: AttemptCancellationOutcome = STOPPED;
  pauseOutcome: AttemptPauseOutcome = {
    outcome: 'suspended', suspendedContainers: ['container-one'],
    persistedState: 'frozen in place', caveat: 'peers may time out',
  };
  resumeOutcome: AttemptResumeOutcome = { outcome: 'resumed', mode: 'unpaused', detail: 'thawed' };
  steerOutcome: AttemptSteerOutcome | ((version: number) => AttemptSteerOutcome) =
    version => ({ outcome: 'delivered', version });
  /** When set, control calls block until it is resolved. */
  gate: Promise<void> | null = null;

  getActiveAttemptId(): string | null { return this.activeAttemptId; }

  private async record<T>(call: PortCall, outcome: T): Promise<T> {
    this.calls.push(call);
    if (this.gate) await this.gate;
    return outcome;
  }

  cancel(executionId: string, attemptId: string): Promise<AttemptCancellationOutcome> {
    return this.record({ method: 'cancel', executionId, attemptId }, this.cancelOutcome);
  }

  pause(executionId: string, attemptId: string): Promise<AttemptPauseOutcome> {
    return this.record({ method: 'pause', executionId, attemptId }, this.pauseOutcome);
  }

  resume(executionId: string, attemptId: string): Promise<AttemptResumeOutcome> {
    return this.record({ method: 'resume', executionId, attemptId }, this.resumeOutcome);
  }

  steer(executionId: string, attemptId: string, version: number, payload: unknown): Promise<AttemptSteerOutcome> {
    const outcome = typeof this.steerOutcome === 'function' ? this.steerOutcome(version) : this.steerOutcome;
    return this.record({ method: 'steer', executionId, attemptId, version, payload }, outcome);
  }
}

interface FenceCall { operationId: string; executionId: string; attemptId: string }

class FakeStream implements EzerControlStream {
  readonly fences: FenceCall[] = [];
  readonly envelopes: EzerEventEnvelope[] = [];
  fenceAttempt(operationId: string, executionId: string, attemptId: string): void {
    this.fences.push({ operationId, executionId, attemptId });
  }
  broadcastProjection(_operationId: string, envelope: EzerEventEnvelope): void {
    this.envelopes.push(envelope);
  }
  getLastCursor(): string | null { return '000000000042'; }
}

function createService(): { service: EzerControlService; port: FakePort; stream: FakeStream } {
  const port = new FakePort();
  const stream = new FakeStream();
  return { service: new EzerControlService({ port, stream }), port, stream };
}

/** Every emitted envelope must survive the S02 contract sanitizer unchanged. */
function assertContractEnvelope(envelope: EzerEventEnvelope): void {
  const { envelope: sanitized, reason } = sanitizeEzerEnvelope(envelope);
  assert.equal(reason, undefined, `envelope rejected by the contract sanitizer: ${reason}`);
  assert.equal(sanitized!.operationId, envelope.operationId);
  assert.equal(sanitized!.summary, envelope.summary);
}

describe('AC-S03-1 acknowledgement is distinct from confirmed cessation', () => {
  test('acknowledges a cancel immediately and confirms the stop only later', async () => {
    const { service, port, stream } = createService();
    let openGate = (): void => undefined;
    port.gate = new Promise<void>(resolve => { openGate = resolve; });

    const ack = await service.submit(command({ type: 'cancel', commandId: 'cmd-1' }));

    assert.equal(ack.accepted, true);
    assert.equal(ack.state, 'accepted');
    assert.equal(ack.confirmation, 'pending');
    assert.equal(ack.deduplicated, false);
    assert.ok(ack.ackLatencyMs <= EZER_CONTROL_ACK_TARGET_MS);
    assert.equal(ack.envelope.type, 'control-ack');
    assert.equal(ack.envelope.attemptId, ATTEMPT_A);
    // An ack is never a completion: nothing is confirmed yet.
    assert.equal(service.getConfirmation('cmd-1'), null);
    assert.doesNotMatch(ack.envelope.summary, /stopped/);
    assertContractEnvelope(ack.envelope);

    openGate();
    const confirmation = await service.settle('cmd-1');

    assert.equal(confirmation!.state, 'stopped');
    assert.equal(confirmation!.envelope.type, 'result');
    assert.deepEqual(confirmation!.evidence, STOPPED.evidence);
    assertContractEnvelope(confirmation!.envelope);
    // Ack first, confirmation second — two separate observable events.
    assert.deepEqual(stream.envelopes.map(entry => entry.type), ['control-ack', 'result']);
  });

  test('fences the targeted attempt at acknowledgement, before any replacement', async () => {
    const { service, port, stream } = createService();
    let openGate = (): void => undefined;
    port.gate = new Promise<void>(resolve => { openGate = resolve; });

    await service.submit(command({ type: 'cancel', commandId: 'cmd-fence' }));

    assert.deepEqual(stream.fences, [
      { operationId: OPERATION_ID, executionId: EXECUTION_ID, attemptId: ATTEMPT_A },
    ]);
    openGate();
    await service.settle('cmd-fence');
  });

  test('reports still-running with reason and recovery rather than a false stop', async () => {
    const { service, port } = createService();
    port.cancelOutcome = STILL_RUNNING;

    await service.submit(command({ type: 'cancel', commandId: 'cmd-2' }));
    const confirmation = await service.settle('cmd-2');

    assert.equal(confirmation!.state, 'still-running');
    assert.doesNotMatch(confirmation!.summary, /stopped/);
    assert.equal(confirmation!.reason, STILL_RUNNING.reason);
    assert.equal(confirmation!.recovery, STILL_RUNNING.recovery);
    assert.equal(confirmation!.envelope.detail?.kind, 'blocker');
    assert.ok(confirmation!.envelope.detail?.cause);
    assert.ok(confirmation!.envelope.detail?.nextAction);
    assertContractEnvelope(confirmation!.envelope);
  });

  test('surfaces a refusal from the execution as refused, never as stopped', async () => {
    const { service, port } = createService();
    port.cancelOutcome = {
      outcome: 'refused', reason: 'attempt-completed',
      detail: 'the attempt already reached a terminal result',
      recovery: 'read the terminal result from the journal',
    };

    await service.submit(command({ type: 'cancel', commandId: 'cmd-3' }));
    const confirmation = await service.settle('cmd-3');

    assert.equal(confirmation!.state, 'refused');
    assert.match(confirmation!.summary, /was refused; nothing was stopped/);
  });

  test('reports a propagation failure without claiming any state change', async () => {
    const { service, port } = createService();
    port.cancel = () => Promise.reject(new Error('docker socket unavailable'));

    await service.submit(command({ type: 'cancel', commandId: 'cmd-4' }));
    const confirmation = await service.settle('cmd-4');

    assert.equal(confirmation!.state, 'still-running');
    assert.match(confirmation!.reason!, /docker socket unavailable/);
    assertContractEnvelope(confirmation!.envelope);
  });

  test('never reports a refused pause as paused', async () => {
    const { service, port } = createService();
    port.pauseOutcome = {
      outcome: 'refused', reason: 'pause-unsupported',
      detail: 'neither suspension nor a safe checkpoint is supported, so it is still running',
      recovery: 'let it finish, or cancel and restart',
    };

    await service.submit(command({ type: 'pause', commandId: 'cmd-5' }));
    const confirmation = await service.settle('cmd-5');

    assert.equal(confirmation!.state, 'refused');
    assert.match(confirmation!.summary, /was NOT paused and is still running/);
    assert.equal(confirmation!.recovery, 'let it finish, or cancel and restart');
  });

  test('reports a checkpoint as saved and a suspension as frozen', async () => {
    const { service, port } = createService();
    await service.submit(command({ type: 'pause', commandId: 'cmd-suspend' }));
    const suspended = await service.settle('cmd-suspend');

    port.pauseOutcome = {
      outcome: 'checkpointed', suspendedContainers: [],
      persistedState: 'Saved partial analysis at step 4 of 9.',
    };
    await service.submit(command({ type: 'pause', commandId: 'cmd-checkpoint' }));
    const checkpointed = await service.settle('cmd-checkpoint');

    assert.equal(suspended!.state, 'suspended');
    assert.match(suspended!.summary, /safely suspended in place/);
    assert.equal(checkpointed!.state, 'checkpointed');
    assert.match(checkpointed!.summary, /checkpointed and stopped; its state is saved/);
  });

  test('passes a one-only resume refusal through without inventing a continuation', async () => {
    const { service, port } = createService();
    await service.submit(command({ type: 'resume', commandId: 'cmd-resume-1' }));
    const first = await service.settle('cmd-resume-1');

    port.resumeOutcome = {
      outcome: 'refused', reason: 'already-resumed',
      detail: 'the checkpoint has already been claimed for continuation',
      recovery: 'track the continuation that was already started',
    };
    await service.submit(command({ type: 'resume', commandId: 'cmd-resume-2' }));
    const second = await service.settle('cmd-resume-2');

    assert.equal(first!.state, 'resumed');
    assert.equal(second!.state, 'refused');
    assert.match(second!.summary, /no continuation was started/);
  });
});

describe('AC-S03-1 commands target the exact active attempt', () => {
  test('rejects a command for a superseded attempt without redirecting it', async () => {
    const { service, port, stream } = createService();
    port.activeAttemptId = ATTEMPT_B;

    const ack = await service.submit(command({ type: 'cancel', commandId: 'cmd-6', attemptId: ATTEMPT_A }));

    assert.equal(ack.accepted, false);
    assert.equal(ack.rejection!.code, 'ATTEMPT_NOT_ACTIVE');
    assert.match(ack.rejection!.message, /NOT redirected to attempt attempt-b/);
    assert.equal((ack.rejection as unknown as { activeAttemptId: string }).activeAttemptId, ATTEMPT_B);
    // Nothing was propagated and the replacement was not fenced.
    assert.deepEqual(port.calls, []);
    assert.deepEqual(stream.fences, []);
    assert.equal(ack.envelope.type, 'error');
    assertContractEnvelope(ack.envelope);
  });

  test('rejects a command for an execution that is not controlled here', async () => {
    const { service, port } = createService();
    port.activeAttemptId = null;

    const ack = await service.submit(command({ type: 'cancel', commandId: 'cmd-7' }));

    assert.equal(ack.rejection!.code, 'EXECUTION_NOT_FOUND');
    assert.deepEqual(port.calls, []);
  });

  test('rejects every command when no control port is bound', async () => {
    const service = new EzerControlService({ stream: new FakeStream() });

    const ack = await service.submit(command({ type: 'cancel', commandId: 'cmd-8' }));

    assert.equal(ack.rejection!.code, 'CONTROL_UNAVAILABLE');
    assert.equal(ack.rejection!.remainingActivity, 'The targeted execution continues exactly as before this command.');
  });

  test('carries every contract error field on a rejection', async () => {
    const { service, port } = createService();
    port.activeAttemptId = null;

    const { rejection } = await service.submit(command({ type: 'cancel', commandId: 'cmd-9' }));

    for (const field of ['code', 'message', 'diagnosticId', 'knownCause', 'persistedState', 'remainingActivity', 'retryPath'] as const) {
      assert.ok(rejection![field], `rejection is missing ${field}`);
    }
  });
});

describe('AC-S03-1 idempotency: duplicates dedup and conflicts reject', () => {
  test('dedups an identical command to the original ack with no second effect', async () => {
    const { service, port } = createService();
    const first = await service.submit(command({ type: 'cancel', commandId: 'cmd-dup' }));
    await service.settle('cmd-dup');

    const second = await service.submit(command({ type: 'cancel', commandId: 'cmd-dup' }));

    assert.equal(second.accepted, true);
    assert.equal(second.deduplicated, true);
    assert.equal(second.idempotencyKey, first.idempotencyKey);
    assert.equal(second.payloadFingerprint, first.payloadFingerprint);
    assert.equal(second.acknowledgedAt, first.acknowledgedAt);
    // Exactly one real cancellation was propagated.
    assert.equal(port.calls.filter(call => call.method === 'cancel').length, 1);
  });

  test('rejects the same commandId carrying a different payload', async () => {
    const { service, port } = createService();
    await service.submit(command({ type: 'steer', commandId: 'cmd-conflict', payload: { instruction: 'focus tests' } }));
    await service.settle('cmd-conflict');

    const conflicting = await service.submit(
      command({ type: 'steer', commandId: 'cmd-conflict', payload: { instruction: 'rewrite docs' } }),
    );

    assert.equal(conflicting.accepted, false);
    assert.equal(conflicting.rejection!.code, 'COMMAND_IDEMPOTENCY_CONFLICT');
    // The conflicting payload produced no second revision and no second delivery.
    assert.deepEqual(service.listSteerRevisions(EXECUTION_ID).map(entry => entry.payload),
      [{ instruction: 'focus tests' }]);
    assert.equal(port.calls.filter(call => call.method === 'steer').length, 1);
  });

  test('rejects a command whose declared fingerprint does not match its payload', async () => {
    const { service, port } = createService();
    const original = command({ type: 'steer', commandId: 'cmd-lie', payload: { instruction: 'focus tests' } });
    const honestFingerprint = ezerPayloadFingerprint(original);

    const forged = await service.submit({
      ...original, payload: { instruction: 'rewrite docs' }, payloadFingerprint: honestFingerprint,
    });

    assert.equal(forged.rejection!.code, 'PAYLOAD_FINGERPRINT_MISMATCH');
    assert.deepEqual(port.calls, []);
    assert.deepEqual(service.listSteerRevisions(EXECUTION_ID), []);
  });

  test('accepts a matching declared fingerprint and derives a stable key', async () => {
    const { service } = createService();
    const submitted = command({ type: 'pause', commandId: 'cmd-fp' });

    const ack = await service.submit({ ...submitted, payloadFingerprint: ezerPayloadFingerprint(submitted) });

    assert.equal(ack.accepted, true);
    assert.equal(ack.idempotencyKey, ezerIdempotencyKey(submitted));
    assert.equal(ack.idempotencyKey, 'session-1|op-311|cmd-fp');
    await service.settle('cmd-fp');
  });

  test('treats the same commandId on a different attempt as a conflict', async () => {
    const { service, port } = createService();
    await service.submit(command({ type: 'cancel', commandId: 'cmd-retarget' }));
    await service.settle('cmd-retarget');
    port.activeAttemptId = ATTEMPT_B;

    const retargeted = await service.submit(
      command({ type: 'cancel', commandId: 'cmd-retarget', attemptId: ATTEMPT_B }),
    );

    assert.equal(retargeted.rejection!.code, 'COMMAND_IDEMPOTENCY_CONFLICT');
    assert.equal(port.calls.filter(call => call.method === 'cancel').length, 1);
  });
});

describe('AC-S03-2 steering is ordered, versioned and accepted-vs-applied', () => {
  test('orders revisions, applies them in order and preserves prior evidence', async () => {
    const { service, port } = createService();

    await service.submit(command({ type: 'steer', commandId: 's-1', payload: { instruction: 'first' } }));
    await service.submit(command({ type: 'steer', commandId: 's-2', payload: { instruction: 'second' } }));
    await service.submit(command({ type: 'steer', commandId: 's-3', payload: { instruction: 'third' } }));
    await Promise.all(['s-1', 's-2', 's-3'].map(id => service.settle(id)));

    const revisions = service.listSteerRevisions(EXECUTION_ID);
    assert.deepEqual(revisions.map(entry => entry.version), [1, 2, 3]);
    assert.deepEqual(revisions.map(entry => entry.status), ['applied', 'applied', 'applied']);
    // Superseded revisions keep their payload, ordinal and timestamps.
    assert.deepEqual(revisions.map(entry => entry.supersededBy), [2, 3, null]);
    assert.deepEqual(revisions.map(entry => entry.payload),
      [{ instruction: 'first' }, { instruction: 'second' }, { instruction: 'third' }]);
    for (const revision of revisions) assert.ok(revision.appliedAt);
    // Delivery to the execution followed the same order, changing subsequent activity.
    assert.deepEqual(
      port.calls.filter(call => call.method === 'steer').map(call => call.version),
      [1, 2, 3],
    );
    assert.deepEqual(
      port.calls.filter(call => call.method === 'steer').map(call => call.payload),
      [{ instruction: 'first' }, { instruction: 'second' }, { instruction: 'third' }],
    );
  });

  test('keeps an undeliverable revision accepted rather than marking it applied', async () => {
    const { service, port } = createService();
    await service.submit(command({ type: 'steer', commandId: 's-applied', payload: { instruction: 'first' } }));
    await service.settle('s-applied');

    port.steerOutcome = {
      outcome: 'refused', reason: 'steer-unsupported',
      detail: 'the execution has no steering transport, so the revision was accepted but not applied',
      recovery: 'apply it on the next attempt',
    };
    const ack = await service.submit(command({ type: 'steer', commandId: 's-accepted', payload: { instruction: 'second' } }));
    const confirmation = await service.settle('s-accepted');

    assert.equal(ack.accepted, true);
    assert.equal(ack.steerVersion, 2);
    assert.equal(confirmation!.state, 'accepted-not-applied');
    assert.match(confirmation!.summary, /accepted but NOT applied/);

    const [first, second] = service.listSteerRevisions(EXECUTION_ID);
    assert.equal(second.status, 'accepted');
    assert.equal(second.appliedAt, null);
    assert.match(second.notAppliedReason!, /no steering transport/);
    // The earlier applied revision keeps its evidence untouched.
    assert.equal(first.status, 'applied');
    assert.ok(first.appliedAt);
    assert.equal(first.supersededBy, 2);
  });

  test('refuses a steer for a superseded attempt without revising the replacement', async () => {
    const { service, port } = createService();
    await service.submit(command({ type: 'steer', commandId: 's-ok', payload: { instruction: 'first' } }));
    await service.settle('s-ok');
    port.activeAttemptId = ATTEMPT_B;

    const ack = await service.submit(
      command({ type: 'steer', commandId: 's-stale', attemptId: ATTEMPT_A, payload: { instruction: 'redirect me' } }),
    );

    assert.equal(ack.rejection!.code, 'ATTEMPT_NOT_ACTIVE');
    // No revision was created for either attempt by the stale command.
    assert.deepEqual(service.listSteerRevisions(EXECUTION_ID).map(entry => entry.version), [1]);
    assert.equal(port.calls.filter(call => call.method === 'steer').length, 1);
  });

  test('requires a payload for a steering command', () => {
    const { error } = parseEzerControlCommand({
      type: 'steer', requestId: 'r', sessionId: 's', operationId: OPERATION_ID,
      executionId: EXECUTION_ID, attemptId: ATTEMPT_A, commandId: 'c',
    });

    assert.match(error!, /steer requires a payload/);
  });

  test('rejects malformed commands before they reach the execution', () => {
    assert.match(parseEzerControlCommand(null).error!, /command object is required/);
    assert.match(parseEzerControlCommand({ type: 'restart' }).error!, /pause, resume, steer, cancel/);
    assert.match(parseEzerControlCommand({ type: 'cancel' }).error!, /requestId is required/);
    assert.match(
      parseEzerControlCommand({
        type: 'cancel', requestId: 'r', sessionId: 's', operationId: OPERATION_ID,
        executionId: EXECUTION_ID, attemptId: '   ',
      }).error!,
      /attemptId is required/,
    );
  });
});

describe('control envelopes project onto the real S02 operation stream', () => {
  test('delivers ack and confirmation to subscribers and fences late publication', async () => {
    const streaming = new EzerStreamingService({ heartbeatIntervalMs: 60_000 });
    const port = new FakePort();
    const service = new EzerControlService({ port, stream: streaming });
    streaming.registerOperation({ operationId: OPERATION_ID, requestId: 'req-1', sessionId: 'session-1' });
    const received: EzerEventEnvelope[] = [];
    await streaming.resume(OPERATION_ID, {
      id: 'socket-1',
      send: (event, payload) => {
        if (event === EZER_STREAM_EVENT) received.push(payload as EzerEventEnvelope);
      },
    });

    const journalEvent = (cursor: string): EzerEventEnvelope => ({
      type: 'progress', requestId: 'req-1', sessionId: 'session-1', operationId: OPERATION_ID,
      executionId: EXECUTION_ID, attemptId: ATTEMPT_A, cursor,
      ts: new Date().toISOString(), summary: 'analysing repository',
    });
    assert.equal(streaming.ingest(journalEvent('000000000041')).accepted, true);

    await service.submit(command({ type: 'cancel', commandId: 'cmd-live' }));
    await service.settle('cmd-live');

    // Late output from the cancelled attempt is refused, with no replacement.
    const late = streaming.ingest(journalEvent('000000000050'));
    assert.deepEqual(late, { accepted: false, reason: 'fenced-attempt' });

    const types = received.map(entry => entry.type);
    assert.deepEqual(types, ['progress', 'control-ack', 'result']);
    // Control envelopes reuse the last durable cursor and never advance it.
    assert.equal(received[1].cursor, '000000000041');
    assert.equal(streaming.getLastCursor(OPERATION_ID), '000000000041');
    streaming.close();
  });
});

describe('HTTP control surface', () => {
  async function withServer(
    deps: Parameters<typeof createEzerControlRoutes>[0],
    principal: { id: string; permissions: string[] } | null,
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (principal) {
        req.user = { id: principal.id } as Express.User;
        req.authorization = { role: 'member', permissions: principal.permissions, source: 'implicit' } as never;
      }
      next();
    });
    const routes = createEzerControlRoutes(deps);
    app.post('/api/ezer/operations/:operationId/control', routes.postControl);
    app.get('/api/ezer/operations/:operationId/control/:commandId', routes.getControlCommand);
    app.get('/api/ezer/operations/:operationId/steer', routes.getSteerRevisions);
    const server = app.listen(0);
    try {
      await new Promise<void>(resolve => server.once('listening', () => resolve()));
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: 'cancel', requestId: 'req-1', sessionId: 'session-1',
    executionId: EXECUTION_ID, attemptId: ATTEMPT_A, commandId: 'http-1', ...overrides,
  });

  test('accepts a command with 202 — accepted, not completed', async () => {
    const { service, port } = createService();
    port.gate = new Promise(() => undefined); // never confirms during the request
    await withServer(
      { getService: () => service, authorize: async () => true },
      { id: 'user-1', permissions: [] },
      async baseUrl => {
        const response = await fetch(`${baseUrl}/api/ezer/operations/${OPERATION_ID}/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body()),
        });
        const payload = await response.json() as { accepted: boolean; confirmation: string; state: string };

        assert.equal(response.status, 202);
        assert.equal(payload.accepted, true);
        assert.equal(payload.state, 'accepted');
        assert.equal(payload.confirmation, 'pending');

        const followUp = await fetch(`${baseUrl}/api/ezer/operations/${OPERATION_ID}/control/http-1`);
        const followUpPayload = await followUp.json() as { confirmation: unknown };
        assert.equal(followUp.status, 200);
        assert.equal(followUpPayload.confirmation, null);
      },
    );
  });

  test('maps rejections onto their HTTP status', async () => {
    const { service, port } = createService();
    port.activeAttemptId = ATTEMPT_B;
    await withServer(
      { getService: () => service, authorize: async () => true },
      { id: 'user-1', permissions: [] },
      async baseUrl => {
        const conflict = await fetch(`${baseUrl}/api/ezer/operations/${OPERATION_ID}/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body({ commandId: 'http-stale' })),
        });
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json() as { rejection: { code: string } }).rejection.code, 'ATTEMPT_NOT_ACTIVE');

        const invalid = await fetch(`${baseUrl}/api/ezer/operations/${OPERATION_ID}/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'cancel' }),
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json() as { code: string }).code, 'INVALID_COMMAND');
      },
    );
  });

  test('refuses unauthenticated and unauthorized callers before any effect', async () => {
    const { service, port } = createService();
    await withServer(
      { getService: () => service, authorize: async () => false },
      { id: 'user-2', permissions: [] },
      async baseUrl => {
        const forbidden = await fetch(`${baseUrl}/api/ezer/operations/${OPERATION_ID}/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body({ commandId: 'http-forbidden' })),
        });
        assert.equal(forbidden.status, 403);
      },
    );
    await withServer(
      { getService: () => service, authorize: async () => true },
      null,
      async baseUrl => {
        const unauthenticated = await fetch(`${baseUrl}/api/ezer/operations/${OPERATION_ID}/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body({ commandId: 'http-anon' })),
        });
        assert.equal(unauthenticated.status, 401);
      },
    );
    assert.deepEqual(port.calls, []);
  });

  test('reports the control plane as unavailable instead of silently dropping a command', async () => {
    await withServer(
      { getService: () => null, authorize: async () => true },
      { id: 'user-1', permissions: [] },
      async baseUrl => {
        const response = await fetch(`${baseUrl}/api/ezer/operations/${OPERATION_ID}/control`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body({ commandId: 'http-unavailable' })),
        });
        assert.equal(response.status, 503);
        assert.equal((await response.json() as { code: string }).code, 'CONTROL_UNAVAILABLE');
      },
    );
  });

  test('serves the ordered steering evidence for an execution', async () => {
    const { service } = createService();
    await service.submit(command({ type: 'steer', commandId: 'http-s1', payload: { instruction: 'first' } }));
    await service.submit(command({ type: 'steer', commandId: 'http-s2', payload: { instruction: 'second' } }));
    await Promise.all(['http-s1', 'http-s2'].map(id => service.settle(id)));

    await withServer(
      { getService: () => service, authorize: async () => true },
      { id: 'user-1', permissions: [] },
      async baseUrl => {
        const response = await fetch(
          `${baseUrl}/api/ezer/operations/${OPERATION_ID}/steer?executionId=${EXECUTION_ID}`,
        );
        const payload = await response.json() as { revisions: Array<{ version: number; status: string }> };

        assert.equal(response.status, 200);
        assert.deepEqual(payload.revisions.map(entry => entry.version), [1, 2]);
        assert.deepEqual(payload.revisions.map(entry => entry.status), ['applied', 'applied']);
      },
    );
  });
});

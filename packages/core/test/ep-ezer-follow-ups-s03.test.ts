/**
 * EP-ezer-follow-ups-S03 — control propagation semantics (TC-007, TC-008).
 *
 * Exercises the attempt-exact control state machine against the real
 * production module with a controlled clock, a controlled stop propagator and
 * a controlled container observation, so every positive/negative branch,
 * repeat and race required by AC-S03-1 / AC-S03-2 is actually run.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    EzerAttemptControlRegistry,
    EZER_CESSATION_CONFIRM_TARGET_MS,
    EZER_CONTROL_ACK_TARGET_MS,
    buildEzerIdempotencyKey,
    computeEzerPayloadFingerprint,
    parseEzerControlCommand,
    type EzerControlCommand,
    type EzerStopPropagationResult,
    type EzerStopPropagator,
} from '../src/claude/docker/ep-ezer-follow-ups-s03.js';
import type { RunningTaskContainer } from '../src/claude/docker/dockerExecutor.js';

const OPERATION = 'op-s03';
const EXECUTION = 'exe-1';
const ATTEMPT = 'att-1';
const TASK = 'task-s03';
const GENERATION = 'gen-a';

function createClock(start = 1_700_000_000_000) {
    let current = start;
    return {
        now: () => current,
        advance: (ms: number) => { current += ms; },
        sleep: (ms: number) => { current += ms; return Promise.resolve(); },
    };
}

interface Harness {
    registry: EzerAttemptControlRegistry;
    clock: ReturnType<typeof createClock>;
    propagations: Array<{ taskId: string; commandType: string; reason: string; requestedBy: string }>;
    propagate: EzerStopPropagator;
    fenced: Array<{ operationId: string; executionId: string; attemptId: string }>;
    /** Set to false to model the container really disappearing. */
    container: { present: boolean; failObservation: boolean };
}

function createHarness(options: {
    pauseSupport?: 'checkpoint-stop' | 'unsupported';
    /** Whether the propagated stop actually removes the container. */
    stopRemovesContainer?: boolean;
    propagationResult?: EzerStopPropagationResult;
    propagationThrows?: boolean;
} = {}): Harness {
    const clock = createClock();
    const propagations: Harness['propagations'] = [];
    const container = { present: true, failObservation: false };
    const fenced: Harness['fenced'] = [];
    const registry = new EzerAttemptControlRegistry({
        now: clock.now,
        sleep: clock.sleep,
        observeAttempt: (taskId, attemptGeneration): Promise<RunningTaskContainer | null> => {
            if (container.failObservation) return Promise.reject(new Error('docker daemon unreachable'));
            assert.equal(taskId, TASK);
            assert.equal(attemptGeneration, GENERATION);
            return Promise.resolve(container.present ? { id: 'container-1', name: 'propr-agent-task-s03' } : null);
        },
        onAttemptFenced: entry => { fenced.push(entry); },
    });
    const propagate: EzerStopPropagator = input => {
        propagations.push({
            taskId: input.taskId,
            commandType: input.commandType,
            reason: input.reason,
            requestedBy: input.requestedBy,
        });
        if (options.propagationThrows) return Promise.reject(new Error('redis unavailable'));
        if (options.stopRemovesContainer !== false) container.present = false;
        return Promise.resolve(options.propagationResult ?? {
            abortSignalled: false,
            containerStopped: true,
            removedQueuedJobs: 0,
            message: 'Execution stopped. The Docker container has been terminated.',
        });
    };
    registry.registerAttempt({
        operationId: OPERATION,
        executionId: EXECUTION,
        attemptId: ATTEMPT,
        taskId: TASK,
        attemptGeneration: GENERATION,
        sessionId: 'ses-1',
        requestId: 'req-1',
        ...(options.pauseSupport ? { pauseSupport: options.pauseSupport } : {}),
    });
    return { registry, clock, propagations, propagate, fenced, container };
}

function command(overrides: Partial<EzerControlCommand> & { type: EzerControlCommand['type']; commandId: string }): EzerControlCommand {
    return {
        sessionId: 'ses-1',
        operationId: OPERATION,
        executionId: EXECUTION,
        attemptId: ATTEMPT,
        requestId: 'req-1',
        requestedBy: 'owner',
        ...overrides,
    };
}

describe('EP-ezer-follow-ups-S03 cancellation, pause and resume (AC-S03-1)', () => {
    test('cancel acknowledges within the 2s target without claiming cessation', () => {
        const harness = createHarness();
        const ack = harness.registry.submit(command({ type: 'cancel', commandId: 'cmd-cancel' }));

        assert.equal(ack.type, 'control-ack');
        assert.equal(ack.state, 'accepted');
        assert.equal(ack.attemptId, ATTEMPT);
        assert.equal(ack.executionId, EXECUTION);
        assert.equal(ack.ackTargetMs, EZER_CONTROL_ACK_TARGET_MS);
        assert.ok(ack.ackLatencyMs <= EZER_CONTROL_ACK_TARGET_MS);
        assert.equal(ack.withinAckTarget, true);
        // The ack is explicitly not a completion report.
        assert.equal(ack.cessation, 'pending');
        assert.equal(ack.phase, 'cancelling');
        assert.equal(harness.propagations.length, 0, 'no stop is propagated by the acknowledgement itself');
    });

    test('confirms real cessation only once the attempt container is gone', async () => {
        const harness = createHarness();
        const cancel = command({ type: 'cancel', commandId: 'cmd-cancel' });
        harness.registry.submit(cancel);
        const report = await harness.registry.confirmCessation(cancel, harness.propagate);

        assert.ok(report);
        assert.equal(report.state, 'stopped');
        assert.equal(report.confirmed, true);
        assert.equal(report.taskId, TASK);
        assert.equal(report.attemptId, ATTEMPT);
        assert.equal(report.evidence.containerStopped, true);
        assert.equal(report.evidence.observedContainer, null);
        assert.equal(report.evidence.observationAvailable, true);
        assert.equal(report.evidence.propagationFailed, false);
        assert.equal(report.targetMs, EZER_CESSATION_CONFIRM_TARGET_MS);
        assert.equal(report.withinTarget, true);
        assert.equal(report.phase, 'stopped');
        assert.deepEqual(harness.propagations.map(entry => entry.commandType), ['cancel']);
    });

    test('reports still-running with reason and recovery instead of a false stop', async () => {
        const harness = createHarness({ stopRemovesContainer: false });
        const cancel = command({ type: 'cancel', commandId: 'cmd-stuck' });
        harness.registry.submit(cancel);
        const report = await harness.registry.confirmCessation(cancel, harness.propagate);

        assert.ok(report);
        assert.equal(report.state, 'still-running');
        assert.equal(report.confirmed, false);
        assert.equal(report.evidence.observedContainer, 'container-1');
        assert.ok(report.reason?.includes('still carries the attempt labels'));
        assert.ok(report.recovery);
        assert.ok(report.elapsedMs >= EZER_CESSATION_CONFIRM_TARGET_MS);
        assert.ok(report.evidence.observations > 1, 'the observation is repeated until the target expires');
        assert.ok(!report.summary.includes('confirmed stopped'));
    });

    test('an unobservable attempt is unverified, never stopped', async () => {
        const harness = createHarness();
        harness.container.failObservation = true;
        const cancel = command({ type: 'cancel', commandId: 'cmd-blind' });
        harness.registry.submit(cancel);
        const report = await harness.registry.confirmCessation(cancel, harness.propagate);

        assert.ok(report);
        assert.equal(report.state, 'unverified');
        assert.equal(report.confirmed, false);
        assert.equal(report.evidence.observationAvailable, false);
        assert.ok(report.reason?.includes('docker daemon unreachable'));
        assert.ok(report.recovery?.includes(TASK));
    });

    test('a failed stop propagation is unverified even when no container is visible', async () => {
        const harness = createHarness({ propagationThrows: true });
        harness.container.present = false;
        const cancel = command({ type: 'cancel', commandId: 'cmd-broken' });
        harness.registry.submit(cancel);
        const report = await harness.registry.confirmCessation(cancel, harness.propagate);

        assert.ok(report);
        assert.equal(report.state, 'unverified');
        assert.equal(report.confirmed, false);
        assert.equal(report.evidence.propagationFailed, true);
        assert.ok(report.reason?.includes('Stop propagation failed'));
    });

    test('a task that was never running is reported as not-running, not stopped', async () => {
        const harness = createHarness({
            propagationResult: { notFound: true, message: 'The task may have already completed or does not exist.' },
        });
        harness.container.present = false;
        const cancel = command({ type: 'cancel', commandId: 'cmd-absent' });
        harness.registry.submit(cancel);
        const report = await harness.registry.confirmCessation(cancel, harness.propagate);

        assert.ok(report);
        assert.equal(report.state, 'not-running');
        assert.ok(report.summary.includes('nothing was terminated'));
    });

    test('racing cancels share one real stop and agree on the outcome', async () => {
        const harness = createHarness();
        const first = command({ type: 'cancel', commandId: 'cmd-race-a' });
        const second = command({ type: 'cancel', commandId: 'cmd-race-b' });
        assert.equal(harness.registry.submit(first).state, 'accepted');
        assert.equal(harness.registry.submit(second).state, 'accepted');

        const [a, b] = await Promise.all([
            harness.registry.confirmCessation(first, harness.propagate),
            harness.registry.confirmCessation(second, harness.propagate),
        ]);

        assert.equal(harness.propagations.length, 1, 'the racing cancel joins the in-flight stop');
        assert.equal(a?.state, 'stopped');
        assert.equal(b?.state, 'stopped');
        assert.equal(a?.commandId, 'cmd-race-a');
        assert.equal(b?.commandId, 'cmd-race-b');
    });

    test('cancel fences the attempt so late publication is refused before any replacement exists', async () => {
        const harness = createHarness();
        assert.deepEqual(harness.registry.acceptPublication(EXECUTION, ATTEMPT), { accepted: true });
        const cancel = command({ type: 'cancel', commandId: 'cmd-fence' });
        harness.registry.submit(cancel);

        assert.deepEqual(harness.fenced, [{ operationId: OPERATION, executionId: EXECUTION, attemptId: ATTEMPT }]);
        assert.deepEqual(
            harness.registry.acceptPublication(EXECUTION, ATTEMPT),
            { accepted: false, reason: 'fenced-attempt' },
        );
        await harness.registry.confirmCessation(cancel, harness.propagate);
        assert.deepEqual(
            harness.registry.acceptPublication(EXECUTION, ATTEMPT),
            { accepted: false, reason: 'fenced-attempt' },
        );
        assert.deepEqual(
            harness.registry.acceptPublication(EXECUTION, 'never-registered'),
            { accepted: false, reason: 'unknown-attempt' },
        );
    });

    test('a superseded attempt is refused and its replacement is not redirected', () => {
        const harness = createHarness();
        harness.registry.registerAttempt({
            operationId: OPERATION,
            executionId: EXECUTION,
            attemptId: 'att-2',
            taskId: 'task-s03-retry',
            attemptGeneration: 'gen-b',
        });

        const stale = harness.registry.submit(command({ type: 'cancel', commandId: 'cmd-stale' }));
        assert.equal(stale.state, 'rejected');
        assert.equal(stale.rejection?.code, 'SUPERSEDED_ATTEMPT');
        assert.equal(stale.attemptId, ATTEMPT, 'the rejection names the stale attempt, not the replacement');

        const replacement = harness.registry.getAttempt(EXECUTION, 'att-2');
        assert.equal(replacement?.phase, 'active');
        assert.equal(replacement?.fenced, false);
        // The stale attempt cannot publish into its replacement.
        assert.deepEqual(
            harness.registry.acceptPublication(EXECUTION, ATTEMPT),
            { accepted: false, reason: 'fenced-attempt' },
        );
    });

    test('pause is refused with a reason when suspension is unsupported', () => {
        const harness = createHarness({ pauseSupport: 'unsupported' });
        const ack = harness.registry.submit(command({ type: 'pause', commandId: 'cmd-pause' }));

        assert.equal(ack.state, 'rejected');
        assert.equal(ack.rejection?.code, 'PAUSE_UNSUPPORTED');
        assert.ok(ack.rejection?.message.includes('still running'));
        assert.ok(ack.rejection?.recovery);
        const attempt = harness.registry.getAttempt(EXECUTION, ATTEMPT);
        assert.equal(attempt?.phase, 'active', 'a refused pause never claims the attempt is paused');
        assert.equal(attempt?.fenced, false);
        assert.equal(harness.fenced.length, 0);
    });

    test('pause checkpoints and really stops, then grants exactly one resume', async () => {
        const harness = createHarness({ pauseSupport: 'checkpoint-stop' });
        harness.registry.submit(command({ type: 'steer', commandId: 'cmd-pre-steer', payload: { focus: 'tests' } }));

        const pause = command({ type: 'pause', commandId: 'cmd-pause' });
        const pauseAck = harness.registry.submit(pause);
        assert.equal(pauseAck.state, 'accepted');
        assert.equal(pauseAck.cessation, 'pending');
        assert.equal(pauseAck.phase, 'pausing');

        const report = await harness.registry.confirmCessation(pause, harness.propagate);
        assert.equal(report?.state, 'checkpointed');
        assert.equal(report?.confirmed, true);
        assert.equal(report?.phase, 'paused');
        assert.deepEqual(report?.checkpoint?.steerVersions, [1], 'the checkpoint preserves prior steer evidence');
        assert.deepEqual(harness.propagations.map(entry => entry.commandType), ['pause']);

        const firstResume = harness.registry.submit(command({ type: 'resume', commandId: 'cmd-resume-a' }));
        assert.equal(firstResume.state, 'accepted');
        assert.equal(firstResume.cessation, 'not-applicable');
        assert.ok(firstResume.resume?.continuationId);
        assert.equal(firstResume.resume?.checkpoint.kind, 'checkpoint-stop');

        const secondResume = harness.registry.submit(command({ type: 'resume', commandId: 'cmd-resume-b' }));
        assert.equal(secondResume.state, 'rejected');
        assert.equal(secondResume.rejection?.code, 'RESUME_ALREADY_CLAIMED');
    });

    test('resuming an active attempt is refused so it is never duplicated', () => {
        const harness = createHarness();
        const ack = harness.registry.submit(command({ type: 'resume', commandId: 'cmd-resume-active' }));

        assert.equal(ack.state, 'rejected');
        assert.equal(ack.rejection?.code, 'RESUME_NOT_PAUSED');
        assert.ok(ack.rejection?.recovery.includes('duplicate'));
        assert.equal(harness.registry.getAttempt(EXECUTION, ATTEMPT)?.phase, 'active');
    });

    test('pause is refused once the attempt is already cancelling', () => {
        const harness = createHarness({ pauseSupport: 'checkpoint-stop' });
        harness.registry.submit(command({ type: 'cancel', commandId: 'cmd-cancel' }));
        const ack = harness.registry.submit(command({ type: 'pause', commandId: 'cmd-late-pause' }));

        assert.equal(ack.state, 'rejected');
        assert.equal(ack.rejection?.code, 'PAUSE_NOT_ACTIVE');
    });

    test('a command naming an unknown attempt or a foreign operation is refused', () => {
        const harness = createHarness();
        const unknown = harness.registry.submit(command({ type: 'cancel', commandId: 'cmd-x', attemptId: 'nope' }));
        assert.equal(unknown.rejection?.code, 'UNKNOWN_ATTEMPT');

        const foreign = harness.registry.submit(command({ type: 'cancel', commandId: 'cmd-y', operationId: 'other-op' }));
        assert.equal(foreign.rejection?.code, 'UNKNOWN_ATTEMPT');
        assert.equal(harness.propagations.length, 0);
    });
});

describe('EP-ezer-follow-ups-S03 steering (AC-S03-2)', () => {
    test('steering produces ordered versions with distinct accepted and applied states', () => {
        const harness = createHarness();
        const first = harness.registry.submit(command({ type: 'steer', commandId: 'cmd-s1', payload: { focus: 'api' } }));
        harness.clock.advance(5);
        const second = harness.registry.submit(command({ type: 'steer', commandId: 'cmd-s2', payload: { focus: 'docs' } }));

        assert.equal(first.steerVersion, 1);
        assert.equal(first.steerState, 'accepted');
        assert.equal(second.steerVersion, 2);
        assert.equal(second.steerState, 'accepted');

        const before = harness.registry.getAttempt(EXECUTION, ATTEMPT)!.steer;
        assert.deepEqual(before.map(revision => revision.version), [1, 2]);
        assert.deepEqual(before.map(revision => revision.state), ['accepted', 'accepted']);
        assert.deepEqual(before.map(revision => revision.appliedAt), [null, null]);

        const applied = harness.registry.consumeSteerRevisions(EXECUTION, ATTEMPT);
        assert.deepEqual(applied.map(revision => revision.version), [1, 2]);
        assert.deepEqual(applied.map(revision => revision.state), ['applied', 'applied']);

        const after = harness.registry.getAttempt(EXECUTION, ATTEMPT)!.steer;
        // Prior evidence is preserved: same payloads, same acceptance times.
        assert.deepEqual(after.map(revision => revision.payload), [{ focus: 'api' }, { focus: 'docs' }]);
        assert.deepEqual(after.map(revision => revision.acceptedAt), before.map(revision => revision.acceptedAt));
        assert.ok(after.every(revision => revision.appliedAt !== null));
        assert.deepEqual(harness.registry.consumeSteerRevisions(EXECUTION, ATTEMPT), [],
            'an applied revision is not handed out again');
    });

    test('an exact duplicate commandId and payload dedups without a second revision', () => {
        const harness = createHarness();
        const payload = { focus: 'api', steps: [1, 2] };
        const first = harness.registry.submit(command({ type: 'steer', commandId: 'cmd-dup', payload }));
        // Same content, different key order — the fingerprint must still match.
        const repeat = harness.registry.submit(command({
            type: 'steer', commandId: 'cmd-dup', payload: { steps: [1, 2], focus: 'api' },
        }));

        assert.equal(first.state, 'accepted');
        assert.equal(repeat.state, 'deduplicated');
        assert.equal(repeat.steerVersion, 1);
        assert.equal(repeat.idempotencyKey, buildEzerIdempotencyKey(first));
        assert.equal(harness.registry.getAttempt(EXECUTION, ATTEMPT)?.steer.length, 1);
    });

    test('a conflicting payload under the same commandId is rejected and nothing is redirected', () => {
        const harness = createHarness();
        harness.registry.submit(command({ type: 'steer', commandId: 'cmd-conflict', payload: { focus: 'api' } }));
        const conflict = harness.registry.submit(command({
            type: 'steer', commandId: 'cmd-conflict', payload: { focus: 'something-else' },
        }));

        assert.equal(conflict.state, 'rejected');
        assert.equal(conflict.rejection?.code, 'IDEMPOTENCY_KEY_CONFLICT');
        const steer = harness.registry.getAttempt(EXECUTION, ATTEMPT)!.steer;
        assert.equal(steer.length, 1);
        assert.deepEqual(steer[0].payload, { focus: 'api' });
    });

    test('a steer for a superseded attempt never lands on the replacement attempt', () => {
        const harness = createHarness();
        harness.registry.registerAttempt({
            operationId: OPERATION, executionId: EXECUTION, attemptId: 'att-2',
            taskId: 'task-s03-retry', attemptGeneration: 'gen-b',
        });

        const stale = harness.registry.submit(command({
            type: 'steer', commandId: 'cmd-late-steer', payload: { focus: 'redirect' },
        }));
        assert.equal(stale.rejection?.code, 'SUPERSEDED_ATTEMPT');
        assert.equal(harness.registry.getAttempt(EXECUTION, 'att-2')?.steer.length, 0);
        assert.equal(harness.registry.getAttempt(EXECUTION, ATTEMPT)?.steer.length, 0);
    });

    test('steering a fenced attempt and steering without a payload are both refused', () => {
        const harness = createHarness();
        const noPayload = harness.registry.submit(command({ type: 'steer', commandId: 'cmd-empty' }));
        assert.equal(noPayload.rejection?.code, 'STEER_PAYLOAD_REQUIRED');

        harness.registry.submit(command({ type: 'cancel', commandId: 'cmd-cancel' }));
        const fencedSteer = harness.registry.submit(command({
            type: 'steer', commandId: 'cmd-after-cancel', payload: { focus: 'late' },
        }));
        assert.equal(fencedSteer.rejection?.code, 'ATTEMPT_FENCED');
        assert.deepEqual(harness.registry.consumeSteerRevisions(EXECUTION, ATTEMPT), []);
    });
});

describe('EP-ezer-follow-ups-S03 command identity', () => {
    test('payload fingerprints are stable across key order and sensitive to content', () => {
        assert.equal(
            computeEzerPayloadFingerprint({ a: 1, b: { c: 2, d: [3, 4] } }),
            computeEzerPayloadFingerprint({ b: { d: [3, 4], c: 2 }, a: 1 }),
        );
        assert.notEqual(
            computeEzerPayloadFingerprint({ a: 1 }),
            computeEzerPayloadFingerprint({ a: 2 }),
        );
        assert.notEqual(
            computeEzerPayloadFingerprint([1, 2]),
            computeEzerPayloadFingerprint([2, 1]),
        );
    });

    test('the idempotency key is sessionId + operationId + commandId', () => {
        const key = buildEzerIdempotencyKey({ sessionId: 's', operationId: 'o', commandId: 'c' });
        assert.equal(key, 's o c');
        assert.notEqual(key, buildEzerIdempotencyKey({ sessionId: 's', operationId: 'o2', commandId: 'c' }));
    });

    test('malformed commands are rejected before reaching any attempt', () => {
        assert.equal(parseEzerControlCommand(null), null);
        assert.equal(parseEzerControlCommand('cancel'), null);
        assert.equal(parseEzerControlCommand([{ type: 'cancel' }]), null);
        assert.equal(parseEzerControlCommand({ type: 'restart', commandId: 'c', sessionId: 's', operationId: 'o', executionId: 'e', attemptId: 'a' }), null);
        assert.equal(parseEzerControlCommand({ type: 'cancel', commandId: '  ', sessionId: 's', operationId: 'o', executionId: 'e', attemptId: 'a' }), null);
        const parsed = parseEzerControlCommand({
            type: 'steer', commandId: ' c ', sessionId: 's', operationId: 'o',
            executionId: 'e', attemptId: 'a', payload: { focus: 'x' }, extra: 'ignored',
        });
        assert.equal(parsed?.commandId, 'c');
        assert.deepEqual(parsed?.payload, { focus: 'x' });
        assert.equal((parsed as unknown as Record<string, unknown>).extra, undefined);
    });
});

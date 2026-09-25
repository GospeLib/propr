/* eslint-disable max-lines -- the control plane keeps command parsing, the
   idempotency ledger, propagation and cessation observation in one module so a
   command's ack, refusal and confirmation semantics stay readable together. */
/**
 * EP-ezer-follow-ups-S03 — steering, pause and cancellation control
 * propagation (REQ-EF17), ProPR lane.
 *
 * Implements `pause`, `resume`, `steer` and `cancel` from `contract.md` on top
 * of the mechanisms that already exist in this repository: the S02 journal
 * projection supplies the exact active attempt and the publication fence, and
 * `stopTaskExecution` propagates a cancel to the real ProPR job/container.
 *
 * Two rules shape everything here:
 *
 * 1. An acknowledgement is not a result. Every command publishes an immediate
 *    `control-ack` (2s design target) and then, separately, a confirmation of
 *    what actually happened downstream (10s design target). A command that
 *    cannot be confirmed reports still-running with a reason and a recovery
 *    step — never a false "stopped" and never a silent orphan.
 * 2. Steering is versioned, ordered and append-only, with `accepted` (received)
 *    and `applied` (observed to change subsequent activity) as distinct states.
 *    Prior revisions are preserved; a replacement attempt is never redirected
 *    by a steer that targeted the attempt it replaced.
 */

import { createHash } from 'node:crypto';
import type { Response } from 'express';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import type {
  EzerActiveAttempt,
  EzerEventEnvelope,
  EzerStreamingService,
} from '../ep-ezer-follow-ups-s02.js';
import { getDockerContainerStatus } from './dockerCommandSafety.js';
import { normalizeTaskId, stopTaskExecution, type StopTaskExecutionResult } from './dockerRoutes.js';
import { validateTaskId } from './validation.js';

/** contract.md design target: a control command is acknowledged within 2s. */
const CONTROL_ACK_TARGET_MS = 2_000;

/** contract.md design target: supported cessation is confirmed within 10s. */
const CESSATION_CONFIRM_TARGET_MS = 10_000;

/** How often real downstream cancellation evidence is re-observed. */
const CESSATION_POLL_INTERVAL_MS = 250;

/** Worker states in which the task is still executing. */
const ACTIVE_WORKER_STATES = new Set(['processing', 'claude_execution', 'post_processing']);

const CONTROL_COMMANDS = new Set(['pause', 'resume', 'steer', 'cancel']);
const MAX_IDENTIFIER_LENGTH = 256;

type EzerControlCommand = 'pause' | 'resume' | 'steer' | 'cancel';

interface ControlTarget { executionId: string; attemptId: string }

interface ControlRequest {
  operationId: string;
  commandId: string;
  command: EzerControlCommand;
  sessionId: string;
  requestId?: string;
  taskId?: string;
  target: ControlTarget | null;
  payload: unknown;
  payloadFingerprint: string;
}

interface ControlAck {
  state: 'accepted';
  command: EzerControlCommand;
  commandId: string;
  operationId: string;
  idempotencyKey: string;
  payloadFingerprint: string;
  target: ControlTarget | null;
  acceptedAt: string;
  ackLatencyMs: number;
  ackTargetMs: number;
  withinAckTarget: boolean;
  /** An ack is receipt only; the confirmation below reports real state. */
  meansCompleted: false;
}

interface ControlConfirmation {
  command: EzerControlCommand;
  /** `confirmed` requires observed evidence; `unconfirmed` never means stopped. */
  status: 'confirmed' | 'refused' | 'unconfirmed';
  summary: string;
  confirmedAt: string;
  latencyMs: number;
  withinCessationTarget: boolean;
  reasonCode?: string;
  reason?: string;
  recovery?: string;
  evidence: Record<string, unknown>;
}

interface SteeringRevision {
  version: number;
  commandId: string;
  payloadFingerprint: string;
  payload: unknown;
  target: ControlTarget;
  state: 'accepted' | 'applied';
  acceptedAt: string;
  acceptedAtCursor: string | null;
  appliedAt?: string;
  appliedAtCursor?: string;
}

interface PauseRecord {
  commandId: string;
  mode: 'checkpointed';
  pausedAt: string;
  checkpointCursor: string | null;
  resumed: boolean;
  resumedAt?: string;
  continuationId?: string;
}

interface LedgerEntry {
  idempotencyKey: string;
  command: EzerControlCommand;
  commandId: string;
  payloadFingerprint: string;
  ack: ControlAck;
  confirmation: ControlConfirmation | null;
  duplicateDeliveries: number;
}

interface OperationControlState {
  operationId: string;
  taskId: string | null;
  ledger: Map<string, LedgerEntry>;
  revisions: SteeringRevision[];
  pause: PauseRecord | null;
  pauseHistory: PauseRecord[];
  fenced: ControlTarget[];
  continuationCount: number;
}

interface ControlResult { httpStatus: number; body: Record<string, unknown> }

/** Per-command execution context shared by every command handler. */
interface CommandContext { requestedBy: string; receivedAt: number }

interface EzerControlRoutesDeps {
  redisClient: RedisClientType;
  /** Resolved lazily: the projection lives on the socket service. */
  getStreaming: () => EzerStreamingService | null;
  stopTaskExecution?: typeof stopTaskExecution;
  /** Container observation seam; defaults to the real `docker ps` lookup. */
  observeContainerStatus?: (containerId: string) => string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

function fingerprintPayload(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/** Key order must not change a fingerprint, or a replay would look conflicting. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function readIdentifier(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDENTIFIER_LENGTH ? trimmed : null;
}

function contractError(
  code: string,
  message: string,
  fields: { knownCause: string; persistedState: string; remainingActivity: string; retryPath: string },
): Record<string, unknown> {
  return { code, message, diagnosticId: `ezer-control-${code.toLowerCase()}`, ...fields };
}

/** Validates the attempt target and task binding carried by a command body. */
function parseControlBinding(
  source: Record<string, unknown>,
): { target: ControlTarget | null; taskId: string | null } | { error: string } {
  const executionId = readIdentifier(source, 'executionId');
  const attemptId = readIdentifier(source, 'attemptId');
  if (Boolean(executionId) !== Boolean(attemptId)) {
    return { error: '"executionId" and "attemptId" must be supplied together to target an exact attempt.' };
  }
  const taskId = readIdentifier(source, 'taskId');
  if (taskId) {
    const taskValidation = validateTaskId(taskId);
    if (!taskValidation.valid) return { error: taskValidation.error ?? 'Invalid task ID.' };
  }
  return {
    target: executionId && attemptId ? { executionId, attemptId } : null,
    taskId: taskId ? normalizeTaskId(taskId) : null,
  };
}

function parseControlRequest(
  raw: unknown,
  operationId: string,
): { request: ControlRequest } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'A JSON control command body is required.' };
  const source = raw as Record<string, unknown>;
  const command = readIdentifier(source, 'command');
  if (!command || !CONTROL_COMMANDS.has(command)) {
    return { error: `"command" must be one of ${[...CONTROL_COMMANDS].join(', ')}.` };
  }
  const commandId = readIdentifier(source, 'commandId');
  if (!commandId) return { error: '"commandId" is required and carries the idempotency identity of this command.' };
  const sessionId = readIdentifier(source, 'sessionId');
  if (!sessionId) return { error: '"sessionId" is required and forms part of the idempotency key.' };
  const binding = parseControlBinding(source);
  if ('error' in binding) return binding;
  const payload = source.payload ?? null;
  const payloadFingerprint = fingerprintPayload(payload);
  const declaredFingerprint = readIdentifier(source, 'payloadFingerprint');
  if (declaredFingerprint && declaredFingerprint !== payloadFingerprint) {
    return { error: 'The supplied "payloadFingerprint" does not match the supplied payload.' };
  }
  if (command === 'steer' && (payload === null || typeof payload !== 'object')) {
    return { error: 'A "steer" command requires an object "payload" carrying the redirected input.' };
  }
  const requestId = readIdentifier(source, 'requestId');
  return {
    request: {
      operationId,
      commandId,
      command: command as EzerControlCommand,
      sessionId,
      ...(requestId ? { requestId } : {}),
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
      target: binding.target,
      payload,
      payloadFingerprint,
    },
  };
}

/**
 * Holds the control state of every operation this API node has seen: the
 * idempotency ledger, the ordered steering revisions, the pause record and the
 * attempts it has fenced. The Ezer journal remains the delivery authority; this
 * is the control-plane view of commands ProPR was asked to propagate.
 */
class EzerControlService {
  private readonly states = new Map<string, OperationControlState>();
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly stopTask: typeof stopTaskExecution;
  private readonly observeContainerStatus: (containerId: string) => string;
  private detachEnvelopeListener: (() => void) | null = null;
  private listenerStreaming: EzerStreamingService | null = null;

  constructor(private readonly deps: EzerControlRoutesDeps) {
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }));
    this.stopTask = deps.stopTaskExecution ?? stopTaskExecution;
    this.observeContainerStatus = deps.observeContainerStatus ?? getDockerContainerStatus;
  }

  /**
   * Resolve the projection and, once it exists, observe its envelopes so an
   * accepted steering revision flips to `applied` on real later activity.
   */
  private streaming(): EzerStreamingService | null {
    const streaming = this.deps.getStreaming();
    if (streaming && streaming !== this.listenerStreaming) {
      this.detachEnvelopeListener?.();
      this.listenerStreaming = streaming;
      this.detachEnvelopeListener = streaming.onEnvelope(envelope => this.applySteeringOnActivity(envelope));
    }
    return streaming;
  }

  private ensureState(operationId: string): OperationControlState {
    let state = this.states.get(operationId);
    if (!state) {
      state = {
        operationId, taskId: null, ledger: new Map(), revisions: [],
        pause: null, pauseHistory: [], fenced: [], continuationCount: 0,
      };
      this.states.set(operationId, state);
    }
    return state;
  }

  /**
   * Real subsequent activity on the steered attempt is what "applied" means —
   * acceptance alone never claims it. Activity from a different attempt cannot
   * apply the revision, so a replacement attempt is not silently redirected.
   */
  private applySteeringOnActivity(envelope: EzerEventEnvelope): void {
    if (envelope.type !== 'progress' && envelope.type !== 'result') return;
    const state = this.states.get(envelope.operationId);
    if (!state) return;
    for (const revision of state.revisions) {
      if (revision.state !== 'accepted') continue;
      if (revision.target.executionId !== envelope.executionId) continue;
      if (revision.target.attemptId !== envelope.attemptId) continue;
      revision.state = 'applied';
      revision.appliedAt = envelope.ts;
      revision.appliedAtCursor = envelope.cursor;
      this.listenerStreaming?.publishControlEvent({
        operationId: envelope.operationId,
        type: 'progress',
        executionId: revision.target.executionId,
        attemptId: revision.target.attemptId,
        summary: `Steering revision v${revision.version} applied: subsequent activity now follows the redirected input.`,
        detail: { kind: 'intermediate' },
      });
    }
  }

  async submit(raw: unknown, operationId: string, requestedBy: string): Promise<ControlResult> {
    const receivedAt = this.now();
    const parsed = parseControlRequest(raw, operationId);
    if ('error' in parsed) {
      return {
        httpStatus: 400,
        body: {
          error: contractError('INVALID_CONTROL_REQUEST', parsed.error, {
            knownCause: 'malformed control command',
            persistedState: 'Nothing was recorded; no command was accepted.',
            remainingActivity: 'Any existing attempt continues unchanged.',
            retryPath: 'Correct the command body and resend it with the same commandId.',
          }),
        },
      };
    }
    const request = parsed.request;
    const state = this.ensureState(operationId);
    if (request.taskId) state.taskId = request.taskId;

    const idempotencyKey = `${request.sessionId}|${operationId}|${request.commandId}`;
    const replay = this.resolveIdempotency(state, idempotencyKey, request);
    if (replay) return replay;

    const targeting = this.resolveTarget(state, request);
    if ('error' in targeting) return targeting.error;

    const ack = this.acknowledge(request, idempotencyKey, targeting.target, receivedAt);
    const entry: LedgerEntry = {
      idempotencyKey, command: request.command, commandId: request.commandId,
      payloadFingerprint: request.payloadFingerprint, ack, confirmation: null, duplicateDeliveries: 0,
    };
    state.ledger.set(idempotencyKey, entry);

    try {
      entry.confirmation = await this.execute(state, request, targeting, { requestedBy, receivedAt });
    } catch (error) {
      // A failed handler must leave a truthful record: a later replay of this
      // key must not dedup to a silent "nothing happened".
      entry.confirmation = this.settle(request.command, receivedAt, {
        status: 'unconfirmed',
        summary: `The ${request.command} command failed before its downstream state could be confirmed.`,
        reasonCode: 'CONTROL_COMMAND_FAILED',
        reason: (error as Error).message,
        recovery: 'Re-read the control state, then resend the command under a new commandId if it did not take effect.',
        evidence: { target: targeting.target, stopped: false },
      });
    }
    this.publishConfirmation(request, targeting.target, entry.confirmation);
    return { httpStatus: 202, body: { deduplicated: false, ack, confirmation: entry.confirmation } };
  }

  /**
   * Same key + same payload dedups to the original ack without re-running the
   * command; same key + different payload is rejected outright, so a conflicting
   * replay can never take effect or redirect a replacement attempt.
   */
  private resolveIdempotency(
    state: OperationControlState,
    idempotencyKey: string,
    request: ControlRequest,
  ): ControlResult | null {
    const existing = state.ledger.get(idempotencyKey);
    if (!existing) return null;
    if (existing.payloadFingerprint === request.payloadFingerprint) {
      existing.duplicateDeliveries += 1;
      return {
        httpStatus: 200,
        body: {
          deduplicated: true, duplicateDeliveries: existing.duplicateDeliveries,
          ack: existing.ack, confirmation: existing.confirmation,
        },
      };
    }
    return {
      httpStatus: 409,
      body: {
        deduplicated: false, redirected: false, accepted: false,
        error: contractError(
          'IDEMPOTENCY_CONFLICT',
          `commandId "${request.commandId}" was already accepted for this session with a different payload.`,
          {
            knownCause: 'idempotency key reused with a conflicting payload fingerprint',
            persistedState: `The original ${existing.command} command and its outcome are unchanged.`,
            remainingActivity: 'No attempt was redirected, paused, resumed or cancelled by this request.',
            retryPath: 'Resend the conflicting payload under a new commandId.',
          },
        ),
        conflictsWith: {
          command: existing.command,
          payloadFingerprint: existing.payloadFingerprint,
          acceptedAt: existing.ack.acceptedAt,
        },
      },
    };
  }

  /** Commands act on the exact active attempt, or explicitly refuse. */
  private resolveTarget(
    state: OperationControlState,
    request: ControlRequest,
  ): { target: ControlTarget | null; active: EzerActiveAttempt | null } | { error: ControlResult } {
    const active = this.streaming()?.getActiveAttempt(request.operationId) ?? null;
    const requested = request.target;
    if (requested && active
      && (active.executionId !== requested.executionId || active.attemptId !== requested.attemptId)) {
      return {
        error: {
          httpStatus: 409,
          body: {
            accepted: false, redirected: false,
            error: contractError(
              'ATTEMPT_MISMATCH',
              'The targeted attempt is not the attempt this operation is currently running.',
              {
                knownCause: 'the targeted attempt was superseded or never active',
                persistedState: 'No control state changed; prior evidence is untouched.',
                remainingActivity: `Attempt ${active.attemptId} of execution ${active.executionId} continues unchanged.`,
                retryPath: 'Re-read the active attempt and resend the command against it under a new commandId.',
              },
            ),
            activeAttempt: active,
          },
        },
      };
    }
    const target = active
      ? { executionId: active.executionId, attemptId: active.attemptId }
      : requested;
    if (!target && (request.command === 'cancel' || request.command === 'steer')) {
      return {
        error: {
          httpStatus: 409,
          body: {
            accepted: false,
            error: contractError(
              'NO_ACTIVE_ATTEMPT',
              `A ${request.command} command must target an attempt, and none is active for this operation.`,
              {
                knownCause: 'no attempt has published to the journal stream for this operation',
                persistedState: `No control state changed for operation ${state.operationId}.`,
                remainingActivity: 'Nothing is known to be running for this operation on this node.',
                retryPath: 'Supply executionId and attemptId explicitly, or resend once the attempt has started publishing.',
              },
            ),
          },
        },
      };
    }
    return { target, active };
  }

  private acknowledge(
    request: ControlRequest,
    idempotencyKey: string,
    target: ControlTarget | null,
    receivedAt: number,
  ): ControlAck {
    const acceptedAt = this.now();
    const ack: ControlAck = {
      state: 'accepted',
      command: request.command,
      commandId: request.commandId,
      operationId: request.operationId,
      idempotencyKey,
      payloadFingerprint: request.payloadFingerprint,
      target,
      acceptedAt: new Date(acceptedAt).toISOString(),
      ackLatencyMs: acceptedAt - receivedAt,
      ackTargetMs: CONTROL_ACK_TARGET_MS,
      withinAckTarget: acceptedAt - receivedAt <= CONTROL_ACK_TARGET_MS,
      meansCompleted: false,
    };
    this.streaming()?.publishControlEvent({
      operationId: request.operationId,
      type: 'control-ack',
      ...(request.requestId ? { requestId: request.requestId } : {}),
      sessionId: request.sessionId,
      ...(target ? { executionId: target.executionId, attemptId: target.attemptId } : {}),
      summary: `Control command ${request.command} (${request.commandId}) received; downstream state is not yet confirmed.`,
    });
    return ack;
  }

  /** The later confirmation of real downstream state, distinct from the ack. */
  private publishConfirmation(
    request: ControlRequest,
    target: ControlTarget | null,
    confirmation: ControlConfirmation,
  ): void {
    const blocked = confirmation.status !== 'confirmed';
    this.streaming()?.publishControlEvent({
      operationId: request.operationId,
      type: blocked ? 'progress' : 'result',
      ...(request.requestId ? { requestId: request.requestId } : {}),
      sessionId: request.sessionId,
      ...(target ? { executionId: target.executionId, attemptId: target.attemptId } : {}),
      summary: confirmation.summary,
      ...(blocked
        ? {
          detail: {
            kind: 'blocker' as const,
            ...(confirmation.reason ? { cause: confirmation.reason } : {}),
            ...(confirmation.recovery ? { nextAction: confirmation.recovery } : {}),
          },
        }
        : {}),
    });
  }

  private execute(
    state: OperationControlState,
    request: ControlRequest,
    targeting: { target: ControlTarget | null; active: EzerActiveAttempt | null },
    context: CommandContext,
  ): Promise<ControlConfirmation> {
    const { receivedAt } = context;
    switch (request.command) {
      case 'cancel':
        return this.cancel(state, request, targeting.target!, context);
      case 'pause':
        return Promise.resolve(this.pause(state, request, targeting, receivedAt));
      case 'resume':
        return Promise.resolve(this.resume(state, request, targeting, receivedAt));
      default:
        return Promise.resolve(this.steer(state, request, targeting, receivedAt));
    }
  }

  private settle(
    command: EzerControlCommand,
    receivedAt: number,
    outcome: Omit<ControlConfirmation, 'command' | 'confirmedAt' | 'latencyMs' | 'withinCessationTarget'>,
  ): ControlConfirmation {
    const confirmedAt = this.now();
    const latencyMs = confirmedAt - receivedAt;
    return {
      command,
      confirmedAt: new Date(confirmedAt).toISOString(),
      latencyMs,
      withinCessationTarget: latencyMs <= CESSATION_CONFIRM_TARGET_MS,
      ...outcome,
    };
  }

  /**
   * Fence first, then propagate, then observe. Fencing before propagation means
   * a targeted attempt can never publish late output even when the stop itself
   * fails, and the fence is never moved onto a replacement attempt.
   */
  private async cancel(
    state: OperationControlState,
    request: ControlRequest,
    target: ControlTarget,
    { requestedBy, receivedAt }: CommandContext,
  ): Promise<ControlConfirmation> {
    const streaming = this.streaming();
    const alreadyFenced = streaming?.isAttemptFenced(request.operationId, target.executionId, target.attemptId) ?? false;
    streaming?.fenceAttempt(request.operationId, target.executionId, target.attemptId);
    if (!state.fenced.some(entry => entry.executionId === target.executionId && entry.attemptId === target.attemptId)) {
      state.fenced.push(target);
    }
    const taskId = request.taskId ?? state.taskId;
    if (!taskId) {
      return this.settle('cancel', receivedAt, {
        status: 'unconfirmed',
        summary: 'The attempt is fenced, but no ProPR task binding is known, so cessation could not be propagated or confirmed.',
        reasonCode: 'TASK_BINDING_UNKNOWN',
        reason: 'No taskId was supplied for this operation, so the underlying ProPR job/container could not be identified.',
        recovery: 'Resend cancel with the ProPR taskId under a new commandId; the attempt stays fenced meanwhile.',
        evidence: { fenced: true, alreadyFenced, target, stopped: false },
      });
    }
    let stop: StopTaskExecutionResult;
    try {
      stop = await this.stopTask(taskId, {
        redisClient: this.deps.redisClient,
        requestedBy,
        reason: `Cancelled by Ezer control command ${request.commandId}.`,
        cancellationReason: 'ezer_control_cancel',
        ensureCancelled: true,
      });
    } catch (error) {
      return this.settle('cancel', receivedAt, {
        status: 'unconfirmed',
        summary: 'The attempt is fenced, but cancellation could not be propagated to the ProPR job.',
        reasonCode: 'CANCEL_PROPAGATION_FAILED',
        reason: (error as Error).message,
        recovery: `Retry the cancel for task ${taskId} under a new commandId, then re-check the container.`,
        evidence: { fenced: true, alreadyFenced, target, taskId, stopped: false },
      });
    }
    const confirmation = await this.confirmCancellation(target, { stop, alreadyFenced, receivedAt, taskId });
    // A confirmed cancellation ends the attempt, so a stale pause checkpoint
    // must not survive to authorize a later continuation.
    if (confirmation.status === 'confirmed') state.pause = null;
    return confirmation;
  }

  private async confirmCancellation(
    target: ControlTarget,
    context: { stop: StopTaskExecutionResult; alreadyFenced: boolean; receivedAt: number; taskId: string },
  ): Promise<ControlConfirmation> {
    const { stop, alreadyFenced, receivedAt, taskId } = context;
    const base = {
      fenced: true, alreadyFenced, target, taskId,
      stopResult: {
        containerStopped: stop.containerStopped, abortSignalled: stop.abortSignalled ?? false,
        cancellationRecorded: stop.cancellationRecorded ?? false, removedQueuedJobs: stop.removedQueuedJobs,
        notFound: stop.notFound ?? false, notRunning: stop.notRunning ?? false,
      },
    };
    if (stop.notFound || stop.notRunning) {
      return this.settle('cancel', receivedAt, {
        status: 'confirmed',
        summary: stop.notFound
          ? `No live ProPR job exists for task ${taskId}; the attempt is fenced and nothing is running.`
          : `Task ${taskId} is already in a non-active state (${stop.currentState}); the attempt is fenced.`,
        evidence: { ...base, stopped: true, cessation: { jobPresence: stop.notFound ? 'absent' : 'inactive' } },
      });
    }
    const cessation = await this.observeCessation(taskId, stop.abortSignalled === true, receivedAt);
    if (cessation.stopped) {
      return this.settle('cancel', receivedAt, {
        status: 'confirmed',
        summary: `Cancellation of attempt ${target.attemptId} is confirmed: the ProPR job and its container have ceased.`,
        evidence: { ...base, stopped: true, cessation },
      });
    }
    return this.settle('cancel', receivedAt, {
      status: 'unconfirmed',
      summary: `Cancellation of attempt ${target.attemptId} is not confirmed stopped; the attempt remains fenced and cannot publish.`,
      reasonCode: 'CESSATION_UNCONFIRMED',
      reason: cessation.reason,
      recovery: `Inspect task ${taskId} and its container directly; the abort signal and the publication fence both remain in place.`,
      evidence: { ...base, stopped: false, cessation },
    });
  }

  /**
   * Observes the real cancellation markers rather than trusting the stop call:
   * the worker state must have left its active states, any recorded container
   * must no longer be up, and an abort marker set by this stop must have been
   * consumed by the worker. An unreadable container is never read as stopped.
   */
  private async observeCessation(
    taskId: string,
    requireMarkerCleared: boolean,
    receivedAt: number,
  ): Promise<Record<string, unknown> & { stopped: boolean; reason?: string }> {
    let last: Record<string, unknown> & { stopped: boolean; reason?: string } = {
      stopped: false, reason: 'No cessation observation completed.',
    };
    for (;;) {
      last = await this.observeCessationOnce(taskId, requireMarkerCleared);
      if (last.stopped) return { ...last, observedAfterMs: this.now() - receivedAt };
      if (this.now() - receivedAt >= CESSATION_CONFIRM_TARGET_MS) {
        return { ...last, observedAfterMs: this.now() - receivedAt, deadlineMs: CESSATION_CONFIRM_TARGET_MS };
      }
      await this.wait(CESSATION_POLL_INTERVAL_MS);
    }
  }

  private async observeCessationOnce(
    taskId: string,
    requireMarkerCleared: boolean,
  ): Promise<Record<string, unknown> & { stopped: boolean; reason?: string }> {
    const [stateData, marker] = await Promise.all([
      this.deps.redisClient.get(`worker:state:${taskId}`),
      this.deps.redisClient.get(`worker:abort:${taskId}`),
    ]);
    const workerState = readWorkerState(stateData);
    const workerActive = workerState.currentState !== null && ACTIVE_WORKER_STATES.has(workerState.currentState);
    const container = this.observeContainer(workerState.containerId);
    const markerCleared = marker === null;
    const blockers: string[] = [];
    if (workerActive) blockers.push(`the worker is still in state "${workerState.currentState}"`);
    if (container.status === 'running') blockers.push(`container ${workerState.containerId} is still up`);
    if (container.status === 'unobservable') blockers.push(`container ${workerState.containerId} could not be inspected`);
    if (requireMarkerCleared && !markerCleared) blockers.push('the worker has not yet consumed the abort marker');
    const evidence = {
      workerState: workerState.currentState,
      containerId: workerState.containerId,
      containerEvidence: container.status,
      containerStatus: container.detail,
      abortMarkerCleared: markerCleared,
      abortMarkerRequired: requireMarkerCleared,
    };
    if (blockers.length === 0) return { ...evidence, stopped: true };
    return { ...evidence, stopped: false, reason: `Cessation is not confirmed because ${blockers.join(', and ')}.` };
  }

  private observeContainer(containerId: string | null): { status: string; detail: string | null } {
    if (!containerId) return { status: 'not-applicable', detail: null };
    try {
      const detail = this.observeContainerStatus(containerId);
      if (!detail) return { status: 'absent', detail: null };
      return { status: /\bUp\b/.test(detail) ? 'running' : 'exited', detail };
    } catch (error) {
      return { status: 'unobservable', detail: (error as Error).message };
    }
  }

  /**
   * ProPR runs an attempt inside a Docker container that cannot be safely
   * suspended or checkpointed mid-run, so pausing an active attempt is refused
   * outright rather than reported as paused. Between attempts there is a safe
   * checkpoint — the last durable journal cursor — and pause holds there.
   */
  private pause(
    state: OperationControlState,
    request: ControlRequest,
    targeting: { target: ControlTarget | null; active: EzerActiveAttempt | null },
    receivedAt: number,
  ): ControlConfirmation {
    const active = targeting.active;
    if (active && !active.completed && !active.fenced) {
      return this.settle('pause', receivedAt, {
        status: 'refused',
        summary: `Attempt ${active.attemptId} is still running and was not paused.`,
        reasonCode: 'PAUSE_NOT_SUPPORTED_FOR_ACTIVE_ATTEMPT',
        reason: 'ProPR executes this attempt in a Docker container that supports neither safe suspension nor a mid-run checkpoint, so it cannot be paused.',
        recovery: 'Cancel the attempt — its journal evidence is preserved — and resume from the last durable cursor, or wait for it to reach a result.',
        evidence: { paused: false, stillRunning: true, activeAttempt: active },
      });
    }
    if (state.pause && !state.pause.resumed) {
      return this.settle('pause', receivedAt, {
        status: 'refused',
        summary: 'The operation is already paused at a safe checkpoint; no second pause was recorded.',
        reasonCode: 'ALREADY_PAUSED',
        reason: `Pause ${state.pause.commandId} is still in effect at cursor ${state.pause.checkpointCursor ?? 'unset'}.`,
        recovery: 'Resume the existing pause before pausing again.',
        evidence: { paused: true, pause: state.pause },
      });
    }
    const pause: PauseRecord = {
      commandId: request.commandId,
      mode: 'checkpointed',
      pausedAt: new Date(this.now()).toISOString(),
      checkpointCursor: this.streaming()?.getOperationCursor(request.operationId) ?? null,
      resumed: false,
    };
    state.pause = pause;
    return this.settle('pause', receivedAt, {
      status: 'confirmed',
      summary: `Operation paused at the safe checkpoint ${pause.checkpointCursor ?? 'before any durable cursor'}; no attempt is running.`,
      evidence: { paused: true, mode: pause.mode, pause },
    });
  }

  /** Reconciles the saved checkpoint and starts at most one continuation. */
  private resume(
    state: OperationControlState,
    request: ControlRequest,
    targeting: { target: ControlTarget | null; active: EzerActiveAttempt | null },
    receivedAt: number,
  ): ControlConfirmation {
    const active = targeting.active;
    if (active && !active.completed && !active.fenced) {
      return this.settle('resume', receivedAt, {
        status: 'refused',
        summary: `Attempt ${active.attemptId} is already running; no duplicate continuation was started.`,
        reasonCode: 'ATTEMPT_ALREADY_ACTIVE',
        reason: 'Resuming would duplicate an attempt that is already executing.',
        recovery: 'Wait for the active attempt to finish, or cancel it before resuming.',
        evidence: { resumed: false, continuationsCreated: state.continuationCount, activeAttempt: active },
      });
    }
    if (!state.pause || state.pause.resumed) {
      const priorPause = state.pause ?? state.pauseHistory[state.pauseHistory.length - 1] ?? null;
      return this.settle('resume', receivedAt, {
        status: 'refused',
        summary: priorPause
          ? 'That pause was already resumed; exactly one continuation exists.'
          : 'The operation is not paused, so there is nothing to resume.',
        reasonCode: priorPause ? 'ALREADY_RESUMED' : 'NOT_PAUSED',
        reason: priorPause
          ? `Pause ${priorPause.commandId} was resumed at ${priorPause.resumedAt} as continuation ${priorPause.continuationId}.`
          : 'No pause checkpoint is recorded for this operation.',
        recovery: priorPause
          ? 'Reuse the existing continuation; a second resume would duplicate the attempt.'
          : 'Pause the operation before resuming it.',
        evidence: { resumed: false, continuationsCreated: state.continuationCount, pause: priorPause },
      });
    }
    const pause = state.pause;
    state.continuationCount += 1;
    pause.resumed = true;
    pause.resumedAt = new Date(this.now()).toISOString();
    pause.continuationId = `${request.operationId}:continuation:${state.continuationCount}`;
    state.pauseHistory.push(pause);
    state.pause = null;
    return this.settle('resume', receivedAt, {
      status: 'confirmed',
      summary: `Resumed from checkpoint ${pause.checkpointCursor ?? 'the start of the operation'} as continuation ${pause.continuationId}.`,
      evidence: {
        resumed: true, continuationId: pause.continuationId,
        resumedFromCursor: pause.checkpointCursor, continuationsCreated: state.continuationCount,
      },
    });
  }

  /** Appends an ordered revision; prior revisions and their states are kept. */
  private steer(
    state: OperationControlState,
    request: ControlRequest,
    targeting: { target: ControlTarget | null; active: EzerActiveAttempt | null },
    receivedAt: number,
  ): ControlConfirmation {
    const target = targeting.target!;
    const active = targeting.active;
    if (active && (active.completed || active.fenced)) {
      return this.settle('steer', receivedAt, {
        status: 'refused',
        summary: `Attempt ${active.attemptId} is ${active.fenced ? 'fenced' : 'finished'} and cannot be steered.`,
        reasonCode: 'ATTEMPT_NOT_STEERABLE',
        reason: 'A fenced or completed attempt produces no further activity, and a replacement attempt must not inherit this redirect.',
        recovery: 'Resend the steer against the replacement attempt once it starts publishing, under a new commandId.',
        evidence: { accepted: false, redirected: false, revisions: summarizeRevisions(state.revisions) },
      });
    }
    const revision: SteeringRevision = {
      version: state.revisions.length + 1,
      commandId: request.commandId,
      payloadFingerprint: request.payloadFingerprint,
      payload: request.payload,
      target,
      state: 'accepted',
      acceptedAt: new Date(this.now()).toISOString(),
      acceptedAtCursor: this.streaming()?.getOperationCursor(request.operationId) ?? null,
    };
    state.revisions.push(revision);
    return this.settle('steer', receivedAt, {
      status: 'confirmed',
      summary: `Steering revision v${revision.version} accepted for attempt ${target.attemptId}; it is not applied until subsequent activity follows it.`,
      evidence: {
        accepted: true, applied: false, version: revision.version,
        revisions: summarizeRevisions(state.revisions),
      },
    });
  }

  describe(operationId: string): Record<string, unknown> {
    const state = this.states.get(operationId);
    const active = this.streaming()?.getActiveAttempt(operationId) ?? null;
    if (!state) {
      return {
        operationId, activeAttempt: active, taskId: null, paused: false, pause: null,
        steering: [], fencedAttempts: [], commands: [], continuationsCreated: 0,
      };
    }
    return {
      operationId,
      activeAttempt: active,
      taskId: state.taskId,
      paused: state.pause !== null,
      pause: state.pause,
      pauseHistory: state.pauseHistory,
      steering: summarizeRevisions(state.revisions),
      fencedAttempts: state.fenced,
      continuationsCreated: state.continuationCount,
      commands: [...state.ledger.values()].map(entry => ({
        commandId: entry.commandId, command: entry.command,
        payloadFingerprint: entry.payloadFingerprint, duplicateDeliveries: entry.duplicateDeliveries,
        ack: entry.ack, confirmation: entry.confirmation,
      })),
    };
  }
}

function summarizeRevisions(revisions: SteeringRevision[]): Record<string, unknown>[] {
  return revisions.map(revision => ({
    version: revision.version, commandId: revision.commandId, state: revision.state,
    payload: revision.payload, payloadFingerprint: revision.payloadFingerprint, target: revision.target,
    acceptedAt: revision.acceptedAt, acceptedAtCursor: revision.acceptedAtCursor,
    ...(revision.appliedAt ? { appliedAt: revision.appliedAt, appliedAtCursor: revision.appliedAtCursor } : {}),
  }));
}

function readWorkerState(stateData: string | null): { currentState: string | null; containerId: string | null } {
  if (!stateData) return { currentState: null, containerId: null };
  try {
    const parsed = JSON.parse(stateData) as {
      history?: Array<{ state?: string; metadata?: { containerId?: string } }>;
    };
    const history = Array.isArray(parsed.history) ? parsed.history : [];
    const containerEntry = history.find(entry => entry.state === 'claude_execution' && entry.metadata?.containerId);
    return {
      currentState: history[history.length - 1]?.state ?? null,
      containerId: containerEntry?.metadata?.containerId ?? null,
    };
  } catch {
    // A corrupt state record must not be read as "stopped"; treat it as unknown.
    return { currentState: null, containerId: null };
  }
}

/**
 * Control routes for an Ezer operation. They sit behind the authenticated
 * `/api` guard and additionally require the same access the operation's
 * progress stream requires, so control is never broader than read access.
 */
export function createEzerControlRoutes(deps: EzerControlRoutesDeps) {
  const service = new EzerControlService(deps);

  async function authorize(req: FlatRequest, res: Response, operationId: string): Promise<boolean> {
    const streaming = deps.getStreaming();
    const userId = req.user?.id;
    if (!streaming || !userId) {
      res.status(503).json({
        error: contractError('CONTROL_PLANE_UNAVAILABLE', 'The Ezer stream projection is not available on this node.', {
          knownCause: 'socket projection not initialised',
          persistedState: 'No control state changed.',
          remainingActivity: 'Any running attempt continues unchanged.',
          retryPath: 'Retry once the API node has finished starting up.',
        }),
      });
      return false;
    }
    const allowed = await streaming.authorizeSubscription(operationId, {
      user: { id: userId },
      authorization: { permissions: req.authorization?.permissions ?? [] },
    });
    if (!allowed) {
      res.status(404).json({
        error: contractError('OPERATION_NOT_FOUND', 'No accessible Ezer operation matches that ID.', {
          knownCause: 'unknown operation or insufficient access',
          persistedState: 'No control state changed.',
          remainingActivity: 'unknown',
          retryPath: 'Verify the operation ID and your access to it.',
        }),
      });
      return false;
    }
    return true;
  }

  function readOperationId(req: FlatRequest, res: Response): string | null {
    const operationId = typeof req.params.operationId === 'string' ? req.params.operationId.trim() : '';
    if (!operationId || operationId.length > MAX_IDENTIFIER_LENGTH) {
      res.status(400).json({
        error: contractError('INVALID_OPERATION_ID', 'A non-empty operation ID is required.', {
          knownCause: 'malformed operation ID',
          persistedState: 'No control state changed.',
          remainingActivity: 'unknown',
          retryPath: 'Resend the request with a valid operation ID.',
        }),
      });
      return null;
    }
    return operationId;
  }

  async function postControl(req: FlatRequest, res: Response): Promise<void> {
    const operationId = readOperationId(req, res);
    if (!operationId) return;
    try {
      if (!await authorize(req, res, operationId)) return;
      const result = await service.submit(req.body, operationId, req.user?.username || 'user');
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      console.error('[ezer-control] Failed to process control command for %s:', operationId, error);
      res.status(500).json({
        error: contractError('CONTROL_COMMAND_FAILED', 'The control command could not be processed.', {
          knownCause: (error as Error).message,
          persistedState: 'See GET /api/ezer/operations/:operationId/control for what was recorded.',
          remainingActivity: 'unknown — the targeted attempt may still be running.',
          retryPath: 'Re-read the control state, then resend under a new commandId if the command did not take effect.',
        }),
      });
    }
  }

  async function getControlState(req: FlatRequest, res: Response): Promise<void> {
    const operationId = readOperationId(req, res);
    if (!operationId) return;
    try {
      if (!await authorize(req, res, operationId)) return;
      res.json(service.describe(operationId));
    } catch (error) {
      console.error('[ezer-control] Failed to read control state for %s:', operationId, error);
      res.status(500).json({
        error: contractError('CONTROL_STATE_UNREADABLE', 'The control state could not be read.', {
          knownCause: (error as Error).message,
          persistedState: 'Recorded control state is unchanged; only this read failed.',
          remainingActivity: 'unknown — no attempt was altered by this request.',
          retryPath: 'Retry the read; no command was issued.',
        }),
      });
    }
  }

  return { postControl, getControlState };
}

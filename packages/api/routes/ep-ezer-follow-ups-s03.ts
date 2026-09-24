/* eslint-disable max-lines -- the contract.md control surface (command types,
   error/ack/confirmation shapes and the four commands) is kept in one module so
   the acknowledgement-vs-confirmation split cannot drift across files. */
/**
 * EP-ezer-follow-ups-S03 — steering, pause and cancellation control plane
 * (REQ-EF17).
 *
 * ProPR lane of the approved story. This module implements the `pause`,
 * `resume`, `steer` and `cancel` commands defined in `contract.md` and routes
 * them to the real execution through the ownership fence in
 * `@propr/core`'s `ExecutionControlRegistry` (which itself reuses
 * `dockerExecutionOwnership.ts` and `dockerAbortController.ts`).
 *
 * The contract obligations this file is responsible for:
 * - **an ack is never a completion.** Every admitted command returns a
 *   `control-ack` immediately (2s design target) carrying `state: 'accepted'`
 *   and `confirmation: 'pending'`. The real downstream state — stopped, still
 *   running, suspended, saved, applied — arrives later as a separate
 *   `progress`/`result` envelope built from observed evidence.
 * - **commands target the exact active attempt.** A command for a superseded
 *   attempt is rejected and is never redirected onto its replacement.
 * - **idempotency.** `sessionId`+`operationId`+`commandId` is the key; the same
 *   key with the same payload fingerprint dedups to the original ack with no
 *   second effect, and the same key with a different payload is rejected.
 * - **steer is versioned and ordered.** Each admitted revision gets the next
 *   version, is delivered in acceptance order, and keeps `accepted` (received)
 *   and `applied` (took effect) as distinct states without erasing prior
 *   revisions.
 */

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { ExecutionControlRegistry } from '@propr/core';
import type {
  AttemptCancellationOutcome,
  AttemptPauseOutcome,
  AttemptResumeOutcome,
  AttemptSteerOutcome,
} from '@propr/core';
import type { EzerEventEnvelope, EzerProgressDetail } from '../ep-ezer-follow-ups-s02.js';

/** contract.md design targets (proposed, tuned during implementation). */
export const EZER_CONTROL_ACK_TARGET_MS = 2_000;
export const EZER_CESSATION_CONFIRMATION_TARGET_MS = 10_000;

export type EzerControlType = 'pause' | 'resume' | 'steer' | 'cancel';

const CONTROL_TYPES: ReadonlySet<string> = new Set(['pause', 'resume', 'steer', 'cancel']);
const COMMAND_STRING_FIELDS = [
  'requestId', 'sessionId', 'operationId', 'executionId', 'attemptId', 'commandId',
] as const;

export interface EzerControlCommand extends Record<(typeof COMMAND_STRING_FIELDS)[number], string> {
  type: EzerControlType;
  /** Steering instruction; required for `steer` and ignored otherwise. */
  payload?: unknown;
  /** Caller-computed fingerprint; must equal the canonical payload digest. */
  payloadFingerprint?: string;
  issuedBy?: string;
}

export type EzerControlRejectionCode =
  | 'INVALID_COMMAND'
  | 'UNSUPPORTED_COMMAND_TYPE'
  | 'STEER_PAYLOAD_REQUIRED'
  | 'COMMAND_IDEMPOTENCY_CONFLICT'
  | 'PAYLOAD_FINGERPRINT_MISMATCH'
  | 'EXECUTION_NOT_FOUND'
  | 'ATTEMPT_NOT_ACTIVE'
  | 'ATTEMPT_FENCED'
  | 'CONTROL_UNAVAILABLE';

/** contract.md error shape: never a bare/generic error. */
export interface EzerControlRejection {
  code: EzerControlRejectionCode;
  message: string;
  diagnosticId: string;
  knownCause: string;
  persistedState: string;
  remainingActivity: string;
  retryPath: string;
}

export type EzerControlConfirmationState =
  | 'stopped'
  | 'still-running'
  | 'suspended'
  | 'checkpointed'
  | 'resumed'
  | 'applied'
  | 'accepted-not-applied'
  | 'refused';

export interface EzerControlConfirmation {
  commandId: string;
  type: EzerControlType;
  state: EzerControlConfirmationState;
  summary: string;
  reason?: string;
  recovery?: string;
  /** Exactly what was observed downstream; never inferred. */
  evidence?: unknown;
  steerVersion?: number;
  confirmedAt: string;
  /** Milliseconds from acknowledgement to this confirmation. */
  latencyMs: number;
  envelope: EzerEventEnvelope;
}

export interface EzerControlAck {
  accepted: boolean;
  type: EzerControlType;
  commandId: string;
  idempotencyKey: string;
  /** `accepted` means received, never applied or completed. */
  state: 'accepted' | 'rejected';
  /** True when an identical command was already acknowledged; no second effect. */
  deduplicated: boolean;
  confirmation: 'pending' | 'none';
  payloadFingerprint: string;
  ackLatencyMs: number;
  acknowledgedAt: string;
  /** The `control-ack` envelope, or the `error` envelope for a rejection. */
  envelope: EzerEventEnvelope;
  /** Ordinal of the steering revision this command created. */
  steerVersion?: number;
  rejection?: EzerControlRejection;
}

export interface EzerSteerRevision {
  version: number;
  commandId: string;
  executionId: string;
  attemptId: string;
  payloadFingerprint: string;
  payload: unknown;
  /** `accepted` = received and ordered; `applied` = the attempt consumed it. */
  status: 'accepted' | 'applied';
  acceptedAt: string;
  appliedAt: string | null;
  /** Why an accepted revision has not been applied (kept as evidence). */
  notAppliedReason?: string;
  /** The newer revision governing subsequent activity; this one is preserved. */
  supersededBy: number | null;
}

/**
 * Real control surface of the owning execution. `ExecutionControlRegistry`
 * from `@propr/core` satisfies this structurally; tests substitute a fake that
 * exercises the same outcome shapes.
 */
export interface EzerExecutionControlPort {
  getActiveAttemptId(executionId: string): string | null;
  cancel(executionId: string, attemptId: string): Promise<AttemptCancellationOutcome>;
  pause(executionId: string, attemptId: string): Promise<AttemptPauseOutcome>;
  resume(executionId: string, attemptId: string): Promise<AttemptResumeOutcome>;
  steer(executionId: string, attemptId: string, version: number, payload: unknown): Promise<AttemptSteerOutcome>;
}

/**
 * Projection surface used to fence a cancelled attempt and to deliver control
 * envelopes. `EzerStreamingService` (S02) satisfies this structurally.
 */
export interface EzerControlStream {
  fenceAttempt(operationId: string, executionId: string, attemptId: string): void;
  broadcastProjection(operationId: string, envelope: EzerEventEnvelope): void;
  getLastCursor?(operationId: string): string | null;
}

export interface EzerControlServiceOptions {
  port?: EzerExecutionControlPort | null;
  stream?: EzerControlStream | null;
  now?: () => number;
  /** Observes every emitted envelope (control-ack and confirmations alike). */
  onEnvelope?: (envelope: EzerEventEnvelope) => void;
}

interface CommandRecord {
  key: string;
  command: EzerControlCommand;
  fingerprint: string;
  ack: EzerControlAck;
  settled: Promise<EzerControlConfirmation | null>;
  confirmation: EzerControlConfirmation | null;
}

/** Canonical JSON so an equivalent payload always digests identically. */
function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const source = value as Record<string, unknown>;
  const entries = Object.keys(source).sort()
    .filter(key => source[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalize(source[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Digest of everything that makes two commands the same request: the command
 * type, its exact target and its payload. Two commands sharing an idempotency
 * key but differing in any of these are conflicting, not duplicate.
 */
export function ezerPayloadFingerprint(command: Pick<EzerControlCommand, 'type' | 'executionId' | 'attemptId' | 'payload'>): string {
  return createHash('sha256').update(canonicalize({
    type: command.type,
    executionId: command.executionId,
    attemptId: command.attemptId,
    payload: command.payload ?? null,
  })).digest('hex');
}

export function ezerIdempotencyKey(command: Pick<EzerControlCommand, 'sessionId' | 'operationId' | 'commandId'>): string {
  return `${command.sessionId}|${command.operationId}|${command.commandId}`;
}

function readCommandString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** Validates and rebuilds a control command from an untrusted request body. */
export function parseEzerControlCommand(raw: unknown): { command?: EzerControlCommand; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'A command object is required.' };
  const source = raw as Record<string, unknown>;
  if (typeof source.type !== 'string' || !CONTROL_TYPES.has(source.type)) {
    return { error: 'type must be one of pause, resume, steer, cancel.' };
  }
  const command: Partial<EzerControlCommand> = { type: source.type as EzerControlType };
  for (const field of COMMAND_STRING_FIELDS) {
    const value = readCommandString(source, field);
    if (!value) return { error: `${field} is required.` };
    command[field] = value;
  }
  if (source.payload !== undefined) command.payload = source.payload;
  const fingerprint = readCommandString(source, 'payloadFingerprint');
  if (fingerprint) command.payloadFingerprint = fingerprint;
  const issuedBy = readCommandString(source, 'issuedBy');
  if (issuedBy) command.issuedBy = issuedBy;
  if (command.type === 'steer' && command.payload === undefined) {
    return { error: 'steer requires a payload carrying the revised instruction.' };
  }
  return { command: command as EzerControlCommand };
}

/**
 * Control plane for a running Ezer operation: admits commands, acknowledges
 * them immediately, then confirms the real downstream state separately.
 */
export class EzerControlService {
  private readonly commandsByKey = new Map<string, CommandRecord>();
  /** Convenience index for reads. Idempotency is decided on the full key
   *  above; the HTTP read path additionally verifies the operation. */
  private readonly commandsById = new Map<string, CommandRecord>();
  private readonly steerRevisions = new Map<string, EzerSteerRevision[]>();
  /** Serializes effects per execution so ordering matches acceptance order. */
  private readonly effectChains = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly onEnvelope: ((envelope: EzerEventEnvelope) => void) | null;
  private port: EzerExecutionControlPort | null;
  private stream: EzerControlStream | null;

  constructor(options: EzerControlServiceOptions = {}) {
    this.port = options.port ?? null;
    this.stream = options.stream ?? null;
    this.now = options.now ?? Date.now;
    this.onEnvelope = options.onEnvelope ?? null;
  }

  setPort(port: EzerExecutionControlPort | null): void { this.port = port; }
  setStream(stream: EzerControlStream | null): void { this.stream = stream; }

  /** The bound execution control surface — where the Ezer execution binding
   *  registers each attempt so commands reach the exact active one. */
  getPort(): EzerExecutionControlPort | null { return this.port; }

  /**
   * Admits one control command and acknowledges it. The returned ack reports
   * receipt only; the real downstream state is confirmed later and is
   * observable through {@link settle} or the projected stream.
   */
  async submit(command: EzerControlCommand): Promise<EzerControlAck> {
    const receivedAt = this.now();
    const key = ezerIdempotencyKey(command);
    const fingerprint = ezerPayloadFingerprint(command);
    const context = { key, fingerprint, receivedAt };

    if (command.payloadFingerprint && command.payloadFingerprint !== fingerprint) {
      return this.reject(command, context, {
        code: 'PAYLOAD_FINGERPRINT_MISMATCH',
        message: 'The supplied payloadFingerprint does not match the canonical digest of this command.',
        knownCause: 'the caller computed the fingerprint over different bytes than it sent',
        retryPath: 'Recompute the fingerprint over the exact payload and resubmit with the same commandId.',
      });
    }

    const existing = this.commandsByKey.get(key);
    if (existing) {
      if (existing.fingerprint === fingerprint) {
        // Exact duplicate: return the original acknowledgement. No second
        // cancellation, suspension or steering revision is produced.
        return { ...existing.ack, deduplicated: true, ackLatencyMs: Math.max(0, this.now() - receivedAt) };
      }
      return this.reject(command, context, {
        code: 'COMMAND_IDEMPOTENCY_CONFLICT',
        message: `commandId ${command.commandId} was already accepted with a different payload.`,
        knownCause: 'the same idempotency key was reused for a conflicting command',
        retryPath: 'Issue the conflicting command under a new commandId; the original command is unaffected.',
      });
    }

    if (!this.port) {
      return this.reject(command, context, {
        code: 'CONTROL_UNAVAILABLE',
        message: 'No execution control port is bound on this node, so the command could not reach the execution.',
        knownCause: 'control port not configured',
        retryPath: 'Retry against a node bound to the execution, or stop the task directly via POST /api/task/:taskId/stop.',
      });
    }

    const activeAttemptId = this.port.getActiveAttemptId(command.executionId);
    if (activeAttemptId === null) {
      return this.reject(command, context, {
        code: 'EXECUTION_NOT_FOUND',
        message: `Execution ${command.executionId} has no controlled attempt on this node.`,
        knownCause: 'the execution is unknown here — it may have finished or never started on this node',
        retryPath: 'Re-read the execution from the journal and re-issue against its current attempt.',
      });
    }
    if (activeAttemptId !== command.attemptId) {
      return this.reject(command, context, {
        code: 'ATTEMPT_NOT_ACTIVE',
        message: `Attempt ${command.attemptId} is not the active attempt for execution ${command.executionId}; `
          + `the command was rejected and was NOT redirected to attempt ${activeAttemptId}.`,
        knownCause: 'the targeted attempt was superseded before the command arrived',
        retryPath: `Re-issue the command against attempt ${activeAttemptId} under a new commandId if it still applies.`,
        extras: { activeAttemptId },
      });
    }

    const steerVersion = command.type === 'steer'
      ? this.appendSteerRevision(command, fingerprint)
      : undefined;

    if (command.type === 'cancel') {
      // Fence before any propagation: from acknowledgement onward the targeted
      // attempt may not publish, even though a replacement may not exist yet.
      this.stream?.fenceAttempt(command.operationId, command.executionId, command.attemptId);
    }

    const acknowledgedAt = this.now();
    const envelope = this.buildEnvelope(command, 'control-ack', {
      summary: `Accepted ${command.type} for attempt ${command.attemptId}; `
        + 'downstream state will be confirmed separately.',
    });
    const ack: EzerControlAck = {
      accepted: true,
      type: command.type,
      commandId: command.commandId,
      idempotencyKey: key,
      state: 'accepted',
      deduplicated: false,
      confirmation: 'pending',
      payloadFingerprint: fingerprint,
      ackLatencyMs: Math.max(0, acknowledgedAt - receivedAt),
      acknowledgedAt: this.iso(acknowledgedAt),
      envelope,
      ...(steerVersion === undefined ? {} : { steerVersion }),
    };
    const record: CommandRecord = {
      key, command, fingerprint, ack,
      settled: Promise.resolve(null),
      confirmation: null,
    };
    this.commandsByKey.set(key, record);
    this.commandsById.set(command.commandId, record);
    this.emit(envelope);
    record.settled = this.scheduleEffect(record, acknowledgedAt, steerVersion);
    return ack;
  }

  /** Resolves once the command's real downstream state has been confirmed. */
  settle(commandId: string): Promise<EzerControlConfirmation | null> {
    return this.commandsById.get(commandId)?.settled ?? Promise.resolve(null);
  }

  getAck(commandId: string): EzerControlAck | null {
    return this.commandsById.get(commandId)?.ack ?? null;
  }

  getConfirmation(commandId: string): EzerControlConfirmation | null {
    return this.commandsById.get(commandId)?.confirmation ?? null;
  }

  /**
   * Every steering revision ever accepted for an execution, in version order.
   * Superseded revisions are preserved with their payload and status — a later
   * revision never erases the evidence of an earlier one.
   */
  listSteerRevisions(executionId: string): EzerSteerRevision[] {
    return (this.steerRevisions.get(executionId) ?? []).map(revision => ({ ...revision }));
  }

  private appendSteerRevision(command: EzerControlCommand, fingerprint: string): number {
    const revisions = this.steerRevisions.get(command.executionId) ?? [];
    const previous = revisions[revisions.length - 1];
    const revision: EzerSteerRevision = {
      version: revisions.length + 1,
      commandId: command.commandId,
      executionId: command.executionId,
      attemptId: command.attemptId,
      payloadFingerprint: fingerprint,
      payload: command.payload,
      status: 'accepted',
      acceptedAt: this.iso(this.now()),
      appliedAt: null,
      supersededBy: null,
    };
    if (previous) previous.supersededBy = revision.version;
    revisions.push(revision);
    this.steerRevisions.set(command.executionId, revisions);
    return revision.version;
  }

  /**
   * Queues the command's real effect behind the execution's earlier effects so
   * revisions and lifecycle commands apply in acceptance order.
   */
  private scheduleEffect(
    record: CommandRecord,
    acknowledgedAt: number,
    steerVersion: number | undefined,
  ): Promise<EzerControlConfirmation | null> {
    const previous = this.effectChains.get(record.command.executionId) ?? Promise.resolve();
    const settled = previous
      .catch(() => undefined)
      .then(() => this.applyEffect(record, acknowledgedAt, steerVersion));
    this.effectChains.set(record.command.executionId, settled.catch(() => undefined));
    return settled;
  }

  private async applyEffect(
    record: CommandRecord,
    acknowledgedAt: number,
    steerVersion: number | undefined,
  ): Promise<EzerControlConfirmation> {
    const { command } = record;
    const port = this.port!;
    let confirmation: EzerControlConfirmation;
    try {
      switch (command.type) {
        case 'cancel':
          confirmation = this.confirmCancel(command, acknowledgedAt,
            await port.cancel(command.executionId, command.attemptId));
          break;
        case 'pause':
          confirmation = this.confirmPause(command, acknowledgedAt,
            await port.pause(command.executionId, command.attemptId));
          break;
        case 'resume':
          confirmation = this.confirmResume(command, acknowledgedAt,
            await port.resume(command.executionId, command.attemptId));
          break;
        default:
          confirmation = this.confirmSteer(command, acknowledgedAt, steerVersion!,
            await port.steer(command.executionId, command.attemptId, steerVersion!, command.payload));
      }
    } catch (error) {
      confirmation = this.buildConfirmation(command, acknowledgedAt, 'still-running', {
        summary: `The ${command.type} command could not be applied to attempt ${command.attemptId}.`,
        reason: `Control propagation failed: ${(error as Error).message}`,
        recovery: 'Re-issue the command with a new commandId; no downstream state change was confirmed.',
        envelopeType: 'progress',
        detail: {
          kind: 'blocker',
          cause: `control propagation failed: ${(error as Error).message}`,
          nextAction: 'Re-issue the command with a new commandId.',
        },
      });
    }
    // The acknowledgement is left exactly as it was returned to the caller:
    // it recorded receipt, and this confirmation is the separate later fact.
    record.confirmation = confirmation;
    this.emit(confirmation.envelope);
    return confirmation;
  }

  private confirmCancel(
    command: EzerControlCommand,
    acknowledgedAt: number,
    outcome: AttemptCancellationOutcome,
  ): EzerControlConfirmation {
    if (outcome.outcome === 'refused') {
      return this.buildConfirmation(command, acknowledgedAt, 'refused', {
        summary: `Cancellation of attempt ${command.attemptId} was refused; nothing was stopped.`,
        reason: outcome.detail,
        recovery: outcome.recovery,
        evidence: { refusalReason: outcome.reason, activeAttemptId: outcome.activeAttemptId },
        envelopeType: 'progress',
        detail: { kind: 'blocker', cause: outcome.detail, nextAction: outcome.recovery },
      });
    }
    if (outcome.outcome === 'stopped') {
      return this.buildConfirmation(command, acknowledgedAt, 'stopped', {
        summary: `Attempt ${command.attemptId} stopped: no owned container remains and the owned child has exited.`,
        evidence: outcome.evidence,
        envelopeType: 'result',
      });
    }
    return this.buildConfirmation(command, acknowledgedAt, 'still-running', {
      summary: `Attempt ${command.attemptId} is still running; cancellation was propagated but cessation is unconfirmed.`,
      reason: outcome.reason,
      recovery: outcome.recovery,
      evidence: outcome.evidence,
      envelopeType: 'progress',
      detail: {
        kind: 'blocker',
        cause: outcome.reason ?? 'cessation unconfirmed',
        nextAction: outcome.recovery ?? 'Re-issue the cancel with a new commandId.',
      },
    });
  }

  private confirmPause(
    command: EzerControlCommand,
    acknowledgedAt: number,
    outcome: AttemptPauseOutcome,
  ): EzerControlConfirmation {
    if (outcome.outcome === 'refused') {
      return this.buildConfirmation(command, acknowledgedAt, 'refused', {
        // The command was acknowledged, but nothing was paused — saying
        // anything else here would be a false paused claim.
        summary: `Attempt ${command.attemptId} was NOT paused and is still running.`,
        reason: outcome.detail,
        recovery: outcome.recovery,
        evidence: { refusalReason: outcome.reason },
        envelopeType: 'progress',
        detail: { kind: 'blocker', cause: outcome.detail, nextAction: outcome.recovery },
      });
    }
    if (outcome.outcome === 'suspended') {
      return this.buildConfirmation(command, acknowledgedAt, 'suspended', {
        summary: `Attempt ${command.attemptId} is safely suspended in place; `
          + `${outcome.suspendedContainers.length} container(s) are frozen and not stopped.`,
        evidence: { suspendedContainers: outcome.suspendedContainers, caveat: outcome.caveat },
        envelopeType: 'progress',
        detail: { kind: 'stop', reason: outcome.caveat ?? 'execution frozen in place' },
      });
    }
    return this.buildConfirmation(command, acknowledgedAt, 'checkpointed', {
      summary: `Attempt ${command.attemptId} was checkpointed and stopped; its state is saved.`,
      evidence: { persistedState: outcome.persistedState, cessation: outcome.evidence },
      envelopeType: 'progress',
      detail: { kind: 'stop', reason: outcome.persistedState },
    });
  }

  private confirmResume(
    command: EzerControlCommand,
    acknowledgedAt: number,
    outcome: AttemptResumeOutcome,
  ): EzerControlConfirmation {
    if (outcome.outcome === 'refused') {
      return this.buildConfirmation(command, acknowledgedAt, 'refused', {
        summary: `Attempt ${command.attemptId} was not resumed; no continuation was started.`,
        reason: outcome.detail,
        recovery: outcome.recovery,
        evidence: { refusalReason: outcome.reason },
        envelopeType: 'progress',
        detail: { kind: 'blocker', cause: outcome.detail, nextAction: outcome.recovery },
      });
    }
    return this.buildConfirmation(command, acknowledgedAt, 'resumed', {
      summary: `Attempt ${command.attemptId} resumed (${outcome.mode}); exactly one continuation is eligible.`,
      evidence: { mode: outcome.mode, continuationToken: outcome.continuationToken, detail: outcome.detail },
      envelopeType: 'progress',
      detail: { kind: 'start' },
    });
  }

  private confirmSteer(
    command: EzerControlCommand,
    acknowledgedAt: number,
    version: number,
    outcome: AttemptSteerOutcome,
  ): EzerControlConfirmation {
    const revision = this.findRevision(command.executionId, version);
    if (outcome.outcome === 'refused') {
      // The revision stays `accepted`: it was received and ordered, but it did
      // not take effect. Recording it as applied would erase that distinction.
      if (revision) revision.notAppliedReason = outcome.detail;
      return this.buildConfirmation(command, acknowledgedAt, 'accepted-not-applied', {
        summary: `Steering revision ${version} is accepted but NOT applied to attempt ${command.attemptId}.`,
        reason: outcome.detail,
        recovery: outcome.recovery,
        evidence: { refusalReason: outcome.reason, version },
        steerVersion: version,
        envelopeType: 'progress',
        detail: { kind: 'blocker', cause: outcome.detail, nextAction: outcome.recovery },
      });
    }
    if (revision) {
      revision.status = 'applied';
      revision.appliedAt = this.iso(this.now());
      delete revision.notAppliedReason;
    }
    return this.buildConfirmation(command, acknowledgedAt, 'applied', {
      summary: `Steering revision ${version} was applied; it governs the subsequent activity of attempt ${command.attemptId}.`,
      evidence: { version },
      steerVersion: version,
      envelopeType: 'progress',
      detail: { kind: 'intermediate' },
    });
  }

  private findRevision(executionId: string, version: number): EzerSteerRevision | undefined {
    return this.steerRevisions.get(executionId)?.find(entry => entry.version === version);
  }

  private buildConfirmation(
    command: EzerControlCommand,
    acknowledgedAt: number,
    state: EzerControlConfirmationState,
    options: {
      summary: string;
      reason?: string;
      recovery?: string;
      evidence?: unknown;
      steerVersion?: number;
      envelopeType: 'progress' | 'result';
      detail?: EzerProgressDetail;
    },
  ): EzerControlConfirmation {
    const confirmedAt = this.now();
    const envelope = this.buildEnvelope(command, options.envelopeType, {
      summary: options.summary,
      detail: options.detail,
    });
    return {
      commandId: command.commandId,
      type: command.type,
      state,
      summary: options.summary,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
      ...(options.steerVersion === undefined ? {} : { steerVersion: options.steerVersion }),
      confirmedAt: this.iso(confirmedAt),
      latencyMs: Math.max(0, confirmedAt - acknowledgedAt),
      envelope,
    };
  }

  private reject(
    command: EzerControlCommand,
    context: { key: string; fingerprint: string; receivedAt: number },
    cause: {
      code: EzerControlRejectionCode;
      message: string;
      knownCause: string;
      retryPath: string;
      extras?: Record<string, unknown>;
    },
  ): EzerControlAck {
    const { key, fingerprint, receivedAt } = context;
    const { code, message, knownCause, retryPath, extras } = cause;
    const diagnosticId = `ctl-${code.toLowerCase()}-${command.commandId}`;
    const rejection: EzerControlRejection = {
      code, message, diagnosticId, knownCause,
      persistedState: 'No control effect was applied; prior commands and steering revisions are unchanged.',
      remainingActivity: 'The targeted execution continues exactly as before this command.',
      retryPath,
    };
    const envelope = this.buildEnvelope(command, 'error', {
      summary: message,
      diagnosticId,
      error: {
        code, message, diagnosticId, knownCause,
        persistedState: rejection.persistedState,
        remainingActivity: rejection.remainingActivity,
        retryPath,
      },
    });
    this.emit(envelope);
    return {
      accepted: false,
      type: command.type,
      commandId: command.commandId,
      idempotencyKey: key,
      state: 'rejected',
      deduplicated: false,
      confirmation: 'none',
      payloadFingerprint: fingerprint,
      ackLatencyMs: Math.max(0, this.now() - receivedAt),
      acknowledgedAt: this.iso(this.now()),
      envelope,
      rejection: { ...rejection, ...extras },
    };
  }

  private buildEnvelope(
    command: EzerControlCommand,
    type: EzerEventEnvelope['type'],
    parts: {
      summary: string;
      detail?: EzerProgressDetail;
      diagnosticId?: string;
      error?: EzerEventEnvelope['error'];
    },
  ): EzerEventEnvelope {
    return {
      type,
      requestId: command.requestId,
      sessionId: command.sessionId,
      operationId: command.operationId,
      executionId: command.executionId,
      attemptId: command.attemptId,
      // Control envelopes are projection-level signals, not journal entries:
      // like S02 heartbeats they reuse the last durable cursor and never
      // advance it, so the journal remains the sole replay authority.
      cursor: this.stream?.getLastCursor?.(command.operationId) ?? '0',
      ts: this.iso(this.now()),
      summary: parts.summary,
      ...(parts.diagnosticId === undefined ? {} : { diagnosticId: parts.diagnosticId }),
      ...(parts.detail === undefined ? {} : { detail: parts.detail }),
      ...(parts.error === undefined ? {} : { error: parts.error }),
    };
  }

  private emit(envelope: EzerEventEnvelope): void {
    try {
      this.stream?.broadcastProjection(envelope.operationId, envelope);
    } catch (error) {
      console.error(`[EzerControl] Failed to project control envelope for ${envelope.operationId}:`, error);
    }
    this.onEnvelope?.(envelope);
  }

  private iso(at: number): string { return new Date(at).toISOString(); }
}

/** Minimal Redis surface needed to own the worker abort marker. */
export interface EzerControlRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
}

/**
 * Builds the execution control registry the control plane targets.
 *
 * The API process does not own the agent child process — the worker does — so
 * cancellation propagates through the same `worker:abort:<taskId>` marker the
 * worker's existing abort checker already polls, and the registry confirms
 * cessation by observing the attempt's labelled containers. The Ezer execution
 * binding registers each attempt on the returned registry so commands reach
 * the exact active attempt.
 */
export function createEzerExecutionControl(redisClient: EzerControlRedisClient): ExecutionControlRegistry {
  return new ExecutionControlRegistry({
    publishAbortMarker: async taskId => {
      await redisClient.set(`worker:abort:${taskId}`, JSON.stringify({
        timestamp: new Date().toISOString(),
        requestedBy: 'ezer-control',
        reason: 'ezer_control_cancel',
      }), { EX: 3600 });
      return true;
    },
    readAbortMarker: async taskId => await redisClient.get(`worker:abort:${taskId}`) !== null,
  });
}

/** HTTP status for each rejection code; acceptance is 202 (ack, not result). */
const REJECTION_STATUS: Record<EzerControlRejectionCode, number> = {
  INVALID_COMMAND: 400,
  UNSUPPORTED_COMMAND_TYPE: 400,
  STEER_PAYLOAD_REQUIRED: 400,
  COMMAND_IDEMPOTENCY_CONFLICT: 409,
  PAYLOAD_FINGERPRINT_MISMATCH: 409,
  EXECUTION_NOT_FOUND: 404,
  ATTEMPT_NOT_ACTIVE: 409,
  ATTEMPT_FENCED: 409,
  CONTROL_UNAVAILABLE: 503,
};

export interface EzerControlRoutesDeps {
  /** Resolved per request: the control plane lives on the socket service,
   *  which is initialized after routes are registered. */
  getService: () => EzerControlService | null;
  /** Authorizes the caller for the operation (owner or instance manager). */
  authorize: (operationId: string, principal: { user: { id: string }; authorization: { permissions: string[] } }) => Promise<boolean>;
}

/**
 * HTTP surface for the control commands. `POST` returns 202 with the
 * `control-ack` — deliberately not 200, because acknowledgement is not
 * completion; the confirmed downstream state is read separately or observed on
 * the operation stream.
 */
export function createEzerControlRoutes({ getService, authorize }: EzerControlRoutesDeps) {
  const resolveService = (res: Response): EzerControlService | null => {
    const service = getService();
    if (!service) {
      res.status(503).json({
        code: 'CONTROL_UNAVAILABLE',
        error: 'The Ezer control plane is not available on this node.',
        retryPath: 'Retry once the realtime service is running, or stop the task directly via POST /api/task/:taskId/stop.',
      });
      return null;
    }
    return service;
  };

  const authorizeRequest = async (req: Request, res: Response, operationId: string): Promise<boolean> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return false;
    }
    const principal = {
      user: { id: user.id },
      authorization: { permissions: [...(req.authorization?.permissions ?? [])] },
    };
    if (!await authorize(operationId, principal)) {
      res.status(403).json({ error: 'Not authorized for this operation' });
      return false;
    }
    return true;
  };

  return {
    /** Submit a pause/resume/steer/cancel command for an operation. */
    postControl: async (req: Request, res: Response): Promise<void> => {
      const operationId = String(req.params.operationId ?? '');
      if (!operationId) {
        res.status(400).json({ error: 'operationId is required' });
        return;
      }
      const body = typeof req.body === 'object' && req.body !== null ? req.body as Record<string, unknown> : {};
      const { command, error } = parseEzerControlCommand({ ...body, operationId });
      if (!command) {
        res.status(400).json({ code: 'INVALID_COMMAND', error });
        return;
      }
      if (!await authorizeRequest(req, res, operationId)) return;
      const service = resolveService(res);
      if (!service) return;
      try {
        const ack = await service.submit(command);
        if (!ack.accepted) {
          res.status(REJECTION_STATUS[ack.rejection!.code] ?? 400).json(ack);
          return;
        }
        // 202: the command was accepted, not completed.
        res.status(202).json(ack);
      } catch (submitError) {
        console.error(`[EzerControl] Failed to submit ${command.type} for ${operationId}:`, submitError);
        res.status(500).json({ code: 'CONTROL_SUBMIT_FAILED', error: (submitError as Error).message });
      }
    },

    /** Read a command's acknowledgement and, once known, its confirmation. */
    getControlCommand: async (req: Request, res: Response): Promise<void> => {
      const operationId = String(req.params.operationId ?? '');
      const commandId = String(req.params.commandId ?? '');
      if (!operationId || !commandId) {
        res.status(400).json({ error: 'operationId and commandId are required' });
        return;
      }
      if (!await authorizeRequest(req, res, operationId)) return;
      const service = resolveService(res);
      if (!service) return;
      const ack = service.getAck(commandId);
      if (!ack || ack.envelope.operationId !== operationId) {
        res.status(404).json({ error: 'Command not found for this operation' });
        return;
      }
      res.json({ ack, confirmation: service.getConfirmation(commandId) });
    },

    /** Ordered steering revisions for an execution, including superseded ones. */
    getSteerRevisions: async (req: Request, res: Response): Promise<void> => {
      const operationId = String(req.params.operationId ?? '');
      const executionId = typeof req.query.executionId === 'string' ? req.query.executionId : '';
      if (!operationId || !executionId) {
        res.status(400).json({ error: 'operationId and executionId are required' });
        return;
      }
      if (!await authorizeRequest(req, res, operationId)) return;
      const service = resolveService(res);
      if (!service) return;
      res.json({ executionId, revisions: service.listSteerRevisions(executionId) });
    },
  };
}

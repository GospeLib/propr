/**
 * EP-ezer-follow-ups-S03 — Steering, pause and cancellation control
 * propagation (REQ-EF17), ProPR lane.
 *
 * These routes are the observable control surface described in `contract.md`.
 * They bind `pause` / `resume` / `steer` / `cancel` to the exact active attempt
 * and propagate a real stop into the underlying ProPR job/container by reusing
 * the existing stop path (`stopTaskExecution`, which writes the
 * `worker:abort:<taskId>` marker, stops the Docker container and removes queued
 * jobs). Actual cessation is then confirmed by observing the attempt's labelled
 * container — never inferred from the acknowledgement.
 *
 * Live wiring: `server.ts` builds these handlers and registers them with the
 * authenticated `/api/*` route table, passing its own `stopTaskExecution` as
 * the propagator and the running `SocketService`'s `EzerStreamingService`
 * (EP-ezer-follow-ups-S02) as the projection that must refuse late publication
 * from a fenced attempt.
 */

import type { Response } from 'express';
import {
  EzerAttemptControlRegistry,
  EZER_CONTROL_ACK_TARGET_MS,
  EZER_CESSATION_CONFIRM_TARGET_MS,
  parseEzerControlCommand,
  type EzerAttemptSnapshot,
  type EzerCessationReport,
  type EzerControlAck,
  type EzerControlCommand,
  type EzerControlRegistryOptions,
  type EzerControlRejectionCode,
  type EzerPauseSupport,
  type EzerStopPropagationResult,
} from '@propr/core';
import type { FlatRequest } from '../requestTypes.js';

/** Minimal view of the S02 stream projection this control surface drives. */
export interface EzerStreamProjection {
  registerOperation(input: {
    operationId: string;
    requestId?: string;
    sessionId?: string;
    ownerUserId?: string;
  }): void;
  fenceAttempt(operationId: string, executionId: string, attemptId: string): void;
}

/** The real ProPR stop path, injected so this module owns no second mechanism. */
export type EzerTaskStopper = (
  taskId: string,
  context: { requestedBy: string; reason: string; cancellationReason: string; ensureCancelled: boolean },
) => Promise<EzerStopPropagationResult>;

export interface EzerControlRoutesDeps {
  /** Resolved lazily: the socket service is created after routes are built. */
  getStreamProjection: () => EzerStreamProjection | null;
  stopTask: EzerTaskStopper;
  /**
   * Overrides for the registry's clock, container observation and design
   * targets. The stream-fencing wiring below is always installed on top.
   */
  registryOptions?: EzerControlRegistryOptions;
}

type ConfirmationStatus = 'pending' | 'settled';

interface ConfirmationRecord {
  operationId: string;
  commandId: string;
  status: ConfirmationStatus;
  report: EzerCessationReport | null;
}

/** HTTP status per rejection: the refusal must be explicit, not a generic 400. */
const REJECTION_STATUS: Record<EzerControlRejectionCode, number> = {
  INVALID_COMMAND: 400,
  STEER_PAYLOAD_REQUIRED: 400,
  UNKNOWN_ATTEMPT: 404,
  SUPERSEDED_ATTEMPT: 409,
  ATTEMPT_FENCED: 409,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  PAUSE_UNSUPPORTED: 409,
  PAUSE_NOT_ACTIVE: 409,
  RESUME_NOT_PAUSED: 409,
  RESUME_ALREADY_CLAIMED: 409,
};

const PAUSE_SUPPORTS: ReadonlySet<string> = new Set<EzerPauseSupport>(['checkpoint-stop', 'unsupported']);

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function body(req: FlatRequest): Record<string, unknown> {
  const raw: unknown = req.body;
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
}

function principalId(req: FlatRequest): string | null {
  return req.user?.id ?? null;
}

function canManageAnyOperation(req: FlatRequest): boolean {
  return req.authorization?.permissions.includes('instance.manage_settings') === true;
}

/**
 * Owner fencing for the control surface: only the principal that registered the
 * attempt (or an instance manager) may steer or stop it.
 */
function isAuthorizedForAttempt(req: FlatRequest, attempt: EzerAttemptSnapshot): boolean {
  if (!attempt.ownerUserId) return true;
  return attempt.ownerUserId === principalId(req) || canManageAnyOperation(req);
}

export function createEzerControlRoutes(deps: EzerControlRoutesDeps) {
  const registry = new EzerAttemptControlRegistry({
    ...deps.registryOptions,
    // Cancel/pause fence the attempt here AND in the S02 projection, so the
    // stream refuses late publication from the stopped attempt as well.
    onAttemptFenced: fenced => {
      try {
        deps.getStreamProjection()?.fenceAttempt(fenced.operationId, fenced.executionId, fenced.attemptId);
      } catch (error) {
        console.error('[ezer-control] Failed to fence attempt in the stream projection:', error);
      }
    },
  });
  const confirmations = new Map<string, ConfirmationRecord>();

  function confirmationFor(ack: EzerControlAck): ConfirmationRecord | null {
    return confirmations.get(ack.idempotencyKey) ?? null;
  }

  /**
   * Propagate the stop and confirm real cessation in the background, so the
   * `control-ack` stays within its 2s target even when Docker is slow. The
   * settled report is readable from the control-state endpoint.
   */
  function startCessation(command: EzerControlCommand, ack: EzerControlAck): void {
    const record: ConfirmationRecord = {
      operationId: ack.operationId,
      commandId: ack.commandId,
      status: 'pending',
      report: null,
    };
    confirmations.set(ack.idempotencyKey, record);
    void registry.confirmCessation(command, async input => deps.stopTask(input.taskId, {
      requestedBy: input.requestedBy,
      reason: input.reason,
      cancellationReason: input.commandType === 'pause' ? 'ezer_pause_checkpoint' : 'ezer_cancel',
      // A cancel must durably record the cancellation even when the container
      // could not be stopped directly; a checkpoint-pause must not, because the
      // attempt is suspended rather than cancelled.
      ensureCancelled: input.commandType === 'cancel',
    })).then(report => {
      record.status = 'settled';
      record.report = report;
      if (report && !report.confirmed) {
        console.warn(
          `[ezer-control] ${report.commandType} ${report.commandId} did not confirm cessation`
          + ` (${report.state}): ${report.reason ?? report.summary}`,
        );
      }
    }).catch((error: unknown) => {
      record.status = 'settled';
      console.error(`[ezer-control] Cessation confirmation failed for ${ack.commandId}:`, error);
    });
  }

  /**
   * Bind an operation attempt to the ProPR task that runs it. Registering a new
   * attemptId for the same executionId supersedes and fences the previous one.
   */
  async function registerAttempt(req: FlatRequest, res: Response): Promise<void> {
    const payload = body(req);
    const operationId = req.params.operationId;
    const executionId = readString(payload, 'executionId');
    const attemptId = readString(payload, 'attemptId');
    const taskId = readString(payload, 'taskId');
    if (!operationId || !executionId || !attemptId || !taskId) {
      res.status(400).json({
        error: 'operationId, executionId, attemptId and taskId are required',
        code: 'INVALID_ATTEMPT_REGISTRATION',
      });
      return;
    }
    const existing = registry.getAttempt(executionId, attemptId);
    if (existing && !isAuthorizedForAttempt(req, existing)) {
      res.status(403).json({ error: 'This attempt belongs to another principal', code: 'FORBIDDEN' });
      return;
    }
    const pauseSupport = readString(payload, 'pauseSupport');
    const sessionId = readString(payload, 'sessionId');
    const requestId = readString(payload, 'requestId');
    const attemptGeneration = readString(payload, 'attemptGeneration');
    const ownerUserId = principalId(req);
    const snapshot = registry.registerAttempt({
      operationId,
      executionId,
      attemptId,
      taskId,
      ...(attemptGeneration ? { attemptGeneration } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(pauseSupport && PAUSE_SUPPORTS.has(pauseSupport) ? { pauseSupport: pauseSupport as EzerPauseSupport } : {}),
    });
    // Heartbeats must start at acknowledgement, so the S02 projection learns
    // about the operation as soon as its attempt is bound.
    try {
      deps.getStreamProjection()?.registerOperation({
        operationId,
        ...(requestId ? { requestId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(ownerUserId ? { ownerUserId } : {}),
      });
    } catch (error) {
      console.error('[ezer-control] Failed to register the operation with the stream projection:', error);
    }
    res.status(201).json({ attempt: snapshot, ackTargetMs: EZER_CONTROL_ACK_TARGET_MS });
  }

  /**
   * Accept a control command. The response carries the `control-ack` only; it
   * never reports completion. For pause/cancel the real propagation and its
   * confirmation continue in the background and are readable from
   * {@link getControlState}.
   */
  async function postControl(req: FlatRequest, res: Response): Promise<void> {
    const receivedAt = Date.now();
    const payload = { ...body(req), operationId: req.params.operationId };
    const command = parseEzerControlCommand(payload);
    if (!command) {
      res.status(400).json({
        error: 'Malformed control command',
        code: 'INVALID_COMMAND',
        message: 'commandId, sessionId, operationId, executionId, attemptId and a supported type are required.',
        retryPath: 'Re-issue a well-formed command; nothing was applied.',
      });
      return;
    }
    if (!command.requestedBy && req.user?.username) command.requestedBy = req.user.username;

    const attempt = registry.getAttempt(command.executionId, command.attemptId);
    if (attempt && !isAuthorizedForAttempt(req, attempt)) {
      res.status(403).json({ error: 'This attempt belongs to another principal', code: 'FORBIDDEN' });
      return;
    }

    const ack = registry.submit(command, receivedAt);
    if (ack.state === 'rejected') {
      const rejection = ack.rejection!;
      res.status(REJECTION_STATUS[rejection.code]).json({
        ack,
        error: {
          code: rejection.code,
          message: rejection.message,
          diagnosticId: `ezer-control-${ack.operationId}-${ack.commandId}`,
          knownCause: rejection.code,
          persistedState: 'No control effect was recorded for this command.',
          remainingActivity: attempt
            ? `Attempt ${attempt.attemptId} remains ${attempt.phase}.`
            : 'unknown',
          retryPath: rejection.recovery,
        },
      });
      return;
    }

    if (ack.state === 'accepted' && (command.type === 'cancel' || command.type === 'pause')) {
      startCessation(command, ack);
    }
    const confirmation = confirmationFor(ack);
    res.status(ack.state === 'accepted' ? 202 : 200).json({
      ack,
      confirmation: confirmation
        ? { status: confirmation.status, report: confirmation.report }
        : { status: 'not-applicable', report: null },
      ackTargetMs: EZER_CONTROL_ACK_TARGET_MS,
      cessationTargetMs: EZER_CESSATION_CONFIRM_TARGET_MS,
    });
  }

  /**
   * Current control state for an operation: every attempt with its ordered
   * steer revisions (accepted vs applied), checkpoint, one-only resume grant,
   * and the settled cessation report when one exists.
   */
  async function getControlState(req: FlatRequest, res: Response): Promise<void> {
    const operationId = req.params.operationId;
    if (!operationId) {
      res.status(400).json({ error: 'operationId is required', code: 'INVALID_OPERATION' });
      return;
    }
    const attempts = registry.listAttempts(operationId);
    const visible = attempts.filter(attempt => isAuthorizedForAttempt(req, attempt));
    if (attempts.length > 0 && visible.length === 0) {
      res.status(403).json({ error: 'This operation belongs to another principal', code: 'FORBIDDEN' });
      return;
    }
    res.json({
      operationId,
      attempts: visible,
      commands: [...confirmations.values()]
        .filter(record => record.operationId === operationId)
        .map(record => ({ commandId: record.commandId, status: record.status, report: record.report })),
      ackTargetMs: EZER_CONTROL_ACK_TARGET_MS,
      cessationTargetMs: EZER_CESSATION_CONFIRM_TARGET_MS,
    });
  }

  /**
   * The execution pulls its pending steer revisions here. Returning them is the
   * `accepted` → `applied` transition: from this point the redirected input
   * changes subsequent activity, while every prior revision stays on record.
   */
  async function consumeSteer(req: FlatRequest, res: Response): Promise<void> {
    const payload = body(req);
    const executionId = readString(payload, 'executionId');
    const attemptId = readString(payload, 'attemptId');
    if (!executionId || !attemptId) {
      res.status(400).json({ error: 'executionId and attemptId are required', code: 'INVALID_COMMAND' });
      return;
    }
    const attempt = registry.getAttempt(executionId, attemptId);
    if (!attempt || attempt.operationId !== req.params.operationId) {
      res.status(404).json({ error: 'No attempt is registered under this operation', code: 'UNKNOWN_ATTEMPT' });
      return;
    }
    if (!isAuthorizedForAttempt(req, attempt)) {
      res.status(403).json({ error: 'This attempt belongs to another principal', code: 'FORBIDDEN' });
      return;
    }
    const applied = registry.consumeSteerRevisions(executionId, attemptId);
    res.json({
      applied,
      attempt: registry.getAttempt(executionId, attemptId),
    });
  }

  return { registry, registerAttempt, postControl, getControlState, consumeSteer };
}

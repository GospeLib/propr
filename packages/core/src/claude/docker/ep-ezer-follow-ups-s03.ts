/**
 * EP-ezer-follow-ups-S03 — Steering, pause and cancellation control
 * propagation (REQ-EF17).
 *
 * ProPR lane of the approved story. This module owns the `pause` / `resume` /
 * `steer` / `cancel` semantics from `contract.md` and propagates them to the
 * real underlying ProPR job/container through the mechanisms that already
 * exist in this package:
 *
 * - attempt ownership/fencing follows the same task + attempt-generation
 *   identity used by `dockerExecutionOwnership.ts` (`propr.task.id` /
 *   `propr.task.attempt-generation` labels) so a command can only ever reach
 *   the exact attempt it named;
 * - actual cessation is *observed* with {@link findTaskContainer}, the same
 *   label-exact lookup the executor uses, so a stop is only reported when the
 *   container is really gone — never inferred from an acknowledgement;
 * - the abort marker / container stop itself is performed by the caller's
 *   {@link EzerStopPropagator} (the API passes its existing `stopTaskExecution`
 *   path, which writes `worker:abort:<taskId>` and calls `stopDockerContainer`).
 *
 * The central rule of the contract is preserved throughout: a `control-ack`
 * only says the command was received and is distinct from the later
 * confirmation that work actually ceased. `steer` is versioned with distinct
 * `accepted` (received) and `applied` (took effect) states.
 */

import { createHash } from 'node:crypto';
import logger from '../../utils/logger.js';
import { findTaskContainer, type RunningTaskContainer } from './dockerExecutor.js';

/** contract.md design target: a control command is acknowledged within 2s. */
export const EZER_CONTROL_ACK_TARGET_MS = 2_000;

/** contract.md design target: supported cessation is confirmed within 10s. */
export const EZER_CESSATION_CONFIRM_TARGET_MS = 10_000;

/** How often the real container observation is repeated while confirming. */
export const EZER_CESSATION_POLL_INTERVAL_MS = 500;

export type EzerControlType = 'pause' | 'resume' | 'steer' | 'cancel';

const CONTROL_TYPES: ReadonlySet<string> = new Set<EzerControlType>(['pause', 'resume', 'steer', 'cancel']);

/**
 * `accepted` — the command was received and bound to the named attempt.
 * `deduplicated` — an identical commandId+payload was already accepted; the
 * original acknowledgement is replayed and no second effect is produced.
 * `rejected` — the command cannot be bound (see {@link EzerControlRejectionCode}).
 */
export type EzerControlAckState = 'accepted' | 'deduplicated' | 'rejected';

export type EzerControlRejectionCode =
    | 'INVALID_COMMAND'
    | 'UNKNOWN_ATTEMPT'
    | 'SUPERSEDED_ATTEMPT'
    | 'ATTEMPT_FENCED'
    | 'IDEMPOTENCY_KEY_CONFLICT'
    | 'PAUSE_UNSUPPORTED'
    | 'PAUSE_NOT_ACTIVE'
    | 'RESUME_NOT_PAUSED'
    | 'RESUME_ALREADY_CLAIMED'
    | 'STEER_PAYLOAD_REQUIRED';

/**
 * Whether the underlying execution can be suspended at all.
 *
 * ProPR runs agents as a `docker run` child: there is no safe mid-flight
 * suspend, so the only truthful pause is `checkpoint-stop` (write a checkpoint,
 * then really stop the attempt). An attempt that cannot even do that declares
 * `unsupported`, and pause is refused with a reason instead of falsely
 * reporting the work as paused.
 */
export type EzerPauseSupport = 'checkpoint-stop' | 'unsupported';

export type EzerAttemptPhase =
    | 'active'
    | 'pausing'
    | 'paused'
    | 'resuming'
    | 'cancelling'
    | 'stopped'
    | 'superseded';

export interface EzerControlCommand {
    commandId: string;
    sessionId: string;
    operationId: string;
    executionId: string;
    attemptId: string;
    type: EzerControlType;
    /** Steering payload; ignored for pause/resume/cancel. */
    payload?: unknown;
    requestId?: string;
    /** Who issued the command; recorded on the propagated stop. */
    requestedBy?: string;
    /** Optional client-computed fingerprint; recomputed and compared server-side. */
    payloadFingerprint?: string;
}

export interface EzerSteerRevision {
    /** 1-based, strictly increasing per attempt — the ordered revision number. */
    version: number;
    commandId: string;
    payload: unknown;
    payloadFingerprint: string;
    /** `accepted` = received; `applied` = actually took effect downstream. */
    state: 'accepted' | 'applied';
    acceptedAt: string;
    appliedAt: string | null;
}

export interface EzerControlRejection {
    code: EzerControlRejectionCode;
    message: string;
    /** Safe next step; never an instruction that would redirect another attempt. */
    recovery: string;
}

/**
 * The immediate acknowledgement. It reports *receipt*, never completion:
 * `cessation` stays `pending` until {@link EzerAttemptControlRegistry.confirmCessation}
 * has actually observed the underlying job/container.
 */
export interface EzerControlAck {
    type: 'control-ack';
    state: EzerControlAckState;
    commandId: string;
    commandType: EzerControlType;
    idempotencyKey: string;
    payloadFingerprint: string;
    requestId: string;
    sessionId: string;
    operationId: string;
    executionId: string;
    attemptId: string;
    ts: string;
    summary: string;
    /** `not-applicable` for steer/resume; `pending` until really confirmed. */
    cessation: 'not-applicable' | 'pending' | 'confirmed';
    /** Attempt phase *after* the command was bound. */
    phase: EzerAttemptPhase;
    ackLatencyMs: number;
    ackTargetMs: number;
    withinAckTarget: boolean;
    steerVersion?: number;
    steerState?: 'accepted' | 'applied';
    resume?: EzerResumeGrant;
    rejection?: EzerControlRejection;
}

export interface EzerCheckpoint {
    /** Command that produced the checkpoint. */
    commandId: string;
    createdAt: string;
    taskId: string;
    attemptGeneration: string | null;
    /** Steer revisions accepted before the checkpoint — prior evidence is kept. */
    steerVersions: number[];
    /** How the attempt was suspended, so resume reconciles the exact state. */
    kind: 'checkpoint-stop';
}

export interface EzerResumeGrant {
    continuationId: string;
    claimedByCommandId: string;
    checkpoint: EzerCheckpoint;
    grantedAt: string;
}

/**
 * `stopped`/`checkpointed`/`not-running` are confirmed outcomes;
 * `still-running` and `unverified` explicitly are not. A pause that the
 * execution cannot support is refused at acknowledgement time and never
 * produces a cessation report at all.
 */
export type EzerCessationState =
    | 'stopped'
    | 'checkpointed'
    | 'not-running'
    | 'still-running'
    | 'unverified';

export interface EzerCessationEvidence {
    abortSignalled: boolean;
    containerStopped: boolean;
    removedQueuedJobs: number;
    /** Container still carrying the attempt's labels, or null when really gone. */
    observedContainer: string | null;
    /** False when Docker could not be queried — the result is then unverified. */
    observationAvailable: boolean;
    observations: number;
    propagationMessage: string;
    /** True when the stop path itself threw; no cessation may be claimed. */
    propagationFailed: boolean;
}

/**
 * The later confirmation of real downstream state. `confirmed` is true only for
 * an observed cessation; a failed or unavailable observation reports
 * `still-running` / `unverified` with a reason and recovery instead.
 */
export interface EzerCessationReport {
    type: 'result';
    state: EzerCessationState;
    confirmed: boolean;
    commandId: string;
    commandType: EzerControlType;
    requestId: string;
    sessionId: string;
    operationId: string;
    executionId: string;
    attemptId: string;
    taskId: string;
    ts: string;
    elapsedMs: number;
    targetMs: number;
    withinTarget: boolean;
    phase: EzerAttemptPhase;
    summary: string;
    evidence: EzerCessationEvidence;
    checkpoint?: EzerCheckpoint;
    reason?: string;
    recovery?: string;
}

export interface EzerStopPropagationResult {
    abortSignalled?: boolean;
    containerStopped?: boolean;
    removedQueuedJobs?: number;
    notFound?: boolean;
    notRunning?: boolean;
    message?: string;
}

/**
 * Real propagation into the ProPR job/container. The API supplies its existing
 * stop path (`worker:abort:<taskId>` marker + `stopDockerContainer` + queued-job
 * removal); this module never invents a second stop mechanism.
 */
export type EzerStopPropagator = (input: {
    taskId: string;
    operationId: string;
    executionId: string;
    attemptId: string;
    commandType: 'pause' | 'cancel';
    reason: string;
    requestedBy: string;
}) => Promise<EzerStopPropagationResult>;

/** Label-exact observation of the attempt's container, in any lifecycle state. */
export type EzerAttemptObserver = (
    taskId: string,
    attemptGeneration?: string,
) => Promise<RunningTaskContainer | null>;

export interface EzerAttemptRegistration {
    operationId: string;
    executionId: string;
    attemptId: string;
    /** ProPR task/job that actually runs this attempt. */
    taskId: string;
    /** Docker `propr.task.attempt-generation` label of the owned container. */
    attemptGeneration?: string;
    requestId?: string;
    sessionId?: string;
    ownerUserId?: string;
    pauseSupport?: EzerPauseSupport;
}

export interface EzerAttemptSnapshot {
    operationId: string;
    executionId: string;
    attemptId: string;
    taskId: string;
    attemptGeneration: string | null;
    requestId: string | null;
    sessionId: string | null;
    ownerUserId: string | null;
    pauseSupport: EzerPauseSupport;
    phase: EzerAttemptPhase;
    fenced: boolean;
    registeredAt: string;
    steer: EzerSteerRevision[];
    checkpoint: EzerCheckpoint | null;
    resumeGrant: EzerResumeGrant | null;
    cessation: EzerCessationReport | null;
}

export interface EzerPublicationDecision {
    accepted: boolean;
    reason?: 'fenced-attempt' | 'superseded-attempt' | 'unknown-attempt';
}

export interface EzerControlRegistryOptions {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    observeAttempt?: EzerAttemptObserver;
    ackTargetMs?: number;
    cessationTargetMs?: number;
    pollIntervalMs?: number;
    /** Default pause capability for attempts that do not declare one. */
    defaultPauseSupport?: EzerPauseSupport;
    /** Notified when an attempt is fenced, so the stream projection can refuse it. */
    onAttemptFenced?: (fenced: { operationId: string; executionId: string; attemptId: string }) => void;
}

interface CommandRecord {
    idempotencyKey: string;
    payloadFingerprint: string;
    commandType: EzerControlType;
    ack: EzerControlAck;
}

/** Everything a command needs while it is bound to an attempt. */
interface BindContext {
    command: EzerControlCommand;
    fingerprint: string;
    idempotencyKey: string;
    receivedAt: number;
}

interface AttemptRecord {
    operationId: string;
    executionId: string;
    attemptId: string;
    taskId: string;
    attemptGeneration: string | null;
    requestId: string | null;
    sessionId: string | null;
    ownerUserId: string | null;
    pauseSupport: EzerPauseSupport;
    phase: EzerAttemptPhase;
    fenced: boolean;
    registeredAt: number;
    steer: EzerSteerRevision[];
    checkpoint: EzerCheckpoint | null;
    resumeGrant: EzerResumeGrant | null;
    cessation: EzerCessationReport | null;
    /** Single in-flight propagation, so racing cancels produce one real stop. */
    cessationInFlight: Promise<EzerCessationReport> | null;
}

const UNASSIGNED = 'unassigned';

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
        return result;
    }
    return value;
}

/**
 * Stable fingerprint of a command payload. Key order and formatting cannot
 * change it, so a genuine retry dedups while a changed payload is detected.
 */
export function computeEzerPayloadFingerprint(payload: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify({ v: canonicalize(payload) }))
        .digest('hex');
}

/** Idempotency key from contract.md: sessionId + operationId + commandId. */
export function buildEzerIdempotencyKey(command: {
    sessionId: string;
    operationId: string;
    commandId: string;
}): string {
    return `${command.sessionId} ${command.operationId} ${command.commandId}`;
}

export function attemptIdentity(executionId: string, attemptId: string): string {
    return `${executionId} ${attemptId}`;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate an untrusted control command. A malformed command never reaches the
 * attempt state machine, so it cannot fence, stop or steer anything.
 */
export function parseEzerControlCommand(raw: unknown): EzerControlCommand | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const source = raw as Record<string, unknown>;
    if (typeof source.type !== 'string' || !CONTROL_TYPES.has(source.type)) return null;
    for (const field of ['commandId', 'sessionId', 'operationId', 'executionId', 'attemptId'] as const) {
        if (!isNonEmptyString(source[field])) return null;
    }
    const command: EzerControlCommand = {
        commandId: (source.commandId as string).trim(),
        sessionId: (source.sessionId as string).trim(),
        operationId: (source.operationId as string).trim(),
        executionId: (source.executionId as string).trim(),
        attemptId: (source.attemptId as string).trim(),
        type: source.type as EzerControlType,
    };
    if (source.payload !== undefined) command.payload = source.payload;
    if (isNonEmptyString(source.requestId)) command.requestId = source.requestId.trim();
    if (isNonEmptyString(source.requestedBy)) command.requestedBy = source.requestedBy.trim();
    if (isNonEmptyString(source.payloadFingerprint)) command.payloadFingerprint = source.payloadFingerprint.trim();
    return command;
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise(resolve => { setTimeout(resolve, ms); });
}

/**
 * Ordered, attempt-exact control state for Ezer operations.
 *
 * One registry instance holds the active attempt per execution. Registering a
 * newer attempt for the same execution supersedes *and fences* the previous one
 * so a stale attempt can never publish into its replacement, and so a control
 * command naming the stale attempt is refused rather than silently redirected.
 */
export class EzerAttemptControlRegistry {
    private readonly attempts = new Map<string, AttemptRecord>();
    /** Active attempt identity per execution, for supersede detection. */
    private readonly activeAttemptByExecution = new Map<string, string>();
    private readonly commands = new Map<string, CommandRecord>();
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly observeAttempt: EzerAttemptObserver;
    private readonly ackTargetMs: number;
    private readonly cessationTargetMs: number;
    private readonly pollIntervalMs: number;
    private readonly defaultPauseSupport: EzerPauseSupport;
    private readonly onAttemptFenced: EzerControlRegistryOptions['onAttemptFenced'] | null;
    private continuationSeq = 0;

    constructor(options: EzerControlRegistryOptions = {}) {
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? defaultSleep;
        this.observeAttempt = options.observeAttempt
            ?? ((taskId, attemptGeneration) => findTaskContainer(taskId, attemptGeneration));
        this.ackTargetMs = options.ackTargetMs ?? EZER_CONTROL_ACK_TARGET_MS;
        this.cessationTargetMs = options.cessationTargetMs ?? EZER_CESSATION_CONFIRM_TARGET_MS;
        this.pollIntervalMs = options.pollIntervalMs ?? EZER_CESSATION_POLL_INTERVAL_MS;
        this.defaultPauseSupport = options.defaultPauseSupport ?? 'checkpoint-stop';
        this.onAttemptFenced = options.onAttemptFenced ?? null;
    }

    /**
     * Bind an operation attempt to the ProPR task that really runs it. A second
     * attempt on the same execution supersedes and fences the first.
     */
    registerAttempt(registration: EzerAttemptRegistration): EzerAttemptSnapshot {
        const identity = attemptIdentity(registration.executionId, registration.attemptId);
        const existing = this.attempts.get(identity);
        if (existing) {
            // Re-registration of the same attempt refreshes its binding only.
            if (registration.attemptGeneration) existing.attemptGeneration = registration.attemptGeneration;
            if (registration.requestId) existing.requestId = registration.requestId;
            if (registration.sessionId) existing.sessionId = registration.sessionId;
            if (registration.ownerUserId) existing.ownerUserId = registration.ownerUserId;
            if (registration.pauseSupport) existing.pauseSupport = registration.pauseSupport;
            return this.snapshotOf(existing);
        }
        const previousIdentity = this.activeAttemptByExecution.get(registration.executionId);
        if (previousIdentity && previousIdentity !== identity) {
            const previous = this.attempts.get(previousIdentity);
            if (previous) {
                previous.phase = 'superseded';
                this.fence(previous, 'replacement attempt registered');
            }
        }
        const record: AttemptRecord = {
            operationId: registration.operationId,
            executionId: registration.executionId,
            attemptId: registration.attemptId,
            taskId: registration.taskId,
            attemptGeneration: registration.attemptGeneration ?? null,
            requestId: registration.requestId ?? null,
            sessionId: registration.sessionId ?? null,
            ownerUserId: registration.ownerUserId ?? null,
            pauseSupport: registration.pauseSupport ?? this.defaultPauseSupport,
            phase: 'active',
            fenced: false,
            registeredAt: this.now(),
            steer: [],
            checkpoint: null,
            resumeGrant: null,
            cessation: null,
            cessationInFlight: null,
        };
        this.attempts.set(identity, record);
        this.activeAttemptByExecution.set(registration.executionId, identity);
        return this.snapshotOf(record);
    }

    getAttempt(executionId: string, attemptId: string): EzerAttemptSnapshot | null {
        const record = this.attempts.get(attemptIdentity(executionId, attemptId));
        return record ? this.snapshotOf(record) : null;
    }

    /** Every attempt known for an operation, oldest registration first. */
    listAttempts(operationId: string): EzerAttemptSnapshot[] {
        return [...this.attempts.values()]
            .filter(record => record.operationId === operationId)
            .sort((a, b) => a.registeredAt - b.registeredAt)
            .map(record => this.snapshotOf(record));
    }

    getAck(command: { sessionId: string; operationId: string; commandId: string }): EzerControlAck | null {
        return this.commands.get(buildEzerIdempotencyKey(command))?.ack ?? null;
    }

    /**
     * Whether an attempt may still publish. A fenced (cancelled, paused-stopped
     * or superseded) attempt is refused even before a replacement exists.
     */
    acceptPublication(executionId: string, attemptId: string): EzerPublicationDecision {
        const record = this.attempts.get(attemptIdentity(executionId, attemptId));
        if (!record) return { accepted: false, reason: 'unknown-attempt' };
        if (record.fenced) return { accepted: false, reason: 'fenced-attempt' };
        if (record.phase === 'superseded') return { accepted: false, reason: 'superseded-attempt' };
        return { accepted: true };
    }

    /**
     * Bind a command to its exact attempt and return the immediate
     * `control-ack`. This performs no I/O, so the 2s acknowledgement target
     * does not depend on Docker or Redis being responsive.
     */
    submit(command: EzerControlCommand, receivedAt: number = this.now()): EzerControlAck {
        const context: BindContext = {
            command,
            // Only steering carries a payload, so pause/resume/cancel retries
            // always fingerprint identically and dedup cleanly.
            fingerprint: computeEzerPayloadFingerprint(command.type === 'steer' ? command.payload : null),
            idempotencyKey: buildEzerIdempotencyKey(command),
            receivedAt,
        };
        const previous = this.commands.get(context.idempotencyKey);
        if (previous) {
            if (previous.payloadFingerprint !== context.fingerprint || previous.commandType !== command.type) {
                // Same key, different payload: reject. Notably this never
                // redirects the effect onto a replacement attempt.
                return this.rejection(context, {
                    code: 'IDEMPOTENCY_KEY_CONFLICT',
                    message: 'This commandId was already accepted with a different command type or payload.',
                    recovery: 'Issue the change under a new commandId; the original command is unaffected.',
                });
            }
            // Exact duplicate: replay the original acknowledgement, no second effect.
            const ackLatencyMs = this.now() - receivedAt;
            return {
                ...previous.ack,
                state: 'deduplicated',
                ts: this.iso(receivedAt),
                ackLatencyMs,
                withinAckTarget: ackLatencyMs <= this.ackTargetMs,
                summary: `Duplicate ${command.type} command ${command.commandId} deduplicated; the original acknowledgement stands.`,
            };
        }

        const record = this.attempts.get(attemptIdentity(command.executionId, command.attemptId));
        if (!record) {
            return this.rejection(context, {
                code: 'UNKNOWN_ATTEMPT',
                message: 'No attempt is registered under this executionId and attemptId.',
                recovery: 'Register the active attempt first, then re-issue the command against it.',
            });
        }
        if (record.operationId !== command.operationId) {
            return this.rejection(context, {
                code: 'UNKNOWN_ATTEMPT',
                message: 'The named attempt belongs to a different operation.',
                recovery: 'Re-issue the command with the operationId that owns the attempt.',
            });
        }
        if (record.phase === 'superseded') {
            return this.rejection(context, {
                code: 'SUPERSEDED_ATTEMPT',
                message: 'The named attempt has been superseded by a replacement attempt.',
                recovery: 'Re-issue the command against the current attemptId; the replacement was not redirected.',
            }, record);
        }

        const ack = this.bind(record, context);
        if (ack.state === 'accepted') {
            this.commands.set(context.idempotencyKey, {
                idempotencyKey: context.idempotencyKey,
                payloadFingerprint: context.fingerprint,
                commandType: command.type,
                ack,
            });
        }
        return ack;
    }

    private bind(record: AttemptRecord, context: BindContext): EzerControlAck {
        switch (context.command.type) {
            case 'cancel': return this.bindCancel(record, context);
            case 'pause': return this.bindPause(record, context);
            case 'resume': return this.bindResume(record, context);
            case 'steer': return this.bindSteer(record, context);
        }
    }

    private bindCancel(record: AttemptRecord, context: BindContext): EzerControlAck {
        // A cancel racing another cancel is accepted: both name the same
        // attempt, and confirmCessation() collapses them onto one real stop.
        if (record.phase !== 'stopped') record.phase = 'cancelling';
        this.fence(record, `cancel command ${context.command.commandId}`);
        return this.ack(record, context, {
            cessation: record.cessation?.confirmed ? 'confirmed' : 'pending',
            summary: 'Cancel accepted and the attempt is fenced; actual cessation is confirmed separately.',
        });
    }

    private bindPause(record: AttemptRecord, context: BindContext): EzerControlAck {
        if (record.pauseSupport === 'unsupported') {
            // Report the refusal truthfully rather than claiming "paused".
            return this.rejection(context, {
                code: 'PAUSE_UNSUPPORTED',
                message: 'This execution cannot be safely suspended or checkpointed; it is still running.',
                recovery: 'Cancel the attempt to stop it, or let it run to completion; it was not paused.',
            }, record);
        }
        if (record.phase !== 'active') {
            return this.rejection(context, {
                code: 'PAUSE_NOT_ACTIVE',
                message: `The attempt is ${record.phase}, so it cannot be paused.`,
                recovery: 'Inspect the attempt state; no pause was applied.',
            }, record);
        }
        record.phase = 'pausing';
        record.checkpoint = {
            commandId: context.command.commandId,
            createdAt: this.iso(context.receivedAt),
            taskId: record.taskId,
            attemptGeneration: record.attemptGeneration,
            steerVersions: record.steer.map(revision => revision.version),
            kind: 'checkpoint-stop',
        };
        // Checkpoint-and-stop: the attempt stops for real, so it must not be
        // able to publish afterwards either.
        this.fence(record, `pause command ${context.command.commandId}`);
        return this.ack(record, context, {
            cessation: 'pending',
            summary: 'Pause accepted as checkpoint-and-stop; the checkpoint is saved and cessation is confirmed separately.',
        });
    }

    private bindResume(record: AttemptRecord, context: BindContext): EzerControlAck {
        // The one-only check comes first: once a continuation exists the attempt
        // has already left `paused`, and the accurate refusal is "already
        // claimed" rather than "not paused".
        if (record.resumeGrant) {
            return this.rejection(context, {
                code: 'RESUME_ALREADY_CLAIMED',
                message: `Continuation ${record.resumeGrant.continuationId} was already granted for this checkpoint.`,
                recovery: 'Follow the existing continuation; a second one would duplicate the attempt.',
            }, record);
        }
        if (record.phase !== 'paused' || !record.checkpoint) {
            return this.rejection(context, {
                code: 'RESUME_NOT_PAUSED',
                message: `The attempt is ${record.phase}; only a checkpointed pause can be resumed.`,
                recovery: 'Do not resume an active attempt — that would duplicate it. Pause first, or track the running attempt.',
            }, record);
        }
        this.continuationSeq += 1;
        const grant: EzerResumeGrant = {
            continuationId: `${record.operationId}-cont-${this.continuationSeq}`,
            claimedByCommandId: context.command.commandId,
            checkpoint: record.checkpoint,
            grantedAt: this.iso(context.receivedAt),
        };
        record.resumeGrant = grant;
        record.phase = 'resuming';
        return this.ack(record, context, {
            cessation: 'not-applicable',
            summary: 'Resume accepted; exactly one continuation is granted against the saved checkpoint.',
            resume: grant,
        });
    }

    private bindSteer(record: AttemptRecord, context: BindContext): EzerControlAck {
        const { command } = context;
        if (command.payload === undefined || command.payload === null) {
            return this.rejection(context, {
                code: 'STEER_PAYLOAD_REQUIRED',
                message: 'A steer command must carry the redirected input as its payload.',
                recovery: 'Re-issue the steer with a payload; no revision was recorded.',
            }, record);
        }
        if (record.fenced) {
            return this.rejection(context, {
                code: 'ATTEMPT_FENCED',
                message: 'The attempt is fenced (cancelled, paused or superseded) and cannot be steered.',
                recovery: 'Steer the current attempt instead; this command was not redirected onto it.',
            }, record);
        }
        // Prior revisions are never rewritten — the ordered list is the evidence.
        const revision: EzerSteerRevision = {
            version: record.steer.length + 1,
            commandId: command.commandId,
            payload: command.payload,
            payloadFingerprint: context.fingerprint,
            state: 'accepted',
            acceptedAt: this.iso(context.receivedAt),
            appliedAt: null,
        };
        record.steer.push(revision);
        return this.ack(record, context, {
            cessation: 'not-applicable',
            summary: `Steer revision ${revision.version} accepted; it is applied when the execution consumes it.`,
            steerVersion: revision.version,
            steerState: 'accepted',
        });
    }

    /**
     * Hand the execution every accepted-but-not-yet-applied steer revision, in
     * order, and record the `applied` transition. This is the point at which a
     * steer actually changes subsequent activity; prior revisions and their
     * accepted timestamps are preserved.
     */
    consumeSteerRevisions(executionId: string, attemptId: string): EzerSteerRevision[] {
        const record = this.attempts.get(attemptIdentity(executionId, attemptId));
        if (!record || record.fenced) return [];
        const pending = record.steer.filter(revision => revision.state === 'accepted');
        const appliedAt = this.iso();
        for (const revision of pending) {
            revision.state = 'applied';
            revision.appliedAt = appliedAt;
        }
        return pending.map(revision => ({ ...revision }));
    }

    /**
     * Propagate the stop and then *observe* the real attempt until it is gone or
     * the confirmation target expires. Racing commands on the same attempt share
     * one propagation, so a cancel/cancel or cancel/pause race produces exactly
     * one stop and one truthful report.
     */
    async confirmCessation(
        command: EzerControlCommand,
        propagate: EzerStopPropagator,
    ): Promise<EzerCessationReport | null> {
        const record = this.attempts.get(attemptIdentity(command.executionId, command.attemptId));
        if (!record) return null;
        if (record.phase !== 'cancelling' && record.phase !== 'pausing' && record.phase !== 'stopped' && record.phase !== 'paused') {
            return null;
        }
        if (record.cessationInFlight) {
            // A racing command joins the in-flight stop instead of issuing a
            // second one, and reports the same observed outcome.
            const shared = await record.cessationInFlight;
            return { ...shared, commandId: command.commandId, commandType: command.type };
        }
        if (record.cessation?.confirmed === true) {
            // Already confirmed stopped/checkpointed: re-propagating would claim
            // a second cessation of work that has already ended.
            return { ...record.cessation, commandId: command.commandId, commandType: command.type };
        }
        const run = this.runCessation(record, command, propagate);
        record.cessationInFlight = run;
        try {
            return await run;
        } finally {
            record.cessationInFlight = null;
        }
    }

    private async runCessation(
        record: AttemptRecord,
        command: EzerControlCommand,
        propagate: EzerStopPropagator,
    ): Promise<EzerCessationReport> {
        const startedAt = this.now();
        const isPause = command.type === 'pause';
        const reason = isPause
            ? `Ezer pause (checkpoint-and-stop) for operation ${record.operationId}`
            : `Ezer cancel for operation ${record.operationId}`;
        let propagation: EzerStopPropagationResult;
        let propagationFailed = false;
        try {
            propagation = await propagate({
                taskId: record.taskId,
                operationId: record.operationId,
                executionId: record.executionId,
                attemptId: record.attemptId,
                commandType: isPause ? 'pause' : 'cancel',
                reason,
                requestedBy: command.requestedBy ?? 'ezer',
            });
        } catch (error) {
            const message = (error as Error).message;
            logger.error({ taskId: record.taskId, operationId: record.operationId, error: message },
                'Ezer control propagation failed');
            propagation = { message: `Stop propagation failed: ${message}` };
            propagationFailed = true;
        }

        const evidence: EzerCessationEvidence = {
            abortSignalled: propagation.abortSignalled === true,
            containerStopped: propagation.containerStopped === true,
            removedQueuedJobs: propagation.removedQueuedJobs ?? 0,
            observedContainer: null,
            observationAvailable: false,
            observations: 0,
            propagationMessage: propagation.message ?? 'No propagation message reported.',
            propagationFailed,
        };

        const deadline = startedAt + this.cessationTargetMs;
        let lastObservation: RunningTaskContainer | null = null;
        let observationFailure: string | null = null;
        for (;;) {
            try {
                lastObservation = await this.observeAttempt(record.taskId, record.attemptGeneration ?? undefined);
                evidence.observationAvailable = true;
                observationFailure = null;
            } catch (error) {
                // A failed Docker query proves nothing. It must never be read as
                // a stop, so the report degrades to `unverified` below.
                observationFailure = (error as Error).message;
                evidence.observationAvailable = false;
            }
            evidence.observations += 1;
            evidence.observedContainer = lastObservation ? lastObservation.id : null;
            if (observationFailure === null && lastObservation === null) break;
            const remaining = deadline - this.now();
            if (remaining <= 0) break;
            await this.sleep(Math.min(this.pollIntervalMs, remaining));
        }

        const elapsedMs = this.now() - startedAt;
        const report = this.buildReport(record, command, {
            evidence,
            elapsedMs,
            observationFailure,
            stillRunning: lastObservation !== null,
            propagation,
            isPause,
        });
        record.cessation = report;
        record.phase = report.phase;
        return report;
    }

    private buildReport(
        record: AttemptRecord,
        command: EzerControlCommand,
        input: {
            evidence: EzerCessationEvidence;
            elapsedMs: number;
            observationFailure: string | null;
            stillRunning: boolean;
            propagation: EzerStopPropagationResult;
            isPause: boolean;
        },
    ): EzerCessationReport {
        const { evidence, elapsedMs, observationFailure, stillRunning, propagation, isPause } = input;
        let state: EzerCessationState;
        let phase: EzerAttemptPhase;
        let summary: string;
        let reason: string | undefined;
        let recovery: string | undefined;

        if (observationFailure !== null) {
            state = 'unverified';
            phase = record.phase;
            summary = 'The stop was propagated but the attempt could not be observed, so cessation is unconfirmed.';
            reason = `Container observation failed: ${observationFailure}`;
            recovery = `Re-check the attempt with its propr.task.id=${record.taskId} label; the abort marker remains in place.`;
        } else if (evidence.propagationFailed) {
            // The absence of a container proves nothing when the stop itself
            // never ran: the attempt may still hold a child process or lease.
            state = 'unverified';
            phase = record.phase;
            summary = 'The stop could not be propagated, so no cessation is claimed.';
            reason = evidence.propagationMessage;
            recovery = 'Retry the cancel under a new commandId once the stop path is reachable; late output stays fenced.';
        } else if (stillRunning) {
            state = 'still-running';
            phase = record.phase;
            summary = 'The stop was propagated but the attempt container is still present; it is NOT stopped.';
            reason = `Container ${evidence.observedContainer} still carries the attempt labels after ${elapsedMs}ms.`;
            recovery = 'Re-issue the cancel under a new commandId, or stop the container directly; late output stays fenced.';
        } else if (propagation.notFound === true && !evidence.abortSignalled && !evidence.containerStopped) {
            // Nothing was running to stop. Saying "stopped" here would be a
            // false claim about work this control never actually ended.
            state = 'not-running';
            phase = isPause ? 'paused' : 'stopped';
            summary = 'No running attempt was found to stop; nothing was terminated by this command.';
            reason = propagation.message ?? 'The task was not running.';
        } else if (isPause) {
            state = 'checkpointed';
            phase = 'paused';
            summary = 'The attempt was checkpointed and really stopped; it is suspended, not running.';
        } else {
            state = 'stopped';
            phase = 'stopped';
            summary = 'The attempt is confirmed stopped: no container carries its labels and late publication is fenced.';
        }

        const confirmed = state === 'stopped' || state === 'checkpointed' || state === 'not-running';
        const report: EzerCessationReport = {
            type: 'result',
            state,
            confirmed,
            commandId: command.commandId,
            commandType: command.type,
            requestId: command.requestId ?? record.requestId ?? UNASSIGNED,
            sessionId: command.sessionId,
            operationId: record.operationId,
            executionId: record.executionId,
            attemptId: record.attemptId,
            taskId: record.taskId,
            ts: this.iso(),
            elapsedMs,
            targetMs: this.cessationTargetMs,
            withinTarget: elapsedMs <= this.cessationTargetMs,
            phase,
            summary,
            evidence,
        };
        if (record.checkpoint && isPause) report.checkpoint = record.checkpoint;
        if (reason !== undefined) report.reason = reason;
        if (recovery !== undefined) report.recovery = recovery;
        return report;
    }

    private fence(record: AttemptRecord, cause: string): void {
        if (record.fenced) return;
        record.fenced = true;
        logger.info({
            operationId: record.operationId,
            executionId: record.executionId,
            attemptId: record.attemptId,
            taskId: record.taskId,
            cause,
        }, 'Ezer attempt fenced; late publication is refused');
        this.onAttemptFenced?.({
            operationId: record.operationId,
            executionId: record.executionId,
            attemptId: record.attemptId,
        });
    }

    private ack(
        record: AttemptRecord,
        context: BindContext,
        extra: {
            cessation: EzerControlAck['cessation'];
            summary: string;
            steerVersion?: number;
            steerState?: 'accepted' | 'applied';
            resume?: EzerResumeGrant;
        },
    ): EzerControlAck {
        const { command, receivedAt } = context;
        const ackLatencyMs = this.now() - receivedAt;
        const ack: EzerControlAck = {
            type: 'control-ack',
            state: 'accepted',
            commandId: command.commandId,
            commandType: command.type,
            idempotencyKey: context.idempotencyKey,
            payloadFingerprint: context.fingerprint,
            requestId: command.requestId ?? record.requestId ?? UNASSIGNED,
            sessionId: command.sessionId,
            operationId: record.operationId,
            executionId: record.executionId,
            attemptId: record.attemptId,
            ts: this.iso(receivedAt),
            summary: extra.summary,
            cessation: extra.cessation,
            phase: record.phase,
            ackLatencyMs,
            ackTargetMs: this.ackTargetMs,
            withinAckTarget: ackLatencyMs <= this.ackTargetMs,
        };
        if (extra.steerVersion !== undefined) ack.steerVersion = extra.steerVersion;
        if (extra.steerState !== undefined) ack.steerState = extra.steerState;
        if (extra.resume !== undefined) ack.resume = extra.resume;
        return ack;
    }

    private rejection(
        context: BindContext,
        rejection: EzerControlRejection,
        record?: AttemptRecord,
    ): EzerControlAck {
        const { command, receivedAt } = context;
        const ackLatencyMs = this.now() - receivedAt;
        return {
            type: 'control-ack',
            state: 'rejected',
            commandId: command.commandId,
            commandType: command.type,
            idempotencyKey: context.idempotencyKey,
            payloadFingerprint: context.fingerprint,
            requestId: command.requestId ?? record?.requestId ?? UNASSIGNED,
            sessionId: command.sessionId,
            operationId: command.operationId,
            executionId: command.executionId,
            attemptId: command.attemptId,
            ts: this.iso(receivedAt),
            summary: rejection.message,
            cessation: 'not-applicable',
            phase: record?.phase ?? 'active',
            ackLatencyMs,
            ackTargetMs: this.ackTargetMs,
            withinAckTarget: ackLatencyMs <= this.ackTargetMs,
            rejection,
        };
    }

    private snapshotOf(record: AttemptRecord): EzerAttemptSnapshot {
        return {
            operationId: record.operationId,
            executionId: record.executionId,
            attemptId: record.attemptId,
            taskId: record.taskId,
            attemptGeneration: record.attemptGeneration,
            requestId: record.requestId,
            sessionId: record.sessionId,
            ownerUserId: record.ownerUserId,
            pauseSupport: record.pauseSupport,
            phase: record.phase,
            fenced: record.fenced,
            registeredAt: this.iso(record.registeredAt),
            steer: record.steer.map(revision => ({ ...revision })),
            checkpoint: record.checkpoint,
            resumeGrant: record.resumeGrant,
            cessation: record.cessation,
        };
    }

    private iso(at: number = this.now()): string {
        return new Date(at).toISOString();
    }
}

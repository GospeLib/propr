/* eslint-disable max-lines -- the attempt registry and the evidence shapes that
   prove real cessation belong together; splitting them would let a caller
   report a stop from a result type whose evidence rules live elsewhere. */
/**
 * EP-ezer-follow-ups-S03 — control propagation to the owning ProPR execution
 * (REQ-EF17).
 *
 * The control plane in `packages/api/routes/ep-ezer-follow-ups-s03.ts` decides
 * *whether* a `pause`/`resume`/`steer`/`cancel` command is admissible; this
 * module makes it real. It binds each Ezer attempt to the execution ownership
 * fence that already exists (`dockerExecutionOwnership.ts` labels containers
 * with `propr.task.id` + `propr.task.attempt-generation`, and
 * `dockerAbortController.ts` terminates and tears them down), and then proves
 * what actually happened by observing the abort marker, the owned child
 * process and the owned containers.
 *
 * Two rules drive every result shape here:
 * - an acknowledgement is never cessation: this module only reports `stopped`
 *   when it has positively observed that no owned container remains and the
 *   owned child has exited. Anything else is reported as `still-running` with
 *   a reason and a recovery path, never as a false stop or an orphan claim;
 * - a superseded attempt is fenced the instant its replacement registers, so
 *   it can neither be targeted by new control commands nor publish into its
 *   replacement.
 */

import type { ChildProcess } from 'node:child_process';
import logger from '../../utils/logger.js';
import {
    observeExecutionContainers,
    pauseDockerContainer,
    unpauseDockerContainer,
    type ContainerSuspensionResult,
    type ExecutionContainerObservation,
} from './dockerContainerControl.js';
import {
    abortSpawnedExecution,
    type SpawnedExecutionState,
} from './dockerExecutionOwnership.js';
import { scheduleForceKill } from './dockerAbortController.js';

/** contract.md design target for confirming real downstream cessation. */
export const ATTEMPT_CESSATION_CONFIRMATION_MS = 10_000;
const DEFAULT_CESSATION_POLL_MS = 250;

/**
 * What an attempt's owner can actually do when asked to pause:
 * - `suspend` — its containers can be frozen and thawed in place;
 * - `checkpoint` — it can save its state and stop at a safe point;
 * - `none` — neither is supported, and a pause request must be refused rather
 *   than acknowledged as paused.
 */
export type AttemptPauseCapability = 'suspend' | 'checkpoint' | 'none';

export type AttemptStatus = 'running' | 'suspended' | 'checkpointed' | 'cancelled' | 'completed';

export type AttemptRefusalReason =
    | 'execution-not-found'
    | 'attempt-not-active'
    | 'attempt-cancelled'
    | 'attempt-completed'
    | 'pause-unsupported'
    | 'already-paused'
    | 'no-container-to-suspend'
    | 'suspend-failed'
    | 'checkpoint-failed'
    | 'not-paused'
    | 'already-resumed'
    | 'resume-failed'
    | 'steer-unsupported'
    | 'attempt-suspended'
    | 'steer-delivery-failed';

export interface AttemptControlRefusal {
    outcome: 'refused';
    reason: AttemptRefusalReason;
    detail: string;
    recovery: string;
    /** The attempt that *is* active, for diagnostics only — never retargeted. */
    activeAttemptId?: string | null;
}

/** Everything actually observed about an attempt's cessation. */
export interface AttemptCessationEvidence {
    /** The owned abort marker was published for the worker to observe. */
    markerPublished: boolean;
    /** The abort marker is gone (the worker consumed it); null when unreadable. */
    markerCleared: boolean | null;
    /** The owned child process has exited; null when no child is owned here. */
    childExited: boolean | null;
    /** Container identifiers still observed for the attempt. */
    containersRemaining: string[];
    /** False when the Docker daemon could not be queried — the state is unknown. */
    containersObserved: boolean;
    /** Milliseconds from the start of propagation to this observation. */
    elapsedMs: number;
}

export interface AttemptCancellationResult {
    outcome: 'stopped' | 'still-running';
    evidence: AttemptCessationEvidence;
    /** Why cessation could not be confirmed (absent when `stopped`). */
    reason?: string;
    /** Operator-actionable recovery (absent when `stopped`). */
    recovery?: string;
    /** True when this call joined an in-flight cancellation of the same attempt. */
    joinedInFlight: boolean;
}

export interface AttemptPauseResult {
    outcome: 'suspended' | 'checkpointed';
    /** Container identifiers actually frozen (suspend mode). */
    suspendedContainers: string[];
    /** What the owner reported saving (checkpoint mode). */
    persistedState: string;
    /** Cessation evidence for checkpoint-and-stop; absent for a live suspend. */
    evidence?: AttemptCessationEvidence;
    /** Honest caveat about what a suspension does not stop (e.g. peer timeouts). */
    caveat?: string;
}

export interface AttemptResumeResult {
    outcome: 'resumed';
    /** `unpaused` thaws the same container; `continuation` resumes a checkpoint. */
    mode: 'unpaused' | 'continuation';
    /** Set once per checkpointed attempt — the single eligible continuation. */
    continuationToken?: string;
    detail: string;
}

export interface AttemptSteerResult {
    outcome: 'delivered';
    /** Version the owner acknowledged consuming. */
    version: number;
}

export type AttemptCancellationOutcome = AttemptCancellationResult | AttemptControlRefusal;
export type AttemptPauseOutcome = AttemptPauseResult | AttemptControlRefusal;
export type AttemptResumeOutcome = AttemptResumeResult | AttemptControlRefusal;
export type AttemptSteerOutcome = AttemptSteerResult | AttemptControlRefusal;

/** A steering revision handed to the owner of a running attempt. */
export interface AttemptSteerDelivery {
    executionId: string;
    attemptId: string;
    version: number;
    payload: unknown;
}

export interface ControlledAttemptRegistration {
    executionId: string;
    /** Ezer-visible attempt identifier (the control-plane target). */
    attemptId: string;
    /** ProPR task whose abort marker the worker polls. */
    taskId: string;
    /** Ownership fence written onto every container this attempt creates. */
    attemptGeneration: string;
    containerName?: string | null;
    /** Owned child process, when this process spawned `docker run` itself. */
    child?: ChildProcess | null;
    state?: SpawnedExecutionState | null;
    pauseCapability?: AttemptPauseCapability;
    /** Supplied when the owner can save state and stop at a safe point. */
    checkpoint?: () => Promise<{ saved: boolean; detail: string }>;
    /** Supplied when the owner can consume steering while running. */
    deliverSteer?: (delivery: AttemptSteerDelivery) => Promise<void>;
}

interface ActiveAttempt extends ControlledAttemptRegistration {
    pauseCapability: AttemptPauseCapability;
    status: AttemptStatus;
    suspendedContainers: string[];
    continuationClaimed: boolean;
    cancellation: Promise<AttemptCancellationResult> | null;
    registeredAt: number;
}

export interface ExecutionControlRegistryOptions {
    /**
     * Publishes the owned abort marker so an out-of-process worker's existing
     * abort checker terminates the execution. Returns whether it was written.
     */
    publishAbortMarker?: (taskId: string, attemptGeneration: string) => Promise<boolean>;
    /** Reads whether the abort marker is still present (it is cleared on abort). */
    readAbortMarker?: (taskId: string) => Promise<boolean>;
    observeContainers?: typeof observeExecutionContainers;
    pauseContainer?: (containerId: string) => Promise<ContainerSuspensionResult>;
    unpauseContainer?: (containerId: string) => Promise<ContainerSuspensionResult>;
    abortExecution?: typeof abortSpawnedExecution;
    scheduleForceKill?: (child: ChildProcess) => void;
    confirmationTimeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

function attemptKey(executionId: string, attemptId: string): string {
    return `${executionId} ${attemptId}`;
}

function childHasExited(child: ChildProcess | null | undefined): boolean | null {
    if (!child) return null;
    return child.exitCode !== null || child.signalCode !== null;
}

function refuse(
    reason: AttemptRefusalReason,
    detail: string,
    recovery: string,
    activeAttemptId?: string | null,
): AttemptControlRefusal {
    return { outcome: 'refused', reason, detail, recovery, activeAttemptId };
}

/**
 * Tracks the active attempt per execution and turns admitted control commands
 * into real, evidenced effects on the owning job and its containers.
 */
export class ExecutionControlRegistry {
    private readonly attempts = new Map<string, ActiveAttempt>();
    private readonly fenced = new Set<string>();
    private readonly options: Required<Omit<ExecutionControlRegistryOptions,
        'publishAbortMarker' | 'readAbortMarker'>>
        & Pick<ExecutionControlRegistryOptions, 'publishAbortMarker' | 'readAbortMarker'>;

    constructor(options: ExecutionControlRegistryOptions = {}) {
        this.options = {
            publishAbortMarker: options.publishAbortMarker,
            readAbortMarker: options.readAbortMarker,
            observeContainers: options.observeContainers ?? observeExecutionContainers,
            pauseContainer: options.pauseContainer ?? pauseDockerContainer,
            unpauseContainer: options.unpauseContainer ?? unpauseDockerContainer,
            abortExecution: options.abortExecution ?? abortSpawnedExecution,
            scheduleForceKill: options.scheduleForceKill ?? scheduleForceKill,
            confirmationTimeoutMs: options.confirmationTimeoutMs ?? ATTEMPT_CESSATION_CONFIRMATION_MS,
            pollIntervalMs: options.pollIntervalMs ?? DEFAULT_CESSATION_POLL_MS,
            now: options.now ?? Date.now,
            sleep: options.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms); })),
        };
    }

    /**
     * Binds an attempt to its ownership fence. Registering a replacement for an
     * execution fences the attempt it supersedes: the old attempt can no longer
     * be targeted and its publications are refused, even though the replacement
     * is now the only active attempt.
     */
    register(registration: ControlledAttemptRegistration): void {
        const previous = this.attempts.get(registration.executionId);
        if (previous && previous.attemptId === registration.attemptId) {
            // Re-binding the same attempt (e.g. once its container name is
            // known) updates the bindings only. Resetting its status here would
            // silently un-pause or un-cancel an attempt that is already there.
            Object.assign(previous, registration, {
                pauseCapability: registration.pauseCapability ?? previous.pauseCapability,
            });
            return;
        }
        if (previous) {
            this.fenced.add(attemptKey(previous.executionId, previous.attemptId));
            logger.info({
                executionId: previous.executionId,
                supersededAttemptId: previous.attemptId,
                attemptId: registration.attemptId,
            }, 'Fenced superseded execution attempt');
        }
        this.attempts.set(registration.executionId, {
            ...registration,
            pauseCapability: registration.pauseCapability ?? 'none',
            status: 'running',
            suspendedContainers: [],
            continuationClaimed: false,
            cancellation: null,
            registeredAt: this.options.now(),
        });
    }

    /** Marks an attempt finished normally; it stays fenced against late work. */
    complete(executionId: string, attemptId: string): void {
        const attempt = this.attempts.get(executionId);
        if (!attempt || attempt.attemptId !== attemptId) return;
        attempt.status = 'completed';
        this.fenced.add(attemptKey(executionId, attemptId));
    }

    getActiveAttemptId(executionId: string): string | null {
        return this.attempts.get(executionId)?.attemptId ?? null;
    }

    getStatus(executionId: string, attemptId: string): AttemptStatus | null {
        const attempt = this.attempts.get(executionId);
        return attempt && attempt.attemptId === attemptId ? attempt.status : null;
    }

    /** Whether an attempt is barred from publishing or being targeted. */
    isFenced(executionId: string, attemptId: string): boolean {
        return this.fenced.has(attemptKey(executionId, attemptId));
    }

    /** Explicitly fences an attempt (cancel/timeout paths). */
    fence(executionId: string, attemptId: string): void {
        this.fenced.add(attemptKey(executionId, attemptId));
    }

    /**
     * Resolves a command target to the exact active attempt. A command for an
     * unknown execution, a superseded attempt or a fenced attempt is refused —
     * it is never silently redirected onto the replacement.
     */
    resolve(executionId: string, attemptId: string):
        { ok: true; attempt: ActiveAttempt } | { ok: false; refusal: AttemptControlRefusal } {
        const targeted = this.resolveActive(executionId, attemptId);
        if (!targeted.ok) return targeted;
        const attempt = targeted.attempt;
        if (this.isFenced(executionId, attemptId)) {
            return {
                ok: false,
                refusal: refuse(
                    attempt.status === 'cancelled' ? 'attempt-cancelled' : 'attempt-completed',
                    `Attempt ${attemptId} is fenced (status ${attempt.status}) and accepts no further control.`,
                    'Start a new attempt if further work is required; the fenced attempt cannot publish or resume.',
                    attempt.attemptId,
                ),
            };
        }
        return { ok: true, attempt };
    }

    /** Targets the active attempt without applying the publication fence. */
    private resolveActive(executionId: string, attemptId: string):
        { ok: true; attempt: ActiveAttempt } | { ok: false; refusal: AttemptControlRefusal } {
        const attempt = this.attempts.get(executionId);
        if (!attempt) {
            return {
                ok: false,
                refusal: refuse(
                    'execution-not-found',
                    `No controlled attempt is registered for execution ${executionId}.`,
                    'Re-read the execution from the journal; the attempt may have finished or never started here.',
                    null,
                ),
            };
        }
        if (attempt.attemptId !== attemptId) {
            return {
                ok: false,
                refusal: refuse(
                    'attempt-not-active',
                    `Attempt ${attemptId} is not the active attempt for execution ${executionId}.`,
                    'Re-issue the command against the attempt reported by the journal; this command was not redirected.',
                    attempt.attemptId,
                ),
            };
        }
        return { ok: true, attempt };
    }

    /**
     * Cancels the exact active attempt: fences it first so no late publication
     * is accepted, propagates through the existing abort marker and ownership
     * teardown, then confirms real cessation from observed evidence.
     *
     * Concurrent cancellations of the same attempt join the in-flight
     * propagation rather than aborting twice or reporting a second stop.
     */
    async cancel(executionId: string, attemptId: string): Promise<AttemptCancellationOutcome> {
        // Cancel deliberately targets through `resolveActive`: an attempt that
        // is already fenced by an earlier cancel must join that cancellation's
        // real evidence rather than be refused as unreachable.
        const targeted = this.resolveActive(executionId, attemptId);
        if (!targeted.ok) return targeted.refusal;
        const attempt = targeted.attempt;
        if (attempt.status === 'completed') {
            return refuse(
                'attempt-completed',
                `Attempt ${attemptId} already reached a terminal result; there is nothing left to stop.`,
                'Read the terminal result from the journal; no cancellation was propagated.',
                attempt.attemptId,
            );
        }
        // The fence precedes propagation: from this instant the attempt may not
        // publish, even though its container may still be dying and no
        // replacement attempt exists yet.
        this.fence(executionId, attemptId);
        if (attempt.cancellation) {
            const result = await attempt.cancellation;
            return { ...result, joinedInFlight: true };
        }
        attempt.status = 'cancelled';
        attempt.cancellation = this.propagateCancellation(attempt);
        return attempt.cancellation;
    }

    /**
     * Pauses the exact active attempt using whatever its owner actually
     * supports. When neither in-place suspension nor a safe checkpoint is
     * available the request is refused — it is never acknowledged as paused.
     */
    async pause(executionId: string, attemptId: string): Promise<AttemptPauseOutcome> {
        const resolved = this.resolve(executionId, attemptId);
        if (!resolved.ok) return resolved.refusal;
        const attempt = resolved.attempt;
        if (attempt.status !== 'running') {
            return refuse(
                attempt.status === 'suspended' ? 'already-paused' : 'not-paused',
                `Attempt ${attemptId} is ${attempt.status} and cannot be paused again.`,
                'Resume the attempt before pausing it again.',
                attempt.attemptId,
            );
        }
        if (attempt.pauseCapability === 'suspend') return await this.suspendAttempt(attempt);
        if (attempt.pauseCapability === 'checkpoint' && attempt.checkpoint) {
            return await this.checkpointAttempt(attempt);
        }
        return refuse(
            'pause-unsupported',
            `Execution ${executionId} supports neither in-place suspension nor a safe checkpoint, `
            + 'so it is still running and was not paused.',
            'Let the attempt finish, or cancel it and start a new attempt from the desired input.',
            attempt.attemptId,
        );
    }

    /**
     * Resumes the exact active attempt. A suspended attempt is thawed in place;
     * a checkpointed attempt yields exactly one continuation claim. Either way a
     * second resume is refused, so no duplicate continuation is ever started.
     */
    async resume(executionId: string, attemptId: string): Promise<AttemptResumeOutcome> {
        const resolved = this.resolve(executionId, attemptId);
        if (!resolved.ok) return resolved.refusal;
        const attempt = resolved.attempt;
        if (attempt.status === 'suspended') return await this.thawAttempt(attempt);
        if (attempt.status === 'checkpointed') {
            if (attempt.continuationClaimed) {
                return refuse(
                    'already-resumed',
                    `The checkpoint of attempt ${attemptId} has already been claimed for continuation.`,
                    'Track the continuation that was already started; a second one would duplicate the work.',
                    attempt.attemptId,
                );
            }
            attempt.continuationClaimed = true;
            return {
                outcome: 'resumed',
                mode: 'continuation',
                continuationToken: `${executionId}:${attemptId}:continuation`,
                detail: 'Claimed the single eligible continuation of the saved checkpoint.',
            };
        }
        return refuse(
            'not-paused',
            `Attempt ${attemptId} is ${attempt.status}; there is no saved pause state to reconcile.`,
            'Only a suspended or checkpointed attempt can be resumed.',
            attempt.attemptId,
        );
    }

    /**
     * Hands a steering revision to the owner of the exact active attempt. The
     * revision is only reported as delivered when the owner accepted it, so the
     * control plane can keep "accepted" and "applied" apart truthfully.
     */
    async steer(executionId: string, attemptId: string, version: number, payload: unknown): Promise<AttemptSteerOutcome> {
        const resolved = this.resolve(executionId, attemptId);
        if (!resolved.ok) return resolved.refusal;
        const attempt = resolved.attempt;
        if (attempt.status === 'suspended') {
            return refuse(
                'attempt-suspended',
                `Attempt ${attemptId} is suspended, so the revision was recorded but not applied.`,
                'Resume the attempt; the newest revision applies to its subsequent activity.',
                attempt.attemptId,
            );
        }
        if (attempt.status !== 'running') {
            return refuse(
                'not-paused',
                `Attempt ${attemptId} is ${attempt.status} and cannot consume steering.`,
                'Start a new attempt with the revised input.',
                attempt.attemptId,
            );
        }
        if (!attempt.deliverSteer) {
            return refuse(
                'steer-unsupported',
                `Execution ${executionId} has no steering transport, so the revision was accepted but not applied.`,
                'Apply the revision on the next attempt, or cancel and restart with the revised input.',
                attempt.attemptId,
            );
        }
        try {
            await attempt.deliverSteer({ executionId, attemptId, version, payload });
            return { outcome: 'delivered', version };
        } catch (error) {
            return refuse(
                'steer-delivery-failed',
                `The owner of attempt ${attemptId} rejected revision ${version}: ${(error as Error).message}`,
                'Retry the revision with the same commandId, or cancel and restart with the revised input.',
                attempt.attemptId,
            );
        }
    }

    private async suspendAttempt(attempt: ActiveAttempt): Promise<AttemptPauseOutcome> {
        const observation = await this.observe(attempt);
        if (!observation.observed) {
            return refuse(
                'no-container-to-suspend',
                `Container state for attempt ${attempt.attemptId} is unavailable (${observation.error ?? 'unknown'}), `
                + 'so it was not suspended and is still running.',
                'Restore access to the Docker daemon and retry, or cancel the attempt instead.',
                attempt.attemptId,
            );
        }
        if (observation.present.length === 0) {
            return refuse(
                'no-container-to-suspend',
                `Attempt ${attempt.attemptId} owns no running container to suspend.`,
                'The attempt may have already finished; re-read its terminal state from the journal.',
                attempt.attemptId,
            );
        }
        const suspended: string[] = [];
        for (const containerId of observation.present) {
            const result = await this.options.pauseContainer(containerId);
            if (!result.success) {
                // Never leave a half-frozen attempt behind: thaw what was frozen
                // before reporting the refusal.
                for (const frozen of suspended) await this.options.unpauseContainer(frozen);
                return refuse(
                    'suspend-failed',
                    `Container ${containerId} could not be suspended (${result.error ?? 'unknown error'}); `
                    + 'the attempt is still running and was not paused.',
                    'Retry the pause, or cancel the attempt if it must stop.',
                    attempt.attemptId,
                );
            }
            suspended.push(containerId);
        }
        attempt.status = 'suspended';
        attempt.suspendedContainers = suspended;
        return {
            outcome: 'suspended',
            suspendedContainers: suspended,
            persistedState: 'Execution frozen in place; container filesystem and process state are retained.',
            caveat: 'Suspension freezes the container only. Connections held by remote peers may time out while frozen.',
        };
    }

    private async checkpointAttempt(attempt: ActiveAttempt): Promise<AttemptPauseOutcome> {
        let saved: { saved: boolean; detail: string };
        try {
            saved = await attempt.checkpoint!();
        } catch (error) {
            return refuse(
                'checkpoint-failed',
                `Checkpointing attempt ${attempt.attemptId} failed: ${(error as Error).message}. It is still running.`,
                'Retry the pause, or cancel the attempt if it must stop without a checkpoint.',
                attempt.attemptId,
            );
        }
        if (!saved.saved) {
            return refuse(
                'checkpoint-failed',
                `The owner of attempt ${attempt.attemptId} reported no saved checkpoint (${saved.detail}); `
                + 'it is still running and was not paused.',
                'Retry the pause, or cancel the attempt if it must stop without a checkpoint.',
                attempt.attemptId,
            );
        }
        // Checkpoint-and-stop is a real stop: prove the containers and child are
        // gone with the same evidence a cancellation requires.
        attempt.status = 'checkpointed';
        const evidence = await this.confirmCessation(attempt, this.options.now(), false);
        return {
            outcome: 'checkpointed',
            suspendedContainers: [],
            persistedState: saved.detail,
            evidence,
        };
    }

    private async thawAttempt(attempt: ActiveAttempt): Promise<AttemptResumeOutcome> {
        const frozen = attempt.suspendedContainers;
        // Flip the status before awaiting so a concurrent second resume sees a
        // running attempt and is refused instead of thawing twice.
        attempt.status = 'running';
        attempt.suspendedContainers = [];
        const failures: string[] = [];
        for (const containerId of frozen) {
            const result = await this.options.unpauseContainer(containerId);
            if (!result.success && !result.missing) failures.push(`${containerId}: ${result.error ?? 'unknown error'}`);
        }
        if (failures.length > 0) {
            attempt.status = 'suspended';
            attempt.suspendedContainers = frozen;
            return refuse(
                'resume-failed',
                `Attempt ${attempt.attemptId} is still suspended: ${failures.join('; ')}.`,
                'Retry the resume once the Docker daemon is reachable, or cancel the suspended attempt.',
                attempt.attemptId,
            );
        }
        return {
            outcome: 'resumed',
            mode: 'unpaused',
            detail: `Thawed ${frozen.length} suspended container(s); the same attempt continues.`,
        };
    }

    private async propagateCancellation(attempt: ActiveAttempt): Promise<AttemptCancellationResult> {
        const startedAt = this.options.now();
        let markerPublished = false;
        if (this.options.publishAbortMarker) {
            try {
                markerPublished = await this.options.publishAbortMarker(attempt.taskId, attempt.attemptGeneration);
            } catch (error) {
                logger.error({
                    taskId: attempt.taskId,
                    error: (error as Error).message,
                }, 'Failed to publish abort marker for cancelled attempt');
            }
        }
        if (attempt.child && attempt.state) {
            // Teardown is started, not awaited: it waits for the child to end,
            // which a hung child never does. Awaiting it would block the
            // confirmation window and leave the caller with no report at all
            // instead of a bounded, honest "still running". The polling loop
            // below observes its progress as it happens.
            void this.options.abortExecution(attempt.child, attempt.state, {
                namedContainer: attempt.containerName ?? null,
                scheduleForceKill: this.options.scheduleForceKill,
                taskId: attempt.taskId,
                attemptGeneration: attempt.attemptGeneration,
            }).catch((error: unknown) => {
                logger.error({
                    taskId: attempt.taskId,
                    attemptId: attempt.attemptId,
                    error: (error as Error).message,
                }, 'Owned execution teardown failed during cancellation');
            });
        }
        const evidence = await this.confirmCessation(attempt, startedAt, markerPublished);
        if (evidence.containersObserved
            && evidence.containersRemaining.length === 0
            && evidence.childExited !== false
            && evidence.markerCleared !== false) {
            return { outcome: 'stopped', evidence, joinedInFlight: false };
        }
        return {
            outcome: 'still-running',
            evidence,
            reason: describeUnconfirmedCessation(evidence),
            recovery: 'Re-issue the cancel with a new commandId, or stop the task directly'
                + ' (POST /api/task/:taskId/stop); the attempt stays fenced and cannot publish.',
            joinedInFlight: false,
        };
    }

    /**
     * Polls the real cessation signals — abort marker, owned child, owned
     * containers — until they all confirm or the confirmation window expires.
     * The returned evidence is exactly what was observed; the caller never
     * infers a stop from the absence of an observation.
     */
    private async confirmCessation(
        attempt: ActiveAttempt,
        startedAt: number,
        markerPublished: boolean,
    ): Promise<AttemptCessationEvidence> {
        const deadline = startedAt + this.options.confirmationTimeoutMs;
        let evidence = await this.observeCessation(attempt, startedAt, markerPublished);
        while (!isCessationConfirmed(evidence) && this.options.now() < deadline) {
            await this.options.sleep(Math.min(
                this.options.pollIntervalMs,
                Math.max(0, deadline - this.options.now()),
            ));
            evidence = await this.observeCessation(attempt, startedAt, markerPublished);
        }
        return evidence;
    }

    private async observeCessation(
        attempt: ActiveAttempt,
        startedAt: number,
        markerPublished: boolean,
    ): Promise<AttemptCessationEvidence> {
        const observation = await this.observe(attempt);
        let markerCleared: boolean | null = null;
        if (this.options.readAbortMarker) {
            try {
                markerCleared = !await this.options.readAbortMarker(attempt.taskId);
            } catch (error) {
                logger.debug({
                    taskId: attempt.taskId,
                    error: (error as Error).message,
                }, 'Abort marker state unavailable while confirming cessation');
                markerCleared = null;
            }
        }
        return {
            markerPublished,
            markerCleared,
            childExited: childHasExited(attempt.child),
            containersRemaining: observation.present,
            containersObserved: observation.observed,
            elapsedMs: Math.max(0, this.options.now() - startedAt),
        };
    }

    private observe(attempt: ActiveAttempt): Promise<ExecutionContainerObservation> {
        return this.options.observeContainers({
            taskId: attempt.taskId,
            attemptGeneration: attempt.attemptGeneration,
            containerName: attempt.containerName ?? null,
        });
    }
}

function isCessationConfirmed(evidence: AttemptCessationEvidence): boolean {
    return evidence.containersObserved
        && evidence.containersRemaining.length === 0
        && evidence.childExited !== false
        && evidence.markerCleared !== false;
}

function describeUnconfirmedCessation(evidence: AttemptCessationEvidence): string {
    const reasons: string[] = [];
    if (!evidence.containersObserved) reasons.push('container state could not be observed');
    else if (evidence.containersRemaining.length > 0) {
        reasons.push(`container(s) still present: ${evidence.containersRemaining.join(', ')}`);
    }
    if (evidence.childExited === false) reasons.push('the owned child process has not exited');
    if (evidence.markerCleared === false) reasons.push('the abort marker has not been consumed by the worker');
    return `Cessation was not confirmed within ${evidence.elapsedMs}ms: ${reasons.join('; ')}.`;
}

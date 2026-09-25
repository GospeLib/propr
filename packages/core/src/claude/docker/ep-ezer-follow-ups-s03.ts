/**
 * EP-ezer-follow-ups-S03 — confirmation of actual execution cessation (REQ-EF17).
 *
 * A control command's acknowledgement is not a stop. This module turns "we
 * asked the execution to stop" into observed evidence that it really stopped:
 * the owned child process has exited and no container owned by the fenced
 * attempt still exists. When the evidence is incomplete — or the Docker daemon
 * cannot be observed at all — it reports still-running with a reason and a
 * recovery instruction rather than claiming a stop that did not happen.
 *
 * Per `contract.md`, cessation is confirmed within the 10s design target where
 * supported; otherwise the caller must surface the explicit still-running
 * report. A false "stopped" and an unnoticed orphan are both defects.
 */

import type { ChildProcess } from 'node:child_process';
import { listOwnedExecutionContainers } from './dockerContainerControl.js';

/** How often the owned child/container state is re-observed while confirming. */
export const EZER_CESSATION_POLL_INTERVAL_MS = 250;

/** contract.md design target for downstream stop confirmation. */
export const EZER_CESSATION_CONFIRM_TIMEOUT_MS = 10_000;

/** Longest single `docker ps` observation inside one confirmation poll. */
const CONTAINER_OBSERVATION_BUDGET_MS = 2_000;

type ExecutionContainerEvidence =
  /** The daemon was queried and no owned container exists any more. */
  | 'confirmed-absent'
  /** The daemon was queried and at least one owned container still exists. */
  | 'still-present'
  /** The daemon could not be queried, so container state is unknown. */
  | 'unobservable'
  /** No container selector was available, so there is nothing to observe. */
  | 'not-applicable';

export interface ExecutionCessationReport {
    /** True only when every applicable cessation signal was actually observed. */
    stopped: boolean;
    childExited: boolean;
    childExitCode: number | null;
    childSignal: NodeJS.Signals | null;
    containerEvidence: ExecutionContainerEvidence;
    containersRemaining: string[];
    elapsedMs: number;
    pollCount: number;
    /** Present only when `stopped` is false: why cessation is unconfirmed. */
    reason?: string;
    /** Present only when `stopped` is false: the operator's next safe step. */
    recovery?: string;
}

/** The container ownership selectors an execution can be observed through. */
interface ExecutionCessationTarget {
    taskId?: string;
    attemptGeneration?: string;
    containerId?: string | null;
    containerName?: string | null;
}

interface ConfirmExecutionCessationOptions extends ExecutionCessationTarget {
    /** The spawned execution process; only its exit state is read. */
    child: Pick<ChildProcess, 'exitCode' | 'signalCode'>;
    timeoutMs?: number;
    pollIntervalMs?: number;
    /** Container observation seam; defaults to the real Docker daemon query. */
    listContainers?: (target: ExecutionCessationTarget, timeoutMs: number) => Promise<string[] | null>;
    now?: () => number;
    wait?: (ms: number) => Promise<void>;
}

function hasContainerSelector(target: ExecutionCessationTarget): boolean {
    return Boolean((target.taskId && target.attemptGeneration) || target.containerId || target.containerName);
}

function describeUnconfirmedCessation(report: ExecutionCessationReport, timeoutMs: number): void {
    const causes: string[] = [];
    if (!report.childExited) causes.push('the execution process had not exited');
    if (report.containerEvidence === 'still-present') {
        causes.push(`container(s) ${report.containersRemaining.join(', ')} still existed`);
    }
    if (report.containerEvidence === 'unobservable') {
        causes.push('the Docker daemon could not be queried, so container state is unknown');
    }
    report.reason = `Cessation was not confirmed within ${timeoutMs}ms: ${causes.join('; ')}.`;
    report.recovery = report.containerEvidence === 'unobservable'
        ? 'Restore Docker daemon access, then re-observe the attempt before treating it as stopped.'
        : 'Re-issue the stop for this attempt and inspect the listed containers; the attempt stays fenced so it cannot publish.';
}

/**
 * Polls the owned child process and the attempt's containers until both are
 * gone or the deadline expires, then reports exactly what was observed.
 *
 * `stopped` is true only when every applicable signal was positively observed.
 * An unobservable daemon never satisfies the container signal.
 */
export async function confirmExecutionCessation(
    options: ConfirmExecutionCessationOptions,
): Promise<ExecutionCessationReport> {
    const {
        child,
        timeoutMs = EZER_CESSATION_CONFIRM_TIMEOUT_MS,
        pollIntervalMs = EZER_CESSATION_POLL_INTERVAL_MS,
        listContainers = listOwnedExecutionContainers,
        now = Date.now,
        wait = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); }),
    } = options;
    const target: ExecutionCessationTarget = {
        taskId: options.taskId,
        attemptGeneration: options.attemptGeneration,
        containerId: options.containerId,
        containerName: options.containerName,
    };
    const observable = hasContainerSelector(target);
    const startedAt = now();
    const report: ExecutionCessationReport = {
        stopped: false,
        childExited: false,
        childExitCode: null,
        childSignal: null,
        containerEvidence: observable ? 'unobservable' : 'not-applicable',
        containersRemaining: [],
        elapsedMs: 0,
        pollCount: 0,
    };

    for (;;) {
        report.pollCount += 1;
        report.childExited = child.exitCode !== null || child.signalCode !== null;
        report.childExitCode = child.exitCode ?? null;
        report.childSignal = child.signalCode ?? null;
        if (observable) {
            const remainingMs = timeoutMs - (now() - startedAt);
            const observed = await listContainers(
                target,
                Math.max(1, Math.min(CONTAINER_OBSERVATION_BUDGET_MS, remainingMs)),
            );
            if (observed === null) {
                report.containerEvidence = 'unobservable';
            } else {
                report.containersRemaining = observed;
                report.containerEvidence = observed.length > 0 ? 'still-present' : 'confirmed-absent';
            }
        }
        const containersSettled = !observable || report.containerEvidence === 'confirmed-absent';
        if (report.childExited && containersSettled) {
            report.stopped = true;
            report.elapsedMs = now() - startedAt;
            return report;
        }
        const remainingMs = timeoutMs - (now() - startedAt);
        if (remainingMs <= 0) {
            report.elapsedMs = now() - startedAt;
            describeUnconfirmedCessation(report, timeoutMs);
            return report;
        }
        await wait(Math.max(0, Math.min(pollIntervalMs, remainingMs)));
    }
}

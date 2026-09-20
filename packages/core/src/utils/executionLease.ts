/**
 * The durable, generation-fenced right to run ONE paid execution of one logical operation.
 *
 * The terminal transition identity makes a settled operation recognisable AFTER the fact: a second
 * attempt claims the same key and cannot write a second completed row. That is a record-keeping
 * guarantee, and it arrives too late for money — the provider has already been invoked and
 * charged. Two things get past it: a redelivery whose Redis projection is gone (the durable
 * history says settled, the projection does not), and two deliveries in flight at once (both read
 * "nothing terminal yet", both execute).
 *
 * So the right to execute is itself made durable and mutually exclusive, in this table, keyed on
 * the same durable operation identity the transition identity is derived from:
 *
 * - ACQUISITION IS ATOMIC. `INSERT … ON CONFLICT DO NOTHING` is one statement, so exactly one
 *   concurrent attempt creates the row. Every other attempt reads back a row it does not own and
 *   is refused — the decision is the database's, never a read-then-write in application code.
 * - THE HOLDER IS FENCED BY GENERATION. Each attempt mints its own `lease_generation`; renewal,
 *   settlement and release are conditional UPDATE/DELETE statements matching that value, so an
 *   attempt that has been superseded cannot renew, settle or release the lease that supersedes it.
 * - TAKEOVER IS PROVEN, NEVER ASSUMED. The only way to take a lease from another generation is a
 *   single conditional UPDATE that requires the lease to be UNSETTLED and its expiry to be in the
 *   past — a live holder renews inside its term, so an expiry in the past means the holder stopped
 *   heartbeating. Because the UPDATE names the generation it observed, two would-be takers cannot
 *   both win: one affects a row, the other affects none and is refused.
 * - A SETTLED OPERATION IS NEVER TAKEN OVER. `settled_at` is terminal for the lease: expiry does
 *   not release it, so a settlement that is durable cannot be followed by another paid run.
 *
 * A legitimate retry of an UNSETTLED operation is deliberately still allowed: the previous attempt
 * released its lease on the way out, or it died and its term lapsed. A fence that refuses those is
 * a false refusal, which fails work instead of duplicating it — the opposite error, equally bad.
 */
import { db } from '../db/connection.js';

const EXECUTION_LEASES = 'task_execution_leases';

/** Default term of one lease. A live holder renews well inside it; a dead one lapses quickly. */
export const EXECUTION_LEASE_TTL_MS = 60_000;
/** Renewal cadence: three renewals per term, so one lost renewal cannot expire a live holder. */
export const EXECUTION_LEASE_RENEWAL_INTERVAL_MS = Math.floor(EXECUTION_LEASE_TTL_MS / 3);

/** Another live attempt holds the right to execute this operation. */
export const EXECUTION_LEASE_HELD = 'EXECUTION_LEASE_HELD';
/** The operation is durably settled; the lease will never be granted again. */
export const EXECUTION_LEASE_SETTLED = 'EXECUTION_LEASE_SETTLED';

export interface ExecutionLeaseRequest {
    /** The durable logical-operation identity — the same one the transition identity derives from. */
    leaseKey: string;
    taskId: string;
    operationId: string;
    /** This attempt's fence. Random per attempt on purpose: it identifies THIS holder, not the work. */
    generation: string;
    ttlMs?: number;
    now?: () => Date;
}

export interface HeldExecutionLease {
    leaseKey: string;
    generation: string;
    expiresAt: string;
}

export type ExecutionLeaseOutcome =
    | { outcome: 'acquired'; lease: HeldExecutionLease; takenOverFrom?: string }
    | { outcome: 'held'; holderGeneration: string; expiresAt: string }
    | { outcome: 'settled'; settledAt: string; settledState: string };

interface ExecutionLeaseRow {
    lease_key: string;
    task_id: string;
    operation_id: string;
    lease_generation: string;
    acquired_at: string;
    expires_at: string;
    settled_at: string | null;
    settled_state: string | null;
}

function expiry(now: Date, ttlMs: number): string {
    return new Date(now.getTime() + ttlMs).toISOString();
}

/**
 * Acquires the right to run this operation, or reports who holds it.
 *
 * The insert is the arbitration: one statement, one winner, and the read-back is of the row as the
 * database holds it rather than of what this process hoped to write.
 */
export async function acquireExecutionLease(request: ExecutionLeaseRequest): Promise<ExecutionLeaseOutcome> {
    const { leaseKey, taskId, operationId, generation } = request;
    const ttlMs = request.ttlMs ?? EXECUTION_LEASE_TTL_MS;
    const now = (request.now ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const expiresAt = expiry(now, ttlMs);

    await db(EXECUTION_LEASES).insert({
        lease_key: leaseKey, task_id: taskId, operation_id: operationId,
        lease_generation: generation, acquired_at: nowIso, expires_at: expiresAt,
        settled_at: null, settled_state: null,
    }).onConflict('lease_key').ignore();

    const held = await db(EXECUTION_LEASES).where({ lease_key: leaseKey }).first() as ExecutionLeaseRow | undefined;
    if (!held) throw new Error('the execution lease could not be read back after its claim');
    if (held.lease_generation === generation && !held.settled_at) {
        return { outcome: 'acquired', lease: { leaseKey, generation, expiresAt: held.expires_at } };
    }
    if (held.settled_at) {
        return { outcome: 'settled', settledAt: held.settled_at, settledState: held.settled_state ?? 'unknown' };
    }
    if (held.expires_at > nowIso) {
        return { outcome: 'held', holderGeneration: held.lease_generation, expiresAt: held.expires_at };
    }
    // The observed holder stopped renewing. Taking over is one conditional statement naming that
    // exact generation, so a concurrent taker either wins this row or sees no affected row at all.
    const takenOver = await db(EXECUTION_LEASES)
        .where({ lease_key: leaseKey, lease_generation: held.lease_generation })
        .whereNull('settled_at')
        .where('expires_at', '<=', nowIso)
        .update({ lease_generation: generation, task_id: taskId, operation_id: operationId,
            acquired_at: nowIso, expires_at: expiresAt });
    if (takenOver === 1) {
        return { outcome: 'acquired', lease: { leaseKey, generation, expiresAt }, takenOverFrom: held.lease_generation };
    }
    const current = await db(EXECUTION_LEASES).where({ lease_key: leaseKey }).first() as ExecutionLeaseRow | undefined;
    if (current?.settled_at) return { outcome: 'settled', settledAt: current.settled_at, settledState: current.settled_state ?? 'unknown' };
    return { outcome: 'held', holderGeneration: current?.lease_generation ?? held.lease_generation,
        expiresAt: current?.expires_at ?? held.expires_at };
}

/** Extends this generation's term. `false` means the lease is no longer this attempt's to renew. */
export async function renewExecutionLease(lease: HeldExecutionLease, ttlMs = EXECUTION_LEASE_TTL_MS,
    now: () => Date = () => new Date()): Promise<boolean> {
    const renewed = await db(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .whereNull('settled_at')
        .update({ expires_at: expiry(now(), ttlMs) });
    return renewed === 1;
}

/**
 * Marks the operation durably settled, so no later attempt may ever execute it again.
 *
 * Conditional on the generation: an attempt that was fenced out cannot settle the lease the
 * attempt that superseded it holds.
 */
export async function settleExecutionLease(lease: HeldExecutionLease, state: string,
    now: () => Date = () => new Date()): Promise<boolean> {
    const settled = await db(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .update({ settled_at: now().toISOString(), settled_state: state });
    return settled === 1;
}

/**
 * Releases an UNSETTLED lease this attempt still holds, so a legitimate retry need not wait out
 * the term. A settled lease is left exactly as it is — releasing it would re-permit paid work.
 */
export async function releaseExecutionLease(lease: HeldExecutionLease): Promise<boolean> {
    const released = await db(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .whereNull('settled_at')
        .delete();
    return released === 1;
}

/**
 * Keeps a held lease alive for as long as the execution runs, and reports the moment it is lost.
 *
 * Without this the term would have to outlast the longest possible provider run, and every crash
 * would block retries for that whole term.
 */
export function startExecutionLeaseRenewal(lease: HeldExecutionLease, options: {
    ttlMs?: number; intervalMs?: number; onLost?: () => void; onError?: (error: Error) => void;
} = {}): () => void {
    const ttlMs = options.ttlMs ?? EXECUTION_LEASE_TTL_MS;
    const interval = setInterval(() => {
        void renewExecutionLease(lease, ttlMs)
            .then(renewed => { if (!renewed) options.onLost?.(); })
            .catch((error: Error) => options.onError?.(error));
    }, options.intervalMs ?? EXECUTION_LEASE_RENEWAL_INTERVAL_MS);
    interval.unref?.();
    return () => clearInterval(interval);
}

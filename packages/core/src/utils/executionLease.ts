/**
 * The durable, generation-fenced right to run ONE paid execution of one logical operation.
 *
 * The terminal transition identity makes a settled operation recognisable AFTER the fact: a second
 * attempt claims the same key and cannot write a second completed row. That is post-execution
 * DEDUPLICATION — a record-keeping guarantee — and it arrives too late for money, because the
 * provider has already been invoked and charged. Execution EXCLUSION is a different guarantee, and
 * it is the one this table exists to give.
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
 * - AN EXPIRED TERM IS NOT PROOF THAT ANYTHING STOPPED. A missed heartbeat says only that this
 *   process did not hear one: a suspended event loop, a stalled write, a paused container or a
 *   skewed clock all produce it while the provider keeps running and keeps charging. Expiry
 *   therefore grants NOTHING on its own. Taking a lapsed lease requires a durable, separately
 *   recorded proof that the named prior generation stopped (`recordExecutorStopProof`), and that
 *   proof is consumed when it is used, so it can admit exactly one successor.
 * - A SETTLED OPERATION IS NEVER TAKEN OVER. `settled_at` is terminal for the lease: expiry does
 *   not release it, so a settlement that is durable cannot be followed by another paid run.
 * - TIME COMES FROM THE DATABASE. Every term, every expiry comparison and every settlement stamp
 *   is read from the same SQLite clock, so a contender's process clock — skewed, frozen or simply
 *   wrong — can neither shorten another attempt's term nor lengthen its own.
 *
 * WHY THE STRONGEST FIX IS NOT AVAILABLE HERE. The strongest defence against a duplicate charge is
 * provider-side idempotency — a key the provider itself recognises, so a repeated request cannot
 * become a second billable execution. ProPR cannot supply one: the paid execution is the Claude
 * Code CLI run inside a container (`claude -p -`, stdin-fed, `--output-format stream-json`), so
 * ProPR never issues the model request and has no header, body field or CLI flag to carry a key;
 * the CLI exposes no idempotency or deduplication option, and the Anthropic Messages API has no
 * documented idempotency-key header for one to be forwarded to. So exclusion has to be achieved
 * BEFORE the provider is reached, which is what this table does, and it is the only thing that
 * does it. A path without a lease has post-execution deduplication only: it can record one
 * outcome per operation, and nothing stops it paying twice to get there.
 *
 * A legitimate retry of an UNSETTLED operation is still allowed, but only through a VOLUNTARY
 * release: the attempt that holds the fence is alive, has established that nothing terminal of
 * its own became durable, and hands the lease back itself. That is proof the executor stopped,
 * because the executor is the one saying so. Nothing infers the same thing from silence.
 *
 * WHAT THIS STILL DOES NOT GUARANTEE. A voluntary release after a provider invocation that
 * produced NO durable terminal record lets the next delivery invoke the provider again. That is a
 * retry of an operation nothing settled, which is the behaviour this route wants — but if the
 * first invocation was billed before it failed, the retry is a second charge. At-most-once
 * execution is therefore guaranteed for a SETTLED operation, not for every operation that ever
 * reached the provider.
 */
import type { Knex } from 'knex';
import { db } from '../db/connection.js';

const EXECUTION_LEASES = 'task_execution_leases';
const EXECUTOR_STOP_PROOFS = 'task_execution_lease_stop_proofs';

/** Default term of one lease. A live holder renews well inside it; a dead one lapses quickly. */
export const EXECUTION_LEASE_TTL_MS = 60_000;
/** Renewal cadence: three renewals per term, so one lost renewal cannot expire a live holder. */
export const EXECUTION_LEASE_RENEWAL_INTERVAL_MS = Math.floor(EXECUTION_LEASE_TTL_MS / 3);

/** Another live attempt holds the right to execute this operation. */
export const EXECUTION_LEASE_HELD = 'EXECUTION_LEASE_HELD';
/** The operation is durably settled; the lease will never be granted again. */
export const EXECUTION_LEASE_SETTLED = 'EXECUTION_LEASE_SETTLED';
/** The holder's term lapsed and nothing has proved it stopped; only reconciliation moves this. */
export const EXECUTION_LEASE_UNRECONCILED = 'EXECUTION_LEASE_EXPIRED_WITHOUT_STOP_PROOF';

export interface ExecutionLeaseRequest {
    /** The durable logical-operation identity — the same one the transition identity derives from. */
    leaseKey: string;
    taskId: string;
    operationId: string;
    /** This attempt's fence. Random per attempt on purpose: it identifies THIS holder, not the work. */
    generation: string;
    ttlMs?: number;
}

export interface HeldExecutionLease {
    leaseKey: string;
    generation: string;
    expiresAt: string;
}

export type ExecutionLeaseOutcome =
    | { outcome: 'acquired'; lease: HeldExecutionLease; takenOverFrom?: string }
    | { outcome: 'held'; holderGeneration: string; expiresAt: string }
    | { outcome: 'unreconciled'; holderGeneration: string; expiresAt: string }
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

type Queryable = Knex | Knex.Transaction;

/**
 * The instant as the DATABASE holds it, in the same lexicographic ISO form the columns store.
 *
 * Every attempt compares against one clock this way. A contender whose process clock runs fast
 * would otherwise see a live holder's term as lapsed, and a holder whose clock runs slow would
 * grant itself a term it has not earned — both of which end in two provider runs.
 */
export async function databaseNow(connection: Queryable = db): Promise<string> {
    const result = await connection.raw(`select strftime('%Y-%m-%dT%H:%M:%fZ','now') as now`) as unknown;
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows ?? []) as { now?: string }[];
    const now = rows[0]?.now;
    if (!now) throw new Error('the database clock could not be read, so no lease decision may be made');
    return now;
}

function expiry(now: string, ttlMs: number): string {
    return new Date(new Date(now).getTime() + ttlMs).toISOString();
}

/**
 * Records durable proof that a NAMED prior generation of this lease has stopped executing.
 *
 * This is the only thing that can unblock a lapsed lease, and it is deliberately not something a
 * contender can derive for itself: it is written by whoever established the fact — an operator
 * who confirmed the container is gone, or a reconciler that verified it — and it names the exact
 * generation it is about, so it cannot authorise the takeover of some later holder.
 */
export async function recordExecutorStopProof(options: {
    leaseKey: string; generation: string; proof: string; recordedBy: string;
}): Promise<void> {
    if (!options.proof.trim()) throw new Error('an executor stop proof must state what was verified');
    await db(EXECUTOR_STOP_PROOFS).insert({
        lease_key: options.leaseKey, lease_generation: options.generation,
        proof: options.proof, recorded_by: options.recordedBy,
        recorded_at: await databaseNow(), consumed_at: null, consumed_by_generation: null,
    }).onConflict(['lease_key', 'lease_generation']).ignore();
}

/**
 * Consumes the stop proof for the observed generation, if one exists.
 *
 * Consumption is a conditional UPDATE, so of two contenders that both read the same unconsumed
 * proof exactly one claims it; the other is told the lease is still unreconciled rather than
 * being allowed to race for the row.
 */
async function claimStopProof(leaseKey: string, generation: string, taker: string, now: string): Promise<boolean> {
    const claimed = await db(EXECUTOR_STOP_PROOFS)
        .where({ lease_key: leaseKey, lease_generation: generation })
        .whereNull('consumed_at')
        .update({ consumed_at: now, consumed_by_generation: taker });
    return claimed === 1;
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
    const now = await databaseNow();
    const expiresAt = expiry(now, ttlMs);

    await db(EXECUTION_LEASES).insert({
        lease_key: leaseKey, task_id: taskId, operation_id: operationId,
        lease_generation: generation, acquired_at: now, expires_at: expiresAt,
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
    if (held.expires_at > now) {
        return { outcome: 'held', holderGeneration: held.lease_generation, expiresAt: held.expires_at };
    }
    // The term lapsed. That is not evidence the holder stopped — only that nothing renewed it —
    // so it buys nothing by itself. A takeover needs a stop proof naming this exact generation,
    // and consuming that proof is what makes it usable once.
    if (!await claimStopProof(leaseKey, held.lease_generation, generation, now)) {
        return { outcome: 'unreconciled', holderGeneration: held.lease_generation, expiresAt: held.expires_at };
    }
    // The proof is spent; the takeover is still one conditional statement naming the generation it
    // was written about, so a row that moved underneath us affects nothing.
    const takenOver = await db(EXECUTION_LEASES)
        .where({ lease_key: leaseKey, lease_generation: held.lease_generation })
        .whereNull('settled_at')
        .where('expires_at', '<=', now)
        .update({ lease_generation: generation, task_id: taskId, operation_id: operationId,
            acquired_at: now, expires_at: expiresAt });
    if (takenOver === 1) {
        return { outcome: 'acquired', lease: { leaseKey, generation, expiresAt }, takenOverFrom: held.lease_generation };
    }
    const current = await db(EXECUTION_LEASES).where({ lease_key: leaseKey }).first() as ExecutionLeaseRow | undefined;
    if (current?.settled_at) return { outcome: 'settled', settledAt: current.settled_at, settledState: current.settled_state ?? 'unknown' };
    return { outcome: 'held', holderGeneration: current?.lease_generation ?? held.lease_generation,
        expiresAt: current?.expires_at ?? held.expires_at };
}

/** Extends this generation's term. `false` means the lease is no longer this attempt's to renew. */
export async function renewExecutionLease(lease: HeldExecutionLease, ttlMs = EXECUTION_LEASE_TTL_MS): Promise<boolean> {
    const renewed = await db(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .whereNull('settled_at')
        .update({ expires_at: expiry(await databaseNow(), ttlMs) });
    return renewed === 1;
}

/**
 * Marks the operation durably settled, so no later attempt may ever execute it again.
 *
 * Conditional on the generation: an attempt that was fenced out cannot settle the lease the
 * attempt that superseded it holds.
 *
 * The `connection` is how a caller settles INSIDE the same transaction as its terminal history
 * write. Settling afterwards leaves a crash window in which the operation is terminal and its
 * lease is not, which is a window a lost projection can turn back into paid work.
 */
export async function settleExecutionLease(lease: HeldExecutionLease, state: string,
    connection: Queryable = db): Promise<boolean> {
    const settled = await connection(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .update({ settled_at: await databaseNow(connection), settled_state: state });
    return settled === 1;
}

/**
 * Releases an UNSETTLED lease this attempt still holds, so a legitimate retry need not wait out
 * the term. A settled lease is left exactly as it is — releasing it would re-permit paid work.
 *
 * This is the ONLY route back to an executable operation, and it is deliberately voluntary: the
 * caller is alive, holds the fence, and has established that nothing terminal of its own became
 * durable. Releasing on any weaker basis is how a still-running execution gets a twin.
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
 * would block retries for that whole term. `onLost` fires on a CONFIRMED loss of the fence — the
 * conditional renewal matched no row — and the caller is expected to stop executing at once
 * rather than to note it: from that moment another attempt may be running the same paid work.
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

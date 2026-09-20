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
 *   proof is consumed when it is used, so it can admit exactly one successor. CONSUMING IT AND
 *   TAKING THE LEASE ARE ONE TRANSACTION: a proof that is spent without the takeover landing is a
 *   proof that can never be spent again, and the operation it was about would then be refused for
 *   ever with no way back. Either both statements commit or neither does.
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
 * WHERE A VOLUNTARY RELEASE STOPS. "I settled nothing" is not "I spent nothing". An attempt that
 * reached the provider and then lost its outcome may already have been BILLED, and handing its
 * lease straight back makes the next delivery pay for that same work again. So a release is
 * permitted only to an attempt that never reached the provider at all. One that did marks
 * `provider_invocation_started` and KEEPS its lease; the term then lapses into `unreconciled` and
 * the operation waits until someone establishes what that executor actually did. At-most-once
 * execution is therefore guaranteed for every operation that reached the provider, at the price of
 * an operation that must be reconciled deliberately — `recordVerifiedExecutorStop` is how that is
 * done without turning the reconciliation itself into the second charge.
 */
import type { Knex } from 'knex';
import { db } from '../db/connection.js';

const EXECUTION_LEASES = 'task_execution_leases';
const EXECUTOR_STOP_PROOFS = 'task_execution_lease_stop_proofs';

/** Default term of one lease. A live holder renews well inside it; a dead one lapses quickly. */
export const EXECUTION_LEASE_TTL_MS = 60_000;
/** Renewal cadence: three renewals per term, so one lost renewal cannot expire a live holder. */
export const EXECUTION_LEASE_RENEWAL_INTERVAL_MS = Math.floor(EXECUTION_LEASE_TTL_MS / 3);
/** Long enough that a stop proof cannot be a keystroke; short enough to be a real sentence. */
export const MINIMUM_STOP_PROOF_LENGTH = 20;

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
    provider_invocation_started?: number | boolean | null;
    reconciliation_reason?: string | null;
    reconciliation_requested_at?: string | null;
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
}): Promise<StopProofRecording> {
    if (!options.proof.trim()) throw new Error('an executor stop proof must state what was verified');
    // `ignore()` is silent by design — two operators recording the same verified fact must not
    // fight over the row — but silence is the wrong answer to "why is this operation still
    // refused?". What is already on file is read first and reported, so a caller can tell an
    // idempotent re-record from a proof that has already been SPENT, which is the difference
    // between "nothing to do" and "this generation can never be admitted again".
    //
    // The read is not the arbitration and does not need to be: the insert below still admits
    // exactly one row whatever two callers read at the same moment.
    const existing = await db(EXECUTOR_STOP_PROOFS)
        .where({ lease_key: options.leaseKey, lease_generation: options.generation })
        .first() as { consumed_at: string | null } | undefined;
    if (existing) return existing.consumed_at ? 'already_consumed' : 'already_recorded';
    await db(EXECUTOR_STOP_PROOFS).insert({
        lease_key: options.leaseKey, lease_generation: options.generation,
        proof: options.proof, recorded_by: options.recordedBy,
        recorded_at: await databaseNow(), consumed_at: null, consumed_by_generation: null,
    }).onConflict(['lease_key', 'lease_generation']).ignore();
    return 'recorded';
}

/** What `recordExecutorStopProof` found on file for this exact generation. */
export type StopProofRecording = 'recorded' | 'already_recorded' | 'already_consumed';

/** Rolls the takeover transaction back without reporting a failure the caller must handle. */
class TakeoverDidNotLand extends Error {
    constructor() { super('the expired lease did not move, so its stop proof is not spent'); }
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
        // Written explicitly rather than left to the column default: whether this attempt reached
        // the provider is the fact the release rule turns on, and it starts as a stated `false`.
        provider_invocation_started: false, reconciliation_reason: null, reconciliation_requested_at: null,
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
    //
    // CONSUMPTION AND TAKEOVER ARE ONE TRANSACTION. Spending the proof in its own committed
    // statement and taking the lease in the next left a gap with no way out of it: a crash, a
    // SQLite failure or a renewal landing in between leaves the prior generation installed over a
    // proof that is already spent, and `recordExecutorStopProof` cannot write that generation's
    // proof a second time — so every later attempt reads `unreconciled` for ever and the operation
    // is stuck. Inside one transaction the proof is spent only if the takeover moved exactly one
    // row; anything else rolls the consumption back and leaves the proof on file, unspent, for the
    // next attempt.
    let takenOver: 'acquired' | 'unreconciled' | 'did-not-land';
    try {
        takenOver = await db.transaction(async transaction => {
            const claimed = await transaction(EXECUTOR_STOP_PROOFS)
                .where({ lease_key: leaseKey, lease_generation: held.lease_generation })
                .whereNull('consumed_at')
                .update({ consumed_at: now, consumed_by_generation: generation });
            // No proof, or another contender spent it first. Nothing was written, so committing an
            // empty transaction is the honest outcome.
            if (claimed !== 1) return 'unreconciled';
            const moved = await transaction(EXECUTION_LEASES)
                .where({ lease_key: leaseKey, lease_generation: held.lease_generation })
                .whereNull('settled_at')
                .where('expires_at', '<=', now)
                .update({ lease_generation: generation, task_id: taskId, operation_id: operationId,
                    acquired_at: now, expires_at: expiresAt, provider_invocation_started: false,
                    reconciliation_reason: null, reconciliation_requested_at: null });
            // A late renewal, a settlement, or a takeover by someone else moved the row out from
            // under this one. The proof must go back on file with it.
            if (moved !== 1) throw new TakeoverDidNotLand();
            return 'acquired';
        });
    } catch (error) {
        // Whatever failed — the conditional takeover matching nothing, or SQLite refusing the
        // write — the transaction is gone and with it the consumption. A genuine database fault is
        // not swallowed into a refusal: it propagates, because "the database would not answer" is
        // never permission to start a second paid run.
        if (!(error instanceof TakeoverDidNotLand)) throw error;
        takenOver = 'did-not-land';
    }
    if (takenOver === 'acquired') {
        return { outcome: 'acquired', lease: { leaseKey, generation, expiresAt }, takenOverFrom: held.lease_generation };
    }
    if (takenOver === 'unreconciled') {
        return { outcome: 'unreconciled', holderGeneration: held.lease_generation, expiresAt: held.expires_at };
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
 * Records, durably and before the fact, that this attempt is about to reach the provider.
 *
 * From this moment the attempt can no longer hand its lease back on the grounds that it settled
 * nothing: a provider invocation can be billed and then be lost — the process dies, the stream
 * breaks, the terminal write fails — and "nothing was recorded" says nothing about whether
 * anything was charged. The flag is written BEFORE the call so a crash during the call still
 * finds it set; writing it afterwards would leave exactly the window it exists to close.
 *
 * `false` means this attempt no longer holds the lease, which is itself a reason not to execute.
 */
export async function markProviderInvocationStarted(lease: HeldExecutionLease): Promise<boolean> {
    const marked = await db(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .whereNull('settled_at')
        .update({ provider_invocation_started: true });
    return marked === 1;
}

/**
 * Leaves an unsettled lease in place and says, on the row, why it is waiting.
 *
 * The lease is already retained by simply not releasing it; this adds the one thing an operator
 * cannot reconstruct afterwards — what this attempt knew when it gave up. Without it a lapsed
 * lease is indistinguishable from any other, and the safe decision becomes unmakeable.
 */
export async function retainLeaseForReconciliation(lease: HeldExecutionLease, reason: string): Promise<boolean> {
    const retained = await db(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .whereNull('settled_at')
        .update({ reconciliation_reason: reason, reconciliation_requested_at: await databaseNow() });
    return retained === 1;
}

/** One lapsed, unsettled lease as a reconciliation decision needs to see it. */
export interface LapsedExecutionLease {
    leaseKey: string;
    taskId: string;
    operationId: string;
    holderGeneration: string;
    acquiredAt: string;
    expiresAt: string;
    /** Whether that holder had already reached the provider. The whole decision turns on this. */
    providerInvocationStarted: boolean;
    reconciliationReason?: string;
    /** What is already on file about this exact generation, so a second proof is not invented. */
    stopProof?: { recordedBy: string; recordedAt: string; consumedAt?: string };
}

/**
 * Every unsettled lease whose term has lapsed — the complete set of stuck operations.
 *
 * Derived from the database's own clock, so an operator's skewed workstation cannot make a live
 * holder look abandoned in this listing.
 */
export async function lapsedExecutionLeases(): Promise<LapsedExecutionLease[]> {
    const now = await databaseNow();
    const rows = await db(EXECUTION_LEASES)
        .whereNull('settled_at').where('expires_at', '<=', now)
        .orderBy('expires_at') as ExecutionLeaseRow[];
    const proofs = rows.length === 0 ? [] : await db(EXECUTOR_STOP_PROOFS)
        .whereIn('lease_key', rows.map(row => row.lease_key)) as {
            lease_key: string; lease_generation: string; recorded_by: string;
            recorded_at: string; consumed_at: string | null;
        }[];
    return rows.map(row => {
        const proof = proofs.find(candidate => candidate.lease_key === row.lease_key
            && candidate.lease_generation === row.lease_generation);
        return {
            leaseKey: row.lease_key, taskId: row.task_id, operationId: row.operation_id,
            holderGeneration: row.lease_generation, acquiredAt: row.acquired_at, expiresAt: row.expires_at,
            providerInvocationStarted: Boolean(row.provider_invocation_started),
            ...(row.reconciliation_reason ? { reconciliationReason: row.reconciliation_reason } : {}),
            ...(proof ? { stopProof: { recordedBy: proof.recorded_by, recordedAt: proof.recorded_at,
                ...(proof.consumed_at ? { consumedAt: proof.consumed_at } : {}) } } : {}),
        };
    });
}

/** Why a deliberate reconciliation was refused. Each one is a way the proof would have been false. */
export type ExecutorStopRefusal =
    | 'no such lease'
    | 'the lease is settled and needs no reconciliation'
    | 'the named generation no longer holds this lease'
    | 'the term has not lapsed, so the executor is still reporting itself alive'
    | 'a proof for this generation is already on file'
    | 'a proof for this generation has already been spent'
    | 'the confirmation did not match the generation being declared stopped'
    | 'the proof must state what was verified, in the operator\'s own words';

export type ExecutorStopOutcome = { recorded: true } | { recorded: false; refusal: ExecutorStopRefusal };

/**
 * The deliberate, checked way to record that a named executor stopped.
 *
 * `recordExecutorStopProof` is the raw write, and a raw write is the wrong shape for a hand
 * operation whose only failure mode is an operator who is mistaken: a proof about a generation
 * that is still running is a licence to pay twice, and it cannot be taken back — it will be spent
 * by the very next delivery. So every way of being mistaken that the database can see is checked
 * here, in one place, before anything is written:
 *
 * - the generation named must be the one CURRENTLY holding the lease, not one the operator copied
 *   from an older log line;
 * - the term must actually have lapsed, so a holder that is still heartbeating is never declared
 *   dead;
 * - the lease must be unsettled, so a finished operation is never reopened;
 * - the generation must be typed twice and match, because the whole safety of this depends on
 *   WHICH generation it names;
 * - and a proof already on file is reported rather than overwritten, so two operators reconciling
 *   the same incident cannot stack two admissions.
 *
 * What it cannot check is the only thing that matters — whether the container is really gone — so
 * it demands that in words, and records who said it.
 */
export async function recordVerifiedExecutorStop(options: {
    leaseKey: string; generation: string; confirmGeneration: string; proof: string; recordedBy: string;
}): Promise<ExecutorStopOutcome> {
    const refuse = (refusal: ExecutorStopRefusal): ExecutorStopOutcome => ({ recorded: false, refusal });
    if (options.generation !== options.confirmGeneration) {
        return refuse('the confirmation did not match the generation being declared stopped');
    }
    if (options.proof.trim().length < MINIMUM_STOP_PROOF_LENGTH || !options.recordedBy.trim()) {
        return refuse('the proof must state what was verified, in the operator\'s own words');
    }
    const row = await db(EXECUTION_LEASES).where({ lease_key: options.leaseKey })
        .first() as ExecutionLeaseRow | undefined;
    if (!row) return refuse('no such lease');
    if (row.settled_at) return refuse('the lease is settled and needs no reconciliation');
    if (row.lease_generation !== options.generation) return refuse('the named generation no longer holds this lease');
    if (row.expires_at > await databaseNow()) {
        return refuse('the term has not lapsed, so the executor is still reporting itself alive');
    }
    const recorded = await recordExecutorStopProof({
        leaseKey: options.leaseKey, generation: options.generation,
        proof: options.proof, recordedBy: options.recordedBy,
    });
    if (recorded === 'already_recorded') return refuse('a proof for this generation is already on file');
    if (recorded === 'already_consumed') return refuse('a proof for this generation has already been spent');
    return { recorded: true };
}

/**
 * Releases an UNSETTLED lease this attempt still holds, so a legitimate retry need not wait out
 * the term. A settled lease is left exactly as it is — releasing it would re-permit paid work.
 *
 * It refuses a lease whose attempt REACHED THE PROVIDER. Such an attempt knows it settled nothing;
 * it does not know that nothing was charged, and those are different facts. Handing that lease
 * back would make the next delivery pay again for work that may already be paid for, so the lease
 * stays and the operation waits for a deliberate reconciliation instead.
 *
 * The condition is in the DELETE, not in the caller: a released lease is a decision about money,
 * and the database is where that decision is made.
 */
export async function releaseExecutionLease(lease: HeldExecutionLease): Promise<boolean> {
    const released = await db(EXECUTION_LEASES)
        .where({ lease_key: lease.leaseKey, lease_generation: lease.generation })
        .whereNull('settled_at')
        .where('provider_invocation_started', false)
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

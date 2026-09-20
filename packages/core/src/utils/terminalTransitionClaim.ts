/**
 * The durable identity of one logical terminal transition, claimed before the terminal write.
 *
 * A randomly generated idempotency key is worthless across the failure it exists for: the process
 * dies after the history INSERT commits, the work is redelivered, and the retry invents a
 * different key — so the read-back finds nothing, the completion looks absent, and a duplicate
 * row or a `failed` settlement over a delivered success follows.
 *
 * The identity is therefore a pure function of the task, the target state and the caller's
 * DURABLE logical-operation identity (a signed execution admission, or the queue job that owns
 * the attempt), and it is persisted in `task_terminal_transitions` before anything terminal is
 * written. A crash and a redelivery re-derive it, re-claim it, and get the same value back.
 *
 * It lives in core, beside the state manager, because the publishers that need it are not all in
 * one place: the queued jobs reach it through the durability barrier, and the synchronous native
 * analysis route claims its own.
 */
import { createHash } from 'node:crypto';
import { db } from '../db/connection.js';

/** A caller offered no durable identity for the logical operation that owns this transition. */
export const TERMINAL_OPERATION_IDENTITY_MISSING = 'TERMINAL_OPERATION_IDENTITY_MISSING';
const TERMINAL_TRANSITION_CLAIMS = 'task_terminal_transitions';

/**
 * Builds the durable logical-operation identity from the most durable identifier the path has.
 *
 * Refuses an absent one rather than silently falling back to something per-attempt: a key that
 * changes across a retry is worse than no key, because it reads as "nothing landed".
 */
export function durableOperationIdentity(kind: string, durableId: string | number | undefined | null): string {
    const id = typeof durableId === 'number' ? String(durableId) : durableId?.trim();
    if (!id) throw new Error(`${TERMINAL_OPERATION_IDENTITY_MISSING}: ${kind}`);
    return `${kind}:${id}`;
}

/**
 * The idempotency key for one logical terminal transition.
 *
 * Hashed so any operation identity fits the indexed column; the readable parts stay in the claim
 * row. Distinct per task, per target state and per operation, identical for everything else.
 */
export function terminalTransitionId(taskId: string, state: string, operationId: string): string {
    const digest = createHash('sha256').update(`${taskId}\u0000${state}\u0000${operationId}`).digest('hex');
    return `${state}:${digest}`;
}

/**
 * Claims the transition identity durably, before the terminal write.
 *
 * Idempotent on `(task_id, state, operation_id)`, so a retry of the same logical operation reads
 * back the identity the earlier attempt claimed instead of minting a new one. The returned value
 * is the identity as the database holds it, never the locally derived one.
 */
export async function claimTerminalTransition(taskId: string, state: string, operationId: string): Promise<string> {
    const transitionId = terminalTransitionId(taskId, state, operationId);
    await db(TERMINAL_TRANSITION_CLAIMS)
        .insert({ transition_id: transitionId, task_id: taskId, state, operation_id: operationId, claimed_at: new Date().toISOString() })
        .onConflict('transition_id').ignore();
    const claimed = await db(TERMINAL_TRANSITION_CLAIMS).where({ transition_id: transitionId }).first();
    if (!claimed) throw new Error('the terminal transition identity was not durably claimed');
    return String(claimed.transition_id);
}

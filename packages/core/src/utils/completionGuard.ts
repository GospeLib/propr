/**
 * The state-transition boundary that makes an unguarded `completed` impossible.
 *
 * A source sweep can only police the spellings it was taught; a completion written through a
 * variable, a helper in another package, or a state-manager method nobody remembered still
 * reaches the database. So the invariant is enforced where every completion must pass instead:
 * the transition builder itself refuses `completed` unless the caller presents a capability it
 * could only have obtained by going through the durability barrier (for an execution) or by
 * declaring, in the call, that no model execution ran.
 *
 * The capability is an opaque, brand-checked object: a plain `{ reason: 'whatever' }` literal
 * cannot forge it, so the refusal cannot be argued away at the call site. For an executed
 * completion the capability also carries the transition identity it was minted for, and the
 * builder requires `metadata.transitionId` to match it — an executed completion therefore cannot
 * be published under any key other than the one the barrier durably claimed for it.
 */
import { TaskStates, type TaskState, type UpdateMetadata } from './workerStateManager.types.js';

/** A completed transition was requested without the capability that proves it is legitimate. */
export const UNGUARDED_TASK_COMPLETION = 'UNGUARDED_TASK_COMPLETION';
/** The capability was minted for a different transition identity than the one being written. */
export const COMPLETION_GUARD_IDENTITY_MISMATCH = 'COMPLETION_GUARD_IDENTITY_MISMATCH';

const COMPLETION_GUARD_BRAND: unique symbol = Symbol('propr.completionGuard');

export interface CompletionGuard {
    readonly [COMPLETION_GUARD_BRAND]: true;
    /** Why this completion may be published: the barrier that cleared it, or why none was needed. */
    readonly reason: string;
    /** The durably claimed terminal transition identity, or null for a non-executing completion. */
    readonly transitionId: string | null;
}

function mint(reason: string, transitionId: string | null): CompletionGuard {
    return Object.freeze({ [COMPLETION_GUARD_BRAND]: true as const, reason, transitionId });
}

/**
 * The capability the durability barrier mints once it holds a durably claimed transition identity
 * for this completion. Nothing else may mint it: it is the only way an executed path completes.
 */
export function durableExecutionCompletionGuard(transitionId: string): CompletionGuard {
    if (!transitionId.trim()) throw new Error(`${UNGUARDED_TASK_COMPLETION}: a claimed transition identity is required`);
    return mint('durable-execution-evidence', transitionId);
}

/**
 * The capability a path declares when it publishes a completion that ran no model execution and
 * so has no execution evidence to make durable. The reason is recorded at the call site, which is
 * what the repository-wide rule re-derives rather than trusting a hand-kept list.
 */
export function nonExecutingCompletionGuard(reason: string): CompletionGuard {
    if (!reason.trim()) throw new Error(`${UNGUARDED_TASK_COMPLETION}: a non-executing completion must state its reason`);
    return mint(`non-executing: ${reason}`, null);
}

export function isCompletionGuard(value: unknown): value is CompletionGuard {
    return typeof value === 'object' && value !== null && (value as CompletionGuard)[COMPLETION_GUARD_BRAND] === true;
}

/** Refuses a `completed` transition that carries no capability, or one minted for another key. */
export function assertCompletionGuarded(newState: TaskState, metadata: UpdateMetadata): void {
    if (newState !== TaskStates.COMPLETED) return;
    const guard = metadata.completionGuard;
    if (!isCompletionGuard(guard)) {
        throw new Error(`${UNGUARDED_TASK_COMPLETION}: completed may only be published with a completion capability`);
    }
    if (guard.transitionId !== null && guard.transitionId !== metadata.transitionId) {
        throw new Error(`${COMPLETION_GUARD_IDENTITY_MISMATCH}: the capability was minted for another transition`);
    }
}

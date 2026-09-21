/**
 * The one outcome that must never become a terminal state, in a module with no dependencies.
 *
 * Every generic failure handler on every path that can reach the completion barrier has to
 * recognise this outcome and decline to settle. Keeping it free of imports means a handler can
 * depend on it without dragging the barrier — and the database, the state manager and the agent
 * registry behind it — into its module graph.
 */

/**
 * Whether `completed` is durable is unknown: the history could not be read back, or the
 * transition identity could not be claimed. Nothing terminal may be written on a guess.
 */
export const COMPLETION_DURABILITY_UNVERIFIABLE = 'COMPLETION_DURABILITY_UNVERIFIABLE';

/**
 * A dedicated type rather than a message convention, because the whole point is that generic
 * `catch (error) { markTaskFailed(...) }` handlers recognise it and get out of the way: a
 * completion that may have committed must not be followed by `failed`.
 */
export class CompletionDurabilityUnverifiableError extends Error {
    readonly code = COMPLETION_DURABILITY_UNVERIFIABLE;
    readonly taskId: string;
    constructor(taskId: string, detail: string) {
        super(`${COMPLETION_DURABILITY_UNVERIFIABLE}: ${detail}`);
        this.name = 'CompletionDurabilityUnverifiableError';
        this.taskId = taskId;
    }
}

/**
 * Whether this error means "a completion may be durable and we cannot tell".
 *
 * Recognises the class, and also the code on a cause chain or in the message, so an error that
 * crossed a queue, a serialisation boundary or a wrapping `new Error(...)` — as a BullMQ
 * `failedReason` does — is still handled as unverifiable rather than settled as a failure.
 */
export function isCompletionDurabilityUnverifiable(error: unknown): boolean {
    if (error instanceof CompletionDurabilityUnverifiableError) return true;
    if (typeof error === 'string') return error.includes(COMPLETION_DURABILITY_UNVERIFIABLE);
    if (typeof error !== 'object' || error === null) return false;
    const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === COMPLETION_DURABILITY_UNVERIFIABLE) return true;
    if (typeof candidate.message === 'string' && candidate.message.includes(COMPLETION_DURABILITY_UNVERIFIABLE)) return true;
    return candidate.cause !== undefined && candidate.cause !== error && isCompletionDurabilityUnverifiable(candidate.cause);
}

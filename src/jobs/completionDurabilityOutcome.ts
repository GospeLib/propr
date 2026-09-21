/**
 * The one outcome that must never become a terminal state.
 *
 * Every generic failure handler on every path that can reach the completion barrier has to
 * recognise this outcome and decline to settle: a completion that may have committed must not be
 * followed by `failed`.
 *
 * The definition itself now lives in `@propr/core`, beside the barrier that throws it, because
 * the barrier is shared by the queue jobs here and by the synchronous API routes in
 * `packages/api`, which cannot import this tree. This module stays as the name the handlers in
 * `src/jobs` already import; it adds nothing of its own.
 */
export {
    COMPLETION_DURABILITY_UNVERIFIABLE,
    CompletionDurabilityUnverifiableError,
    isCompletionDurabilityUnverifiable,
} from '@propr/core';

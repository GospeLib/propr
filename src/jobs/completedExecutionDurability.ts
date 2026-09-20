/**
 * The durability barrier on a published `completed`, as the job tree names it.
 *
 * The mechanism itself lives in `@propr/core`
 * (`packages/core/src/utils/durableCompletionBarrier.ts`), beside the state manager and the
 * terminal-transition claim, because the publishers that need it are not all in this tree: the
 * queue jobs here reach it through this module, and the synchronous native-analysis route in
 * `packages/api` — which cannot import `src/` — reaches it directly. A second implementation on
 * the API side would be a second set of rules about when a completion may be published, which is
 * precisely what must not exist.
 *
 * Read that module for the invariant, the read-back and the settlement policy.
 */
export {
    publishCompletedWithDurableExecutionEvidence,
    carriesTerminalExecutionEvidence,
    certifyDurableCompletion,
    isDurableCompletionAbsent,
    COMPLETION_WITHOUT_EXECUTION_EVIDENCE,
    COMPLETION_HISTORY_NOT_DURABLE,
    DURABLE_COMPLETION_ABSENT,
    // Re-exported so a caller that already imports the barrier needs no second import; a failure
    // handler that only needs to RECOGNISE the outcome imports the dependency-free module directly.
    CompletionDurabilityUnverifiableError,
    COMPLETION_DURABILITY_UNVERIFIABLE,
    isCompletionDurabilityUnverifiable,
} from '@propr/core';
export type { DurableCompletionOptions, DurableCompletionResult } from '@propr/core';

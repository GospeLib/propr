/**
 * The completion-boundary exports every `@propr/core` double needs.
 *
 * Publishing `completed` now requires a capability minted against a durably claimed transition
 * identity, so any test that stubs the core barrel has to supply that machinery or the module
 * graph will not even load. The capability functions are the REAL ones — a stub would let an
 * unguarded completion through and the tests would stop proving anything — while the claim is
 * an in-memory double with the property that matters: one logical operation, one identity,
 * stable across however many attempts ask for it.
 */
import {
    durableExecutionCompletionGuard,
    nonExecutingCompletionGuard,
    isCompletionGuard,
    assertCompletionGuarded,
} from '../../packages/core/src/utils/completionGuard.js';
import { createHash } from 'node:crypto';

/**
 * The identity derivation is reproduced rather than imported: the real module opens the database
 * on import, which a suite that never touches the database must not be made to do.
 * `terminalTransitionClaimParity.test.ts` holds this copy to the production one.
 */
export const TERMINAL_OPERATION_IDENTITY_MISSING = 'TERMINAL_OPERATION_IDENTITY_MISSING';

export function terminalTransitionId(taskId: string, state: string, operationId: string): string {
    return `${state}:${createHash('sha256').update(`${taskId}\u0000${state}\u0000${operationId}`).digest('hex')}`;
}

export function durableOperationIdentity(kind: string, durableId: string | number | undefined | null): string {
    const id = typeof durableId === 'number' ? String(durableId) : durableId?.trim();
    if (!id) throw new Error(`${TERMINAL_OPERATION_IDENTITY_MISSING}: ${kind}`);
    return `${kind}:${id}`;
}

/** Identities claimed during a test, so a suite can assert one operation claimed exactly one. */
export const claimedTerminalTransitions: string[] = [];

export const completionCoreExports = {
    durableExecutionCompletionGuard,
    nonExecutingCompletionGuard,
    isCompletionGuard,
    assertCompletionGuarded,
    terminalTransitionId,
    durableOperationIdentity,
    TERMINAL_OPERATION_IDENTITY_MISSING,
    claimTerminalTransition: async (taskId: string, state: string, operationId: string) => {
        const identity = terminalTransitionId(taskId, state, operationId);
        if (!claimedTerminalTransitions.includes(identity)) claimedTerminalTransitions.push(identity);
        return identity;
    },
};

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
import { mock } from 'node:test';
import {
    durableExecutionCompletionGuard,
    nonExecutingCompletionGuard,
    isCompletionGuard,
    assertCompletionGuarded,
} from '../../packages/core/src/utils/completionGuard.js';
import {
    COMPLETION_DURABILITY_UNVERIFIABLE,
    CompletionDurabilityUnverifiableError,
    isCompletionDurabilityUnverifiable,
} from '../../packages/core/src/utils/completionDurabilityOutcome.js';
import { ClaudeResultPhases } from '../../packages/core/src/utils/workerStateManager.types.js';
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

/**
 * The database the REAL durability barrier reads through.
 *
 * The barrier lives in core now — the native-analysis route needs the same one — so it takes its
 * connection from `packages/core/src/db/connection.js` rather than from the `@propr/core` barrel
 * a suite doubles. That module opens a real SQLite connection when it is imported, which a
 * hermetic suite must not do, so it is replaced here and the suite supplies the behaviour it
 * wants through `useCompletionDatabase`. The barrier itself is the production one: a stubbed
 * barrier would decide the very questions these suites exist to ask.
 */
export interface CompletionDatabaseRow { [column: string]: unknown }

/** The in-memory tables the barrier reads and writes, and the failures a suite can inject. */
export const completionDatabase = {
    history: [] as CompletionDatabaseRow[],
    claims: [] as CompletionDatabaseRow[],
    /** The history read-back rejects: whether a completion is durable cannot be established. */
    failReadBack: false,
    /** The identity cannot be claimed, so no terminal state may be written on this attempt. */
    failClaim: false,
    reset(): void {
        completionDatabase.history.length = 0;
        completionDatabase.claims.length = 0;
        completionDatabase.failReadBack = false;
        completionDatabase.failClaim = false;
    },
};

function tableDouble(rows: CompletionDatabaseRow[], options: { unique?: string; failRead?: () => boolean } = {}) {
    let criteria: CompletionDatabaseRow = {};
    const append = (row: CompletionDatabaseRow, ignoreConflict: boolean) => {
        if (completionDatabase.failClaim && options.unique) throw new Error('database refused the transition claim');
        const key = options.unique;
        const existing = key ? rows.find(candidate => candidate[key] === row[key]) : undefined;
        if (existing && !ignoreConflict) throw new Error(`UNIQUE constraint failed on ${key}`);
        if (!existing) rows.push({ ...row });
        return [rows.length];
    };
    const lazy = <T>(run: () => T) => ({
        then: (resolve?: (value: T) => unknown, reject?: (error: unknown) => unknown) =>
            Promise.resolve().then(run).then(resolve, reject),
        catch: (reject?: (error: unknown) => unknown) => Promise.resolve().then(run).catch(reject),
        finally: (settled?: () => void) => Promise.resolve().then(run).finally(settled),
    });
    const query = {
        insert: (row: CompletionDatabaseRow) => Object.assign(lazy(() => append(row, false)), {
            onConflict: () => ({ ignore: () => lazy(() => append(row, true)) }),
        }),
        where: (value: CompletionDatabaseRow) => { criteria = { ...criteria, ...value }; return query; },
        andWhere: () => query,
        whereNull: () => query,
        orderBy: () => query,
        select: () => query,
        update: async () => 1,
        first: async () => {
            if (options.failRead?.()) throw new Error('database refused the history read-back');
            const row = rows.find(candidate => Object.entries(criteria).every(([key, value]) => candidate[key] === value));
            return row ? { ...row } : undefined;
        },
    };
    return query;
}

const defaultDatabase = (table: string) => table === 'task_terminal_transitions'
    ? tableDouble(completionDatabase.claims, { unique: 'transition_id' })
    : tableDouble(completionDatabase.history, { unique: 'transition_id', failRead: () => completionDatabase.failReadBack });

let completionDatabaseDouble: (table: string) => unknown = defaultDatabase;
/** Replaces the whole database double, for a suite that needs a failure the flags do not cover. */
export function useCompletionDatabase(double: (table: string) => unknown): void {
    completionDatabaseDouble = double;
}
try {
    await mock.module('../../packages/core/src/db/connection.js', {
        namedExports: { db: (table: string) => completionDatabaseDouble(table) },
    });
} catch {
    // A suite that installed its own connection double before importing this helper keeps it;
    // what matters is only that the real module — which opens SQLite on import — never loads.
}
const barrier = await import('../../packages/core/src/utils/durableCompletionBarrier.js');

export const completionCoreExports = {
    // The production barrier, reading through whatever database double the suite installed.
    publishCompletedWithDurableExecutionEvidence: barrier.publishCompletedWithDurableExecutionEvidence,
    carriesTerminalExecutionEvidence: barrier.carriesTerminalExecutionEvidence,
    certifyDurableCompletion: barrier.certifyDurableCompletion,
    isDurableCompletionAbsent: barrier.isDurableCompletionAbsent,
    COMPLETION_WITHOUT_EXECUTION_EVIDENCE: barrier.COMPLETION_WITHOUT_EXECUTION_EVIDENCE,
    COMPLETION_HISTORY_NOT_DURABLE: barrier.COMPLETION_HISTORY_NOT_DURABLE,
    DURABLE_COMPLETION_ABSENT: barrier.DURABLE_COMPLETION_ABSENT,
    // Both of these modules are dependency-free, so the REAL ones are safe here — and a stub
    // would let a settled `failed` past the guard whose whole job is to refuse one.
    COMPLETION_DURABILITY_UNVERIFIABLE,
    CompletionDurabilityUnverifiableError,
    isCompletionDurabilityUnverifiable,
    ClaudeResultPhases,
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

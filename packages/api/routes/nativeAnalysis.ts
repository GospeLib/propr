import { randomUUID, createHash } from 'node:crypto';
import {
    getStateManager, runWithExecutionAbortSignal, runWithPlannerAbortContext, TaskStates, SyntheticAgent,
    durableOperationIdentity, publishCompletedWithDurableExecutionEvidence, isCompletionDurabilityUnverifiable,
    terminalTransitionId, certifyDurableCompletion, isDurableCompletionAbsent,
    claimTerminalTransition, durableTerminalTransitionRecorded, COMPLETION_PERSISTENCE_FAILED_SUFFIX,
    acquireExecutionLease, releaseExecutionLease, settleExecutionLease, startExecutionLeaseRenewal,
    markProviderInvocationStarted, retainLeaseForReconciliation,
    type Agent, type AnalyzeOptions, type DurableCommit, type WorkerStateManager,
} from '@propr/core';
import { setAbortSignal } from './plannerAbortHandlers.js';
const CANCELLATION_CHECKPOINT_TIMEOUT_MS = 2_000;
const NATIVE_INPUT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NATIVE_REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const TERMINAL_NATIVE_STATES = new Set<string>([TaskStates.COMPLETED, TaskStates.FAILED, TaskStates.CANCELLED]);
export function nativeAnalysisFailureExecution(error: unknown): Record<string, never> | { execution: Record<string, unknown> } {
    const execution = (error as { execution?: Record<string, unknown> })?.execution;
    return execution === undefined ? {} : { execution };
}

export interface NativeAnalysisBinding {
    responseSchemaDigest?: string;
    requestId: string;
    operationId: string;
    inputDigest: string;
    providerInputDigest: string;
    repository: string;
}
export type NativeAnalysisStateManager = Pick<WorkerStateManager,
    'createTaskState' | 'updateTaskState' | 'updateHistoryMetadata' | 'getTaskState' | 'markTaskFailed'
    | 'projectDurableCompletion'>;

/** The task already holds a terminal state for this admitted operation; it may not run again. */
export const NATIVE_ANALYSIS_OPERATION_SETTLED = 'NATIVE_ANALYSIS_OPERATION_ALREADY_SETTLED';
/** Another live attempt holds the execution lease for this operation; this one does not execute. */
export const NATIVE_ANALYSIS_OPERATION_IN_PROGRESS = 'NATIVE_ANALYSIS_OPERATION_EXECUTION_IN_PROGRESS';
/**
 * An earlier attempt's lease term lapsed and NOTHING has proved that attempt stopped executing.
 *
 * A missed heartbeat is silence, not death: a suspended event loop, a stalled write or a paused
 * container all produce it while the provider keeps running and keeps charging. So this is where
 * the route stops, and it stays stopped until an operator or reconciler records durable proof
 * (`recordExecutorStopProof`) that the named prior generation is gone. Refusing work that could
 * be resumed is a smaller loss than paying twice for work that is still running.
 */
export const NATIVE_ANALYSIS_OPERATION_UNRECONCILED = 'NATIVE_ANALYSIS_OPERATION_EXECUTION_UNRECONCILED';
/**
 * Why a lease was kept although this attempt settled nothing.
 *
 * Written onto the lease row so the operation is distinguishable, weeks later, from one that
 * lapsed without ever reaching the provider: the first may already have been billed and must be
 * reconciled by someone who checks, the second is simply free to retry.
 */
export const PROVIDER_REACHED_WITHOUT_OUTCOME =
    'the provider was invoked and no terminal record of the outcome is durable, so this operation '
    + 'may already have been billed; run `npx tsx scripts/reconcile-execution-lease.ts` and record '
    + 'a verified executor stop before it is allowed to run again';

/**
 * Whether the AUTHORITATIVE history already holds the completion of this operation.
 *
 * Redis is a projection: it can be lost with the process, evicted, or flushed, and consulting it
 * alone is how a durably settled operation got a second paid execution. The durable history is
 * addressed by the deterministic transition identity of this operation, so the evidence is exactly
 * the row the earlier attempt committed — never "some completed row for this task".
 *
 * A read that FAILS is not an absence. It propagates, because "the database would not answer" is
 * not permission to spend money again.
 */
async function operationDurablyCompleted(taskId: string, transitionId: string): Promise<boolean> {
    try {
        await certifyDurableCompletion(taskId, transitionId);
        return true;
    } catch (error) {
        if (isDurableCompletionAbsent(error)) return false;
        throw error;
    }
}

/**
 * The task identity of one admitted native-analysis operation.
 *
 * A random id per request is worthless across the failure it has to survive: the process dies
 * after the completed history row commits, the caller retries the SAME admitted operation, and a
 * fresh id makes a fresh task — and therefore a fresh terminal transition identity — so the
 * completion that is already durable is invisible and the paid work is repeated. Deriving the id
 * from the operation identity instead means the retry addresses the same task, claims the same
 * transition, and the barrier's read-back recognises what already landed.
 */
export function nativeAnalysisTaskId(operationId: string): string {
    return `native-analysis-${createHash('sha256').update(operationId).digest('hex').slice(0, 32)}`;
}
export interface NativeAnalysisDependencies {
    stateManager?: NativeAnalysisStateManager;
    setAbortSignal?: typeof setAbortSignal;
}
function schemaDigest(schema: AnalyzeOptions['responseSchema']): string | undefined {
    if (schema === undefined) return undefined;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object')
        throw new Error('Native analysis response schema must describe an object');
    return `sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`;
}
function validateBinding(binding: NativeAnalysisBinding | undefined, prompt: string,
    responseSchema: AnalyzeOptions['responseSchema']): asserts binding is NativeAnalysisBinding {
    if (!binding) throw new Error('Native analysis execution binding required');
    if (binding && (!binding.requestId || !binding.operationId ||
        !NATIVE_INPUT_DIGEST_PATTERN.test(binding.inputDigest) || !NATIVE_REPOSITORY_PATTERN.test(binding.repository)))
        throw new Error('Invalid native analysis execution binding');
    if (binding && binding.providerInputDigest !== `sha256:${createHash('sha256').update(prompt).digest('hex')}`)
        throw new Error('Invalid native analysis provider input binding');
    if (binding.responseSchemaDigest !== schemaDigest(responseSchema))
        throw new Error('Invalid native analysis response schema binding');
}

/** Reuses ProPR task state and generation-fenced executor ownership, not a second execution store. */
export async function nativeAnalysis(
    agent: Agent, prompt: string,
    request: { options: AnalyzeOptions; signal: AbortSignal; binding?: NativeAnalysisBinding; dependencies?: NativeAnalysisDependencies },
) {
    const { options, signal, binding, dependencies = {} } = request;
    if (agent instanceof SyntheticAgent || agent.config.type !== 'claude')
        throw new Error('Planning artifact profile requires the authenticated Claude CLI executor');
    if (options.context !== undefined) throw new Error('Planning artifact profile does not accept additional context');
    validateBinding(binding, prompt, options.responseSchema);
    const state = dependencies.stateManager ?? getStateManager();
    const requestId = binding.requestId;
    const operationIdentity = durableOperationIdentity('native-analysis', binding.operationId);
    const taskId = nativeAnalysisTaskId(binding.operationId);
    // The attempt generation stays per-attempt on purpose: it fences executor ownership for THIS
    // attempt, which is the opposite of what the task and transition identities are for.
    const attemptGeneration = randomUUID();
    // The lease generation is deliberately NOT the attempt generation. The attempt generation
    // fences the executor (abort markers, planner context) and is read by other machinery on that
    // contract; the lease fences the RIGHT TO RUN, is written to a different durable row, and has
    // to stay meaningful even if the executor fence is ever reused or derived. Two fences, two
    // values, so neither can be widened by a change made for the other.
    const leaseGeneration = randomUUID();
    const [repoOwner, repoName] = binding.repository.split('/');
    const evidence = {
        requestId, taskId, attemptGeneration, leaseGeneration, operationId: binding?.operationId,
        inputDigest: binding?.inputDigest,
        providerInputDigest: `sha256:${createHash('sha256').update(prompt).digest('hex')}`,
        agentId: agent.config.id, agentAlias: agent.config.alias,
        preserveTerminalEvidence: true,
    };
    let childStopped = false;
    let containerStopped = false;
    let observedResponseSchemaDigest: string | undefined;
    const schemaEvidence = () => observedResponseSchemaDigest === undefined ? {} : { responseSchemaDigest: observedResponseSchemaDigest };
    const checkpoint = async (metadata: Record<string, unknown>) => {
        await state.updateHistoryMetadata(taskId, TaskStates.CLAUDE_EXECUTION, metadata, { requireDurableHistory: true });
    };
    let cancellationCheckpoint: Promise<void> | undefined;
    const cancellationCheckpointErrors: string[] = [];
    const requestCancellation = () => {
        if (cancellationCheckpoint) return cancellationCheckpoint;
        const writes = (async () => {
            try {
                await checkpoint({ cancellationRequested: true, abortMarkerRequested: { taskId, attemptGeneration } });
            } catch (error) {
                // Persistence failure cannot prevent the existing ownership stop signal.
                cancellationCheckpointErrors.push((error as Error).message);
            }
            await (dependencies.setAbortSignal ?? setAbortSignal)(taskId, attemptGeneration);
            await checkpoint({ cancellationRequested: true, abortMarker: { taskId, attemptGeneration } });
        })().catch(async error => {
            cancellationCheckpointErrors.push((error as Error).message);
            try { await checkpoint({ cancellationRequested: true, abortMarkerError: (error as Error).message }); }
            catch (persistenceError) { cancellationCheckpointErrors.push((persistenceError as Error).message); }
        });
        cancellationCheckpoint = new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                cancellationCheckpointErrors.push('Cancellation checkpoint unavailable before its bounded deadline');
                resolve();
            }, CANCELLATION_CHECKPOINT_TIMEOUT_MS);
            void writes.then(() => { clearTimeout(timer); resolve(); });
        });
        return cancellationCheckpoint;
    };
    signal.addEventListener('abort', requestCancellation, { once: true });
    if (signal.aborted) requestCancellation();
    // A refusal must not leave the cancellation listener attached to a request that never ran.
    const refusal = (message: string): Error => {
        signal.removeEventListener('abort', requestCancellation);
        return new Error(message);
    };
    // A redelivery of the same admitted operation finds the task that operation already created.
    // One that already settled is refused outright rather than re-executed: repeating the paid run
    // is the loss this identity exists to prevent. It is checked before the settlement handler is
    // in scope, so a refusal can never write anything over the terminal state it just found.
    const existing = await state.getTaskState(taskId);
    if (existing && TERMINAL_NATIVE_STATES.has(existing.state)) {
        throw refusal(`${NATIVE_ANALYSIS_OPERATION_SETTLED}: ${taskId} is already ${existing.state}`);
    }
    // The projection above is NOT what decides whether paid work runs. It can be absent because
    // the process died after the completed row committed, or because Redis lost the key — and
    // then it reads exactly like a fresh operation. So the durable history is asked directly,
    // under this operation's deterministic completed-transition identity.
    const completedTransitionId = terminalTransitionId(taskId, TaskStates.COMPLETED, operationIdentity);
    // Every terminal identity this operation can ever reach, derived — not remembered — so a later
    // question about "did anything terminal land" is asked of exact rows rather than of a flag.
    // The last one is the identity the durability barrier claims when a completion cannot be
    // persisted and the run is settled as failed carrying its evidence: that record is terminal
    // too, and an operation that reached it must not be executed again either.
    const terminalIdentities: readonly (readonly [string, string])[] = [
        [TaskStates.COMPLETED, completedTransitionId],
        [TaskStates.FAILED, terminalTransitionId(taskId, TaskStates.FAILED, operationIdentity)],
        [TaskStates.CANCELLED, terminalTransitionId(taskId, TaskStates.CANCELLED, operationIdentity)],
        [TaskStates.FAILED, terminalTransitionId(taskId, TaskStates.FAILED,
            `${operationIdentity}${COMPLETION_PERSISTENCE_FAILED_SUFFIX}`)],
    ];
    let durablyCompleted: boolean;
    // An unreadable history is not an absence, so it propagates — but not with this request's
    // cancellation listener still attached to a run that never started.
    try { durablyCompleted = await operationDurablyCompleted(taskId, completedTransitionId); }
    catch (error) { signal.removeEventListener('abort', requestCancellation); throw error; }
    if (durablyCompleted) {
        // The evidence is durable; only the projection was lost, so the projection is restored
        // from it rather than the operation being run again. A projection that cannot be caught
        // up changes nothing about the refusal: the history is what a consumer reads.
        try { await state.projectDurableCompletion?.(taskId, { transitionId: completedTransitionId }); }
        catch { /* the durable completion stands whether or not its projection could be restored */ }
        throw refusal(`${NATIVE_ANALYSIS_OPERATION_SETTLED}: ${taskId} is already ${TaskStates.COMPLETED}`);
    }
    // `completed` is not the only settled outcome. Failed and cancelled are settled too — the
    // projection check above refuses both — and that projection is exactly what a dead process or
    // a flushed Redis takes away. Asked of the durable history instead, under the same derived
    // identities, they answer after the projection is gone. An unreadable history is not an
    // absence here either: it propagates rather than buying a second paid run.
    for (const [terminal, transitionId] of terminalIdentities.slice(1)) {
        let settled: boolean;
        try { settled = await durableTerminalTransitionRecorded(taskId, transitionId, terminal); }
        catch (error) { signal.removeEventListener('abort', requestCancellation); throw error; }
        if (settled) throw refusal(`${NATIVE_ANALYSIS_OPERATION_SETTLED}: ${taskId} is already ${terminal}`);
    }
    // Two redeliveries that both pass the checks above are both "not settled yet" and would both
    // pay. The right to execute is therefore taken durably and exclusively, in one atomic
    // statement, before the provider is reachable.
    const acquired = await acquireExecutionLease({
        leaseKey: operationIdentity, taskId, operationId: binding.operationId, generation: leaseGeneration,
    });
    if (acquired.outcome === 'settled') {
        throw refusal(`${NATIVE_ANALYSIS_OPERATION_SETTLED}: ${taskId} settled as ${acquired.settledState}`);
    }
    if (acquired.outcome === 'held') {
        throw refusal(`${NATIVE_ANALYSIS_OPERATION_IN_PROGRESS}: ${taskId} is executing under another attempt`);
    }
    if (acquired.outcome === 'unreconciled') {
        throw refusal(`${NATIVE_ANALYSIS_OPERATION_UNRECONCILED}: ${taskId} held a lease from ${acquired.holderGeneration}`
            + ` whose term lapsed at ${acquired.expiresAt} with no proof that its executor stopped`);
    }
    const lease = acquired.lease;
    let leaseSettled = false;
    // Whether this attempt REACHED the provider. It is the one fact that decides, on the way out,
    // whether an unsettled lease may be handed back: an attempt that never got there spent
    // nothing and a retry is free, while an attempt that got there may already have been billed
    // for work whose outcome it then lost, and releasing that lease buys the same work twice.
    // "I settled nothing" cannot stand in for it — that is true in both cases.
    let providerInvocationStarted = false;
    // A lease this attempt no longer holds is recorded rather than swallowed: the terminal
    // transition identity still stops a second completed row, but losing the fence is the one
    // condition under which another attempt could have started, and that must be visible.
    const leaseFenceErrors: string[] = [];
    /**
     * Settles the lease INSIDE the transaction that writes the terminal history row.
     *
     * Settling afterwards left a window with a shape money can fall through: the terminal state is
     * durable, the lease is not, the process dies, the term lapses and a later attempt reads an
     * operation nothing appears to have settled. One transaction removes the window rather than
     * narrowing it — either both rows are there or neither is.
     *
     * A settlement that affects no row means this attempt was fenced out; that is recorded, not
     * thrown, because throwing would roll back a terminal record that is worth keeping.
     */
    const settleWithTerminalWrite = (terminal: string): DurableCommit => async transaction => {
        leaseSettled = await settleExecutionLease(lease, terminal, transaction);
        if (!leaseSettled) leaseFenceErrors.push(`the execution lease was no longer held at ${terminal}`);
    };
    /** The after-the-fact settlement, for the one path whose terminal write is not ours to join. */
    const settleLease = async (terminal: string) => {
        leaseSettled = await settleExecutionLease(lease, terminal);
        if (!leaseSettled) leaseFenceErrors.push(`the execution lease was no longer held at ${terminal}`);
    };
    const stopLeaseRenewal = startExecutionLeaseRenewal(lease, {
        // A CONFIRMED loss of the fence means another attempt may now be executing this same paid
        // operation. Recording it is not enough — two live executions is exactly the outcome the
        // lease exists to prevent — so this attempt is stopped through the route's own cancellation
        // path, which writes the abort marker the executor is already watching.
        onLost: () => {
            leaseFenceErrors.push('the execution lease was taken over while this attempt was running');
            void requestCancellation();
        },
        onError: error => leaseFenceErrors.push(`the execution lease could not be renewed: ${error.message}`),
    });
    try {
        if (!existing) await state.createTaskState(taskId, {
            number: 0, repoOwner, repoName, type: 'analysis', ...evidence,
            providerInput: { prompt, ...(options.responseSchema === undefined ? {} : { responseSchema: options.responseSchema }),
                ...(options.context === undefined ? {} : { context: options.context }) },
        }, binding?.operationId, { requireDurableHistory: true });
        await state.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { historyMetadata: evidence, requireDurableHistory: true });
        const result = await runWithPlannerAbortContext(taskId, attemptGeneration, () => runWithExecutionAbortSignal(signal, async () => {
            // Set BEFORE the call, and durably too, so a crash inside the provider still leaves
            // the fact behind. A marker written afterwards would be absent for exactly the
            // failures it exists to describe. The durable write failing does not stop the run and
            // does not loosen the rule: the in-process flag already holds this attempt to it, and
            // turning a transient database fault into a permanently unrunnable operation would be
            // a worse answer than recording the fault and carrying on.
            providerInvocationStarted = true;
            try { await markProviderInvocationStarted(lease); }
            catch (error) { leaseFenceErrors.push(`the provider-invocation marker could not be written: ${(error as Error).message}`); }
            return agent.analyze(prompt, {
                ...options, taskId, executionType: 'plan-generation', correlationId: binding?.operationId,
                repository: binding?.repository,
                executionCallbacks: {
                    onInputPrepared: async input => {
                        const observed = schemaDigest(input.responseSchema);
                        if (observed !== binding.responseSchemaDigest) throw new Error('Native CLI response schema binding changed');
                        await checkpoint({ providerCliInput: input,
                            providerCliInputDigest: `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}` });
                        observedResponseSchemaDigest = observed;
                    },
                    onTimeout: requestCancellation,
                    onAbortRequested: requestCancellation,
                    onChildStarted: async child => checkpoint({ child }),
                    onContainerId: async (containerId, containerName) => checkpoint({ containerId, containerName }),
                    onSessionId: async sessionId => checkpoint({ providerSessionId: sessionId }),
                    onTerminal: async terminal => {
                        await checkpoint({ terminal: { ...terminal, messageTimestamps: Object.fromEntries(terminal.messageTimestamps) } });
                        childStopped = terminal.childStopped;
                        containerStopped = terminal.containerCessation === 'stopped';
                    },
                },
            });
        }, attemptGeneration));
        await cancellationCheckpoint;
        let settlementError: string | undefined;
        const terminalState = signal.aborted ? TaskStates.CANCELLED : result.success ? TaskStates.COMPLETED : TaskStates.FAILED;
        let recordedTransitionId: string | undefined;
        const terminalHistoryMetadata = { ...evidence, ...schemaEvidence(), result, childStopped, containerStopped,
            // The terminal outcome a value-only reader needs, beside the raw result.
            agentOutcome: { success: result.success, executionTimeMs: result.executionTimeMs },
            cancellationAcknowledged: signal.aborted, cancellationCheckpointErrors: [...cancellationCheckpointErrors],
            ...(leaseFenceErrors.length === 0 ? {} : { leaseFenceErrors: [...leaseFenceErrors] }) };
        try {
            // This route runs a model execution and publishes its own `completed`, so it goes
            // through the same durability barrier as the queued paths — the same claimed
            // identity, the same strict write, and the same exact read-back of THAT identity
            // when the write is ambiguous. A parallel settlement here would be a second set of
            // rules about when a completion may be published: it was one, and it reported a
            // committed completion as unrecorded, which is how the paid work got repeated.
            if (terminalState === TaskStates.COMPLETED) {
                const completion = await publishCompletedWithDurableExecutionEvidence({
                    stateManager: state, taskId, operationId: operationIdentity,
                    // The settlement rides INTO the barrier's own history transaction, so the
                    // published completion and the settled lease commit together.
                    metadata: { requireDurableHistory: true, historyMetadata: terminalHistoryMetadata,
                        durableCommit: settleWithTerminalWrite(TaskStates.COMPLETED) },
                });
                recordedTransitionId = completion.transitionId;
                if (completion.outcome === 'settled_failed') {
                    settlementError = 'the completed history could not be persisted; the run was settled as failed with its evidence';
                }
                // Either outcome is a DURABLE settlement of this operation — a published
                // completion or a failed record carrying the same evidence — so the lease is
                // settled and no later attempt may ever pay for this operation again. The
                // settled-as-failed record is written by the barrier under its OWN identity and
                // its own transaction, which this attempt cannot join, so that one settlement is
                // made after the fact; it is also the one case the release rule below has to
                // recognise, which is why that rule reads the history rather than a flag.
                if (!leaseSettled) await settleLease(completion.outcome === 'published' ? TaskStates.COMPLETED : TaskStates.FAILED);
            } else {
                recordedTransitionId = await claimTerminalTransition(taskId, terminalState, operationIdentity);
                await state.updateTaskState(taskId, terminalState,
                    { requireDurableHistory: true, transitionId: recordedTransitionId,
                        historyMetadata: terminalHistoryMetadata,
                        durableCommit: settleWithTerminalWrite(terminalState) });
            }
        } catch (error) {
            settlementError = (error as Error).message;
        }
        // Execution already returned: bookkeeping failure is not a second model
        // outcome. Preserve its paid response, but explicitly refuse a settled receipt.
        return { ...result, execution: { ...evidence, ...schemaEvidence(), childStopped, containerStopped,
            terminalRecorded: settlementError === undefined,
            ...(leaseFenceErrors.length === 0 ? {} : { leaseFenceErrors: [...leaseFenceErrors] }),
            ...(recordedTransitionId === undefined ? {} : { terminalTransitionId: recordedTransitionId }),
            ...(settlementError === undefined ? {} : { settlementError }),
            // Durability could not be established either way: a caller must NOT treat this as
            // "nothing landed" and repeat the operation. Re-running it reaches the same task and
            // the same transition identity, which is what makes that recoverable.
            ...(settlementError !== undefined && isCompletionDurabilityUnverifiable(settlementError)
                ? { completionDurabilityUnverifiable: true } : {}) } };
    } catch (error) {
        await cancellationCheckpoint;
        let settlementError: string | undefined;
        const terminalState = signal.aborted ? TaskStates.CANCELLED : TaskStates.FAILED;
        try {
            // The same rule as the success path: the terminal record and the settlement of the
            // right to run are one transaction, because a failed or cancelled operation is
            // settled and must not be executed again either.
            await state.updateTaskState(taskId, terminalState, {
                requireDurableHistory: true,
                transitionId: await claimTerminalTransition(taskId, terminalState, operationIdentity),
                historyMetadata: { ...evidence, childStopped, containerStopped, cancellationAcknowledged: signal.aborted,
                    cancellationCheckpointErrors: [...cancellationCheckpointErrors],
                    ...(leaseFenceErrors.length === 0 ? {} : { leaseFenceErrors: [...leaseFenceErrors] }) },
                error: { message: (error as Error).message },
                durableCommit: settleWithTerminalWrite(terminalState),
            });
        } catch (failure) { settlementError = (failure as Error).message; }
        throw Object.assign(new Error((error as Error).message, { cause: error }), {
            execution: { ...evidence, childStopped, containerStopped,
                ...(settlementError === undefined ? {} : { settlementError }) },
        });
    } finally {
        signal.removeEventListener('abort', requestCancellation);
        stopLeaseRenewal();
        // Handing the lease back is the ONE route from "this operation was not settled" to "this
        // operation may run again", and it is now the only one: an expired term grants nothing.
        // So it is given only on evidence, never on the absence of a flag — and the evidence has
        // to answer the money question, not merely the bookkeeping one.
        if (!leaseSettled) {
            // The first question is not "did anything land" but "was anything SPENT". An attempt
            // that reached the provider may already have been billed for work whose outcome it
            // then lost, and no amount of absent history distinguishes that from an attempt that
            // was never charged. Proving the executor stopped prevents two executions overlapping;
            // it does not prove no money changed hands. So this attempt keeps its lease and says
            // why, and the operation goes to deliberate reconciliation instead of being made
            // immediately payable again.
            // A `return` here would swallow this function's own outcome, so the two cases are
            // written as branches rather than an early exit.
            if (providerInvocationStarted) {
                try { await retainLeaseForReconciliation(lease, PROVIDER_REACHED_WITHOUT_OUTCOME); }
                catch { /* the lease is retained by NOT releasing it; the note is the extra */ }
            } else {
                // Nothing reached the provider, so a retry is free. The history is still asked
                // whether ANY terminal identity of this operation became durable — including the
                // one the barrier claims when it settles an unrecordable completion as failed —
                // and only a confirmed absence releases. A write that failed is not an absence,
                // and an unreadable history says nothing at all.
                let nothingTerminalIsDurable = false;
                try {
                    const recorded = await Promise.all(terminalIdentities
                        .map(([terminal, transitionId]) => durableTerminalTransitionRecorded(taskId, transitionId, terminal)));
                    nothingTerminalIsDurable = recorded.every(found => !found);
                } catch { nothingTerminalIsDurable = false; }
                if (nothingTerminalIsDurable) {
                    try { await releaseExecutionLease(lease); } catch { /* it stays until it is reconciled */ }
                }
            }
        }
    }
}

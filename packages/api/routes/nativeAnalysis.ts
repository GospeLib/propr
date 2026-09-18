import { randomUUID, createHash } from 'node:crypto';
import {
    getStateManager, runWithExecutionAbortSignal, runWithPlannerAbortContext, TaskStates,
    type Agent, type AnalyzeOptions, type WorkerStateManager,
} from '@propr/core';
import { setAbortSignal } from './plannerAbortHandlers.js';
const CANCELLATION_CHECKPOINT_TIMEOUT_MS = 2_000;
const NATIVE_INPUT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NATIVE_REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
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
    'createTaskState' | 'updateTaskState' | 'updateHistoryMetadata'>;
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
    if (agent.config.type !== 'claude') throw new Error('Planning artifact profile requires the authenticated Claude CLI executor');
    if (options.context !== undefined) throw new Error('Planning artifact profile does not accept additional context');
    validateBinding(binding, prompt, options.responseSchema);
    const state = dependencies.stateManager ?? getStateManager();
    const requestId = binding.requestId;
    const taskId = randomUUID();
    const attemptGeneration = randomUUID();
    const [repoOwner, repoName] = binding.repository.split('/');
    const evidence = {
        requestId, taskId, attemptGeneration, operationId: binding?.operationId,
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
    try {
        await state.createTaskState(taskId, {
            number: 0, repoOwner, repoName, type: 'analysis', ...evidence,
            providerInput: { prompt, ...(options.responseSchema === undefined ? {} : { responseSchema: options.responseSchema }),
                ...(options.context === undefined ? {} : { context: options.context }) },
        }, binding?.operationId, { requireDurableHistory: true });
        await state.updateTaskState(taskId, TaskStates.CLAUDE_EXECUTION, { historyMetadata: evidence, requireDurableHistory: true });
        const result = await runWithPlannerAbortContext(taskId, attemptGeneration, () => runWithExecutionAbortSignal(signal, () => agent.analyze(prompt, {
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
        }), attemptGeneration));
        await cancellationCheckpoint;
        let settlementError: string | undefined;
        try { await state.updateTaskState(taskId,
            signal.aborted ? TaskStates.CANCELLED : result.success ? TaskStates.COMPLETED : TaskStates.FAILED,
            { requireDurableHistory: true, historyMetadata: { ...evidence, ...schemaEvidence(), result, childStopped, containerStopped,
                cancellationAcknowledged: signal.aborted, cancellationCheckpointErrors: [...cancellationCheckpointErrors] } });
        } catch (error) { settlementError = (error as Error).message; }
        // Execution already returned: bookkeeping failure is not a second model
        // outcome. Preserve its paid response, but explicitly refuse a settled receipt.
        return { ...result, execution: { ...evidence, ...schemaEvidence(), childStopped, containerStopped,
            terminalRecorded: settlementError === undefined,
            ...(settlementError === undefined ? {} : { settlementError }) } };
    } catch (error) {
        await cancellationCheckpoint;
        let settlementError: string | undefined;
        try { await state.updateTaskState(taskId, signal.aborted ? TaskStates.CANCELLED : TaskStates.FAILED, {
            requireDurableHistory: true,
            historyMetadata: { ...evidence, childStopped, containerStopped, cancellationAcknowledged: signal.aborted,
                cancellationCheckpointErrors: [...cancellationCheckpointErrors] },
            error: { message: (error as Error).message },
        }); } catch (failure) { settlementError = (failure as Error).message; }
        throw Object.assign(new Error((error as Error).message, { cause: error }), {
            execution: { ...evidence, childStopped, containerStopped,
                ...(settlementError === undefined ? {} : { settlementError }) },
        });
    } finally {
        signal.removeEventListener('abort', requestCancellation);
    }
}

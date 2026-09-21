import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Request, Response } from 'express';
import { closeConnection, executeDockerCommand, getAgentRegistry, type Agent, type AnalyzeOptions } from '@propr/core';
import { createAgentRoutes } from '../routes/index.js';
import { nativeAnalysis } from '../routes/nativeAnalysis.js';

const CHILD_DELAY_MS = 500;
const DISCONNECT_DELAY_MS = 100;
const CHILD_TIMEOUT_MS = 2_000;
const NATIVE_TIMEOUT_MS = 50;
const NATIVE_SLOW_COMPLETION_MS = 150;
// One admitted operation may be executed once, so every scenario admits its own.
const executionBinding = (prompt: string) => ({ requestId: 'request', operationId: `operation-${randomUUID()}`,
    inputDigest: `sha256:${'a'.repeat(64)}`, repository: 'owner/repo',
    providerInputDigest: `sha256:${createHash('sha256').update(prompt).digest('hex')}` });

test('native disconnect during awaited agent resolution cannot start paid authoring', async () => {
    const registry = getAgentRegistry();
    const originalInitialize = registry.ensureInitialized;
    const originalGet = registry.getAgentById;
    const originalAlias = registry.getAgentByAlias;
    const originalRefresh = registry.refresh;
    let resolutionEntered!: () => void;
    let releaseResolution!: () => void;
    const entered = new Promise<void>(resolve => { resolutionEntered = resolve; });
    const released = new Promise<void>(resolve => { releaseResolution = resolve; });
    let ready = false;
    let authored = 0;
    const agent = { config: { type: 'claude', alias: 'slow-resolution' }, async analyze() {
        authored += 1;
        return { success: true, response: 'unwanted paid result', modelUsed: 'fixture' };
    } } as unknown as Agent;
    registry.ensureInitialized = async () => undefined;
    registry.getAgentById = () => ready ? agent : undefined;
    registry.getAgentByAlias = () => undefined;
    registry.refresh = async () => { resolutionEntered(); await released; ready = true; };
    const req = Object.assign(new EventEmitter(), { body: { queries: [{ agentId: 'slow-resolution',
        analysisProfile: 'planning-artifact', execution: executionBinding('input') }], prompt: 'input' } }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
        json() { throw Error('no disconnected publication'); }, status() { return res; } }) as unknown as Response;
    try {
        const stateManager = { async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() {}, async updateTaskState() {}, async updateHistoryMetadata() {} };
        const route = createAgentRoutes({ stateManager: stateManager as never }).router.stack.find(layer => layer.route?.path === '/chat')!.route!;
        const pending = route.stack[0].handle(req, res, () => undefined);
        await entered;
        res.destroyed = true;
        res.emit('close');
        releaseResolution();
        await pending;
        assert.equal(authored, 0, 'disconnect while resolving must be rechecked before admission/paid call');
    } finally {
        registry.ensureInitialized = originalInitialize;
        registry.getAgentById = originalGet;
        registry.getAgentByAlias = originalAlias;
        registry.refresh = originalRefresh;
    }
});

test('native profile requires a verified binding before admission', async () => {
    let admitted = false;
    const agent = { config: { type: 'claude' }, analyze: async () => ({ success: true, response: '', modelUsed: 'fixture' }) } as unknown as Agent;
    await assert.rejects(nativeAnalysis(agent, 'fixture', { options: { analysisProfile: 'planning-artifact' },
        signal: new AbortController().signal, dependencies: { stateManager: {
            async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() { admitted = true; }, async updateTaskState() {}, async updateHistoryMetadata() {},
        } as never },
    }), /execution binding required/);
    assert.equal(admitted, false);
});

test('failed native admission settles the projection and preserves its execution identity', async () => {
    const states: string[] = [];
    await assert.rejects(nativeAnalysis({ config: { type: 'claude' },
        analyze: async () => { throw new Error('must not author'); } } as unknown as Agent, 'input', {
        options: { analysisProfile: 'planning-artifact' }, signal: new AbortController().signal,
        binding: executionBinding('input'), dependencies: { stateManager: {
            async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() { throw new Error('Admission history unavailable'); },
            async updateTaskState(_taskId, state) { states.push(state); },
            async updateHistoryMetadata() {},
        } },
    }), (error: Error & { execution?: { taskId?: string } }) => {
        assert.match(error.message, /Admission history unavailable/);
        assert.ok(error.execution?.taskId);
        assert.deepEqual(states, ['failed']);
        return true;
    });
});

test('final settlement failure preserves the paid result without recasting execution as failed', async () => {
    const states: string[] = [];
    const failures: Error[] = [];
    const agent = { config: { type: 'claude', id: 'fixture', alias: 'fixture' },
        analyze: async () => ({ success: true, response: 'valid paid response', modelUsed: 'fixture' }) } as unknown as Agent;
    const result = await nativeAnalysis(agent, 'fixture', { options: { analysisProfile: 'planning-artifact' },
        binding: executionBinding('fixture'), signal: new AbortController().signal, dependencies: { stateManager: {
            async getTaskState() { return null; }, async createTaskState() {}, async updateHistoryMetadata() {},
            async markTaskFailed(_id: string, error: Error) { failures.push(error); return {}; },
            async projectDurableCompletion() { return 'projected'; },
            async updateTaskState(_id: string, state: string) {
                states.push(state);
                if (state === 'completed') throw new Error('Final history unavailable');
                if (state === 'failed') throw new Error('Fallback history unavailable');
            },
        } as never },
    });
    assert.equal(result.response, 'valid paid response');
    assert.equal(result.success, true);
    assert.equal(result.execution.terminalRecorded, false, 'the caller is told its completion was not recorded');
    // The shared barrier owns what happens next, and it is not "throw the run away": a completion
    // whose row is confirmed absent is settled as a durable `failed` record carrying the same
    // execution evidence, so it can be neither read as a delivered success nor re-dispatched as
    // an unrun task. That policy is the queue paths' policy — this route no longer has its own.
    assert.match(result.execution.settlementError ?? '', /settled as failed with its evidence/);
    assert.equal(failures.length, 1);
    assert.match(failures[0].message, /COMPLETION_HISTORY_NOT_DURABLE.*Final history unavailable/);
    assert.ok(result.execution.taskId);
    assert.deepEqual(states, ['claude_execution', 'completed', 'completed', 'completed'],
        'the barrier retries a confirmed-absent write before it settles anything');
});
test('native binding rejects altered prompt bytes before admission or authoring', async () => {
    let admitted = false;
    let authored = false;
    const agent = { config: { type: 'claude', id: 'fixture', alias: 'fixture' },
        analyze: async () => { authored = true; return { success: true, response: 'fixture', modelUsed: 'fixture' }; } } as unknown as Agent;
    await assert.rejects(nativeAnalysis(agent, 'altered prompt', { options: { analysisProfile: 'planning-artifact' },
        signal: new AbortController().signal, binding: {
            requestId: 'request', operationId: `operation-${randomUUID()}`, inputDigest: `sha256:${'a'.repeat(64)}`,
            repository: 'owner/repo', providerInputDigest: `sha256:${'b'.repeat(64)}`,
        }, dependencies: { stateManager: {
            async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() { admitted = true; }, async updateTaskState() {}, async updateHistoryMetadata() {},
        } as never },
    }), /provider input binding/);
    assert.equal(admitted, false);
    assert.equal(authored, false);
});
after(async () => closeConnection());

test('native planning rejects unbound optional context before admission or authoring', async () => {
    let admitted = false;
    let authored = false;
    const agent = { config: { type: 'claude' }, analyze: async () => {
        authored = true; return { success: true, response: 'paid', modelUsed: 'fixture' };
    } } as unknown as Agent;
    await assert.rejects(nativeAnalysis(agent, 'bound prompt', {
        options: { analysisProfile: 'planning-artifact', context: 'unbound additional input' },
        binding: executionBinding('bound prompt'), signal: new AbortController().signal,
        dependencies: { stateManager: { async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() { admitted = true; },
            async updateTaskState() {}, async updateHistoryMetadata() {} } as never },
    }), /does not accept additional context/);
    assert.equal(admitted, false);
    assert.equal(authored, false);
});

test('native chat disconnect stops its exact executor child and rejects late publication', async () => {
    const registry = getAgentRegistry();
    const originalInitialize = registry.ensureInitialized;
    const originalGet = registry.getAgentById;
    let childStopped = false;
    let lateOutput = false;
    const history: Array<Record<string, unknown>> = [];
    let abortMarker = false;
    const stateManager = {
        async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() {},
        async updateTaskState(_taskId: string, _state: string, metadata: { historyMetadata: Record<string, unknown> }) { history.push(metadata.historyMetadata); },
        async updateHistoryMetadata(_taskId: string, _state: string, metadata: Record<string, unknown>) { history.push(metadata); },
    };
    const agent = {
        config: { alias: 'cancellation-fixture', type: 'claude', defaultModel: 'fixture' },
        async analyze(_prompt: string, options?: AnalyzeOptions) {
            try {
                const result = await executeDockerCommand(process.execPath, [
                    '-e', `setTimeout(() => process.stdout.write('late-output'), ${CHILD_DELAY_MS})`,
                ], { timeout: CHILD_TIMEOUT_MS, ...options?.executionCallbacks });
                lateOutput = result.stdout.includes('late-output');
                return { success: true, response: result.stdout, modelUsed: 'fixture' };
            } catch {
                childStopped = true;
                return { success: false, response: '', error: 'cancelled', modelUsed: 'fixture' };
            }
        },
    } as unknown as Agent;
    registry.ensureInitialized = async () => undefined;
    registry.getAgentById = () => agent;
    const request = Object.assign(new EventEmitter(), {
        body: { queries: [{ agentId: 'cancellation-fixture', analysisProfile: 'planning-artifact', execution: executionBinding('complete unchanged input') }], prompt: 'complete unchanged input' },
    }) as unknown as Request;
    let published = false;
    const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        json() { published = true; },
        status() { return response; },
    }) as unknown as Response;
    try {
        const { router } = createAgentRoutes({ stateManager: stateManager as never, setAbortSignal: async () => { abortMarker = true; } });
        const route = router.stack.find(layer => layer.route?.path === '/chat')!.route!;
        const pending = route.stack[0].handle(request, response, () => undefined);
        await delay(DISCONNECT_DELAY_MS);
        response.destroyed = true;
        response.emit('close');
        await pending;
        assert.equal(childStopped, true, 'disconnect must reach existing executor ownership cancellation');
        assert.equal(lateOutput, false, 'cancelled child must not emit its delayed output');
        assert.equal(published, false, 'disconnected request must not publish a late result');
        assert.equal(abortMarker, true, 'disconnect must write the supported generation-specific abort marker');
        assert.ok(history.some(entry => entry.child), 'the actual executor child must be checkpointed');
        assert.ok(history.some(entry => entry.terminal), 'complete terminal evidence must be retained before task settlement');
        assert.ok(history.some(entry => entry.childStopped === true && entry.containerStopped === false),
            'CLI termination must not claim unobserved Docker container cessation');
    } finally {
        registry.ensureInitialized = originalInitialize;
        registry.getAgentById = originalGet;
    }
});

async function exerciseNativeAnalysis(
    analyze: Agent['analyze'],
    stateManager: Record<string, unknown>,
    setAbortSignal: () => Promise<void>,
    disconnect = false,
) {
    const registry = getAgentRegistry();
    const originalInitialize = registry.ensureInitialized;
    const originalGet = registry.getAgentById;
    registry.ensureInitialized = async () => undefined;
    registry.getAgentById = () => ({
        config: { alias: 'native-durability-fixture', type: 'claude', defaultModel: 'fixture' }, analyze,
    }) as unknown as Agent;
    const request = Object.assign(new EventEmitter(), {
        body: { queries: [{ agentId: 'native-durability-fixture', analysisProfile: 'planning-artifact', execution: executionBinding('unchanged owner input') }], prompt: 'unchanged owner input' },
    }) as unknown as Request;
    let publication: unknown;
    const response = Object.assign(new EventEmitter(), {
        writableEnded: false, destroyed: false,
        json(value: unknown) { publication = value; }, status() { return response; },
    }) as unknown as Response;
    const route = createAgentRoutes({ stateManager: stateManager as never, setAbortSignal }).router.stack
        .find(layer => layer.route?.path === '/chat')!.route!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const pending = route.stack[0].handle(request, response, () => undefined);
        if (disconnect) timer = setTimeout(() => { response.destroyed = true; response.emit('close'); }, NATIVE_TIMEOUT_MS);
        await pending;
        return publication;
    } finally {
        if (timer) clearTimeout(timer);
        registry.ensureInitialized = originalInitialize;
        registry.getAgentById = originalGet;
    }
}

test('legacy chat keeps its existing executor lifetime when its client disconnects', async () => {
    const registry = getAgentRegistry();
    const originalInitialize = registry.ensureInitialized;
    const originalGet = registry.getAgentById;
    let completed = false;
    registry.ensureInitialized = async () => undefined;
    registry.getAgentById = () => ({ config: { type: 'claude', alias: 'legacy' }, async analyze() {
        await executeDockerCommand(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("done"), 100)']);
        completed = true;
        return { success: true, response: 'done', modelUsed: 'fixture' };
    } }) as unknown as Agent;
    const req = Object.assign(new EventEmitter(), { body: { queries: [{ agentId: 'legacy' }], prompt: 'input' } }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
        json() { throw Error('must not publish to disconnected client'); }, status() { return res; } }) as unknown as Response;
    try {
        const route = createAgentRoutes().router.stack.find(layer => layer.route?.path === '/chat')!.route!;
        const pending = route.stack[0].handle(req, res, () => undefined);
        await delay(25);
        res.destroyed = true;
        res.emit('close');
        await pending;
        assert.equal(completed, true);
    } finally { registry.ensureInitialized = originalInitialize; registry.getAgentById = originalGet; }
});

test('native timeout writes its exact abort marker before child cessation', async () => {
    let childPid = 0;
    let markerWhileChildAlive = false;
    const checkpointed: Record<string, unknown>[] = [];
    let markerAfterDurableIntent = false;
    const stateManager = { async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() {}, async updateTaskState() {},
        async updateHistoryMetadata(_taskId: string, _state: string, metadata: Record<string, unknown>) { checkpointed.push(metadata); } };
    await exerciseNativeAnalysis(async (_prompt, options) => {
        const result = await executeDockerCommand(process.execPath,
            ['-e', `setTimeout(() => process.stdout.write('late'), ${CHILD_DELAY_MS})`], {
                timeout: NATIVE_TIMEOUT_MS, preserveOutputOnTimeout: true,
                ...options?.executionCallbacks,
                async onChildStarted(child) {
                    childPid = child.pid;
                    await options?.executionCallbacks?.onChildStarted?.(child);
                },
            });
        return { success: !result.timedOut, response: result.stdout, modelUsed: 'fixture' };
    }, stateManager, async () => {
        markerAfterDurableIntent = checkpointed.some(entry => entry.cancellationRequested === true && entry.abortMarkerRequested);
        try { process.kill(childPid, 0); markerWhileChildAlive = true; } catch { /* already stopped */ }
    });
    assert.equal(markerWhileChildAlive, true, 'a marker written only after terminal child close cannot cause cancellation');
    assert.equal(markerAfterDurableIntent, true, 'durable cancellation intent must precede Redis checker visibility');
});

test('native analysis requires durable history for admission and execution checkpoints', async () => {
    const required: boolean[] = [];
    const stateManager = {
        async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState(_task: string, _issue: unknown, _correlation: unknown, policy?: { requireDurableHistory?: boolean }) {
            required.push(policy?.requireDurableHistory === true);
        },
        async updateTaskState(_task: string, _state: string, metadata?: { requireDurableHistory?: boolean }) {
            required.push(metadata?.requireDurableHistory === true);
        },
        async updateHistoryMetadata() {},
    };
    await exerciseNativeAnalysis(async () => ({ success: true, response: '{}', modelUsed: 'fixture' }), stateManager, async () => {});
    assert.ok(required.length >= 2);
    assert.ok(required.every(Boolean), 'native execution cannot silently depend on expiring Redis when database history failed');
});

test('disconnect checkpoint failures are handled immediately and retained at settlement', async () => {
    const settlements: Array<Record<string, unknown>> = [];
    const stateManager = {
        async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() {},
        async updateTaskState(_task: string, _state: string, metadata: { historyMetadata: Record<string, unknown> }) {
            settlements.push(metadata.historyMetadata);
        },
        async updateHistoryMetadata() { throw Error('history unavailable'); },
    };
    await exerciseNativeAnalysis(async () => {
        await delay(NATIVE_SLOW_COMPLETION_MS);
        return { success: true, response: '{}', modelUsed: 'fixture' };
    }, stateManager, async () => { throw Error('abort marker unavailable'); }, true);
    assert.ok(settlements.some(entry => Array.isArray(entry.cancellationCheckpointErrors)),
        'both failed writes must be handled while the provider remains pending, then retained as explicit evidence');
});

test('planning-artifact profile applies bounded semantic controls without truncating its input', async () => {
    const registry = getAgentRegistry();
    const originalInitialize = registry.ensureInitialized;
    const originalGet = registry.getAgentById;
    let received: AnalyzeOptions | undefined;
    let input: string | undefined;
    const prompt = 'all 17 requirements and every existing story path remain verbatim';
    const checkpoints: string[] = [];
    const stateManager = {
        async getTaskState() { return null; }, async markTaskFailed() { return {}; }, async createTaskState() { checkpoints.push('created'); },
        async updateTaskState() { checkpoints.push('state'); },
        async updateHistoryMetadata() { checkpoints.push('metadata'); },
    };
    registry.ensureInitialized = async () => undefined;
    registry.getAgentById = () => ({
        config: { alias: 'profile-fixture', type: 'claude', defaultModel: 'fixture' },
        async analyze(value: string, options?: AnalyzeOptions) {
            input = value;
            received = options;
            return { success: true, response: '{}', modelUsed: 'fixture' };
        },
    }) as unknown as Agent;
    const request = Object.assign(new EventEmitter(), {
        body: { queries: [{ agentId: 'profile-fixture', analysisProfile: 'planning-artifact', execution: executionBinding(prompt) }], prompt },
    }) as unknown as Request;
    const response = Object.assign(new EventEmitter(), {
        writableEnded: false, destroyed: false, json() {}, status() { return response; },
    }) as unknown as Response;
    try {
        const route = (createAgentRoutes as (...args: unknown[]) => ReturnType<typeof createAgentRoutes>)({ stateManager }).router.stack.find(layer => layer.route?.path === '/chat')!.route!;
        await route.stack[0].handle(request, response, () => undefined);
        assert.equal(received?.reasoningLevel, 'low');
        assert.equal(received?.responseFormat, 'json');
        assert.ok(received?.timeoutMs && received.timeoutMs < 600_000);
        assert.equal(input, prompt);
        assert.equal(checkpoints[0], 'created', 'provider attempt must have a durable task before execution');
    } finally {
        registry.ensureInitialized = originalInitialize;
        registry.getAgentById = originalGet;
    }
});

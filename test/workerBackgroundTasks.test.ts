import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { readFile } from 'node:fs/promises';

// The retained-checkpoint reconciler only bounds disk if production actually runs it:
// assert the worker startup call site, and that the background-task bundle starts and
// stops the reconciler alongside task-state recovery.

const calls: string[] = [];
const stateManager = { marker: 'state-manager' };

await mock.module('../src/workerTaskStateRecovery.js', {
    namedExports: {
        startWorkerTaskStateRecovery: mock.fn(async (options: unknown) => {
            calls.push('recovery:start');
            assert.equal((options as { stateManager: unknown }).stateManager, stateManager);
            return { runOnce: async () => true, close: async () => { calls.push('recovery:close'); } };
        }),
    },
});
await mock.module('../src/jobs/checkpointRetentionReconciler.js', {
    namedExports: {
        startCheckpointRetentionReconciler: mock.fn((options: unknown) => {
            calls.push('checkpoint-retention:start');
            assert.equal((options as { stateManager: unknown }).stateManager, stateManager);
            return { runOnce: async () => undefined, close: async () => { calls.push('checkpoint-retention:close'); } };
        }),
    },
});

const { startWorkerBackgroundTasks } = await import('../src/workerBackgroundTasks.js');

test('worker background tasks start and stop the retained-checkpoint reconciler', async () => {
    const tasks = await startWorkerBackgroundTasks({ stateManager: stateManager as never });
    assert.deepEqual(calls, ['recovery:start', 'checkpoint-retention:start']);
    await tasks.close();
    assert.deepEqual(calls.slice(2), ['checkpoint-retention:close', 'recovery:close']);
});

test('production worker startup runs the background tasks and closes them on shutdown', async () => {
    const source = await readFile(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const startWorker = source.slice(source.indexOf('async function startWorker('));
    assert.match(startWorker, /const backgroundTasks = await startWorkerBackgroundTasks\(\{ stateManager \}\);/);
    assert.match(startWorker, /await backgroundTasks\.close\(\);/);
});

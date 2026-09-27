import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishWorkerAgentHealth } from '../src/workerAgentHealth.js';

const missing = 'propr/agent:bundle-331acabaa4d7-ef8b1e';
const fallback = 'propr/agent:bundle-331acabaa4d7-1ab927';

test('unavailable pauses consumption, fallback resumes while degraded, exact recovery clears degradation', async () => {
    let paused = false;
    let payload: any;
    const worker = {
        isPaused: () => paused,
        pause: async () => { paused = true; },
        resume: () => { paused = false; },
    };
    const redis = {
        set: async (_key: string, value: string) => { payload = JSON.parse(value); },
        sadd: async () => 1,
        expire: async () => 1,
    };
    const options = { workerId: 'worker:test', worker, redis };
    await publishWorkerAgentHealth({ ...options, image: { status: 'unavailable', imageTag: missing, error: 'BuildKit unavailable' } });
    assert.equal(paused, true);
    assert.equal(payload.status, 'degraded');
    assert.equal(payload.canExecute, false);
    assert.equal(payload.unifiedAgentImage.imageTag, missing);
    await publishWorkerAgentHealth({ ...options, image: { status: 'degraded', imageTag: missing, fallbackImage: fallback } });
    assert.equal(paused, false);
    assert.equal(payload.status, 'degraded');
    assert.equal(payload.canExecute, true);
    await publishWorkerAgentHealth({ ...options, image: { status: 'ready' } });
    assert.equal(payload.status, 'running');
    assert.equal(payload.unifiedAgentImage.imageTag, undefined);
});

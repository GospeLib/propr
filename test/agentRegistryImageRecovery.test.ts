import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

const missing = 'propr/agent:bundle-331acabaa4d7-ef8b1e';
const fallback = 'propr/agent:bundle-331acabaa4d7-1ab927';
let attempts = 0;
let recovered = false;
let useFallback = false;
await mock.module('../packages/core/src/agents/agentImagePreparation.js', {
    namedExports: {
        resolveInstalledAgentImages: async () => ({ images: new Map() }),
        resolveUnifiedAgentImage: async () => ({ imageTag: missing, error: 'Unavailable' }),
        resolveDefaultAgentConfig: async () => {
            attempts++;
            const config: AgentConfig = { id: 'default', alias: 'default', type: 'claude', enabled: true,
                dockerImage: recovered ? missing : fallback, configPath: '/unused', supportedModels: [] };
            if (recovered) return { config, imageTag: missing };
            return { ...(useFallback ? { config, fallbackImage: fallback } : {}), imageTag: missing, error: 'BuildKit unavailable' };
        },
    },
});
const { AgentRegistry } = await import('../packages/core/src/agents/AgentRegistry.js');
const { runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
after(async () => { await AgentRegistry.resetInstance(); await closeConnection(); });

test('registry retries on bounded exponential backoff, retains fallback degradation, and clears it on exact recovery', async context => {
    await runMigrations();
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const registry = AgentRegistry.getInstance();
    await registry.prepareImagesAndRefresh();
    assert.equal(registry.isInitialized(), true);
    assert.equal(registry.getAllAgents().length, 0);
    assert.equal(registry.getOperationalStatus().unifiedAgentImage.status, 'unavailable');
    const delays = [60_000, 120_000, 240_000, 300_000, 300_000];
    for (const delay of delays) {
        const before = attempts;
        await registry.ensureInitialized();
        assert.equal(attempts, before, 'request path must not bypass backoff');
        context.mock.timers.tick(delay - 1);
        await registry.waitForPendingRefresh();
        assert.equal(attempts, before);
        context.mock.timers.tick(1);
        await registry.waitForPendingRefresh();
        assert.equal(attempts, before + 1);
    }
    useFallback = true;
    context.mock.timers.tick(300_000);
    await registry.waitForPendingRefresh();
    assert.equal(registry.getDefaultAgent()?.config.dockerImage, fallback);
    assert.equal(registry.getOperationalStatus().unifiedAgentImage.status, 'degraded');
    recovered = true;
    context.mock.timers.tick(300_000);
    await registry.waitForPendingRefresh();
    assert.equal(registry.getDefaultAgent()?.config.dockerImage, missing);
    assert.deepEqual(registry.getOperationalStatus(), { unifiedAgentImage: { status: 'ready' } });
    const before = attempts;
    context.mock.timers.tick(600_000);
    await registry.waitForPendingRefresh();
    assert.equal(attempts, before, 'recovery cancels retries');
});

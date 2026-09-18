import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

const directory = mkdtempSync(join(tmpdir(), 'propr-overlay-persistence-'));
process.env.DATA_DIR = directory;
const built = new Set<string>();
const docker = await import('../packages/core/src/claude/docker/dockerExecutor.js');
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
  namedExports: { ...docker, executeDockerCommand: async (_command: string, args: string[]) => {
    let stdout = '', exitCode = 0;
    if (args[0] === 'build') { built.add(args[args.indexOf('-t') + 1]); await new Promise(resolve => setImmediate(resolve)); }
    else if (args[0] === 'run') stdout = 'apt\nPRETTY_NAME="Fixture Debian"';
    else if (args.includes('--format')) stdout = `sha256:${args[2]}\t"node"`;
    else if (args[2]?.startsWith('propr/runtime-')) exitCode = built.has(args[2]) ? 0 : 1;
    return { exitCode, stdout, stderr: '' };
  } },
});
const store = await import('../packages/core/src/config/configStore.js');
let staleReaders = 0;
let releaseReaders: () => void;
const simultaneousRead = new Promise<void>(resolve => { releaseReaders = resolve; });
await mock.module('../packages/core/src/config/configStore.js', {
  namedExports: { ...store, getConfig: async (...args: Parameters<typeof store.getConfig>) => {
    const value = await store.getConfig(...args);
    // Force the real resolver's two read-modify-write saves to see the same
    // SQLite snapshot if the registry starts both builds concurrently.
    if (args[0] === 'agent_runtime_packages' && built.size === 2 &&
        Object.keys((value as { images: object }).images).length === 0) {
      if (++staleReaders === 2) releaseReaders();
      await simultaneousRead;
    }
    return value;
  } },
});
const { AgentRegistry } = await import('../packages/core/src/agents/AgentRegistry.js');
const { runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { saveAgents, saveSettings } = await import('../packages/core/src/config/configManager.js');
const { saveAgentRuntimePackageState, loadAgentRuntimePackageState } = await import('../packages/core/src/agents/runtime/agentRuntimePackages.js');
after(async () => { await closeConnection(); rmSync(directory, { recursive: true, force: true }); });

test('both installed image overlays remain in actual SQLite state and survive inspect-only refresh', { timeout: 10_000 }, async () => {
  await runMigrations();
  const configs: AgentConfig[] = ['claude', 'codex'].map(type => ({ id: type, alias: type,
    type: type as AgentConfig['type'], enabled: true, dockerImage: `fixture/${type}:local`,
    configPath: `/unused/${type}`, supportedModels: [] }));
  await saveAgents(configs);
  await saveSettings({ default_agent_alias: null });
  await saveAgentRuntimePackageState({ installationId: 'fixture', packages: ['jq'], activePackages: ['jq'],
    status: 'ready', images: {}, updatedAt: new Date().toISOString() });
  const registry = AgentRegistry.getInstance();
  await registry.prepareImagesAndRefresh();
  const state = await loadAgentRuntimePackageState();
  assert.deepEqual(Object.keys(state.images).sort(), configs.map(config => config.dockerImage).sort());
  await registry.refresh();
  for (const config of configs) assert.equal(registry.getAgentByAlias(config.alias)?.config.dockerImage,
    state.images[config.dockerImage].image, 'inspect-only refresh must not silently revert to the bare base image');
});

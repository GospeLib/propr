import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig } from '../packages/core/src/agents/types.js';

const dataDirectory = mkdtempSync(join(tmpdir(), 'propr-installed-images-'));
process.env.DATA_DIR = dataDirectory;
const docker = await import('../packages/core/src/claude/docker/dockerExecutor.js');
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
  namedExports: { ...docker, executeDockerCommand: async () => ({ exitCode: 0, stdout: 'installed', stderr: '' }) },
});
const runtime = await import('../packages/core/src/agents/runtime/agentRuntimePackages.js');
const resolutions: Array<{ image: string; buildMissing?: boolean }> = [];
let resolutionFailure = false;
await mock.module('../packages/core/src/agents/runtime/agentRuntimePackages.js', {
  namedExports: { ...runtime, resolveAgentRuntimeImage: async (image: string, options: { buildMissing?: boolean }) => {
    resolutions.push({ image, ...options });
    if (resolutionFailure) throw new Error('Runtime package fixture failed');
    return `${image}-runtime`;
  } },
});
const imagePreparation = await import('../packages/core/src/agents/agentImagePreparation.js');
let defaultResolutions = 0;
await mock.module('../packages/core/src/agents/agentImagePreparation.js', {
  namedExports: { ...imagePreparation, resolveDefaultAgentConfig: async () => {
    defaultResolutions += 1;
    return { config: { id: 'default', alias: 'default', type: 'claude', enabled: true,
      dockerImage: 'fixture/default:available', configPath: '/unused/default', supportedModels: [] } };
  } },
});
const { AgentRegistry } = await import('../packages/core/src/agents/AgentRegistry.js');
const { runMigrations, closeConnection } = await import('../packages/core/src/db/connection.js');
const { saveAgents, saveSettings } = await import('../packages/core/src/config/configManager.js');
const configs: AgentConfig[] = ['claude', 'codex'].map(type => ({ id: type, alias: type,
  type: type as AgentConfig['type'], enabled: true, dockerImage: `fixture/${type}:local`,
  configPath: `/unused/${type}`, supportedModels: [], defaultModel: undefined }));
before(runMigrations);
after(async () => { await closeConnection(); rmSync(dataDirectory, { recursive: true, force: true }); });

test('installed per-agent images retain distinct runtime overlays and refresh preparation policy', async () => {
  await saveAgents(configs);
  await saveSettings({ default_agent_alias: null });
  const registry = AgentRegistry.getInstance();
  let bundleBuilds = 0;
  const internal = registry as unknown as {
    ensureUnifiedAgentImage: () => Promise<null>;
  };
  internal.ensureUnifiedAgentImage = async () => { bundleBuilds += 1; return null; };
  await registry.refresh();
  await registry.prepareImagesAndRefresh();
  assert.deepEqual(resolutions, [false, true].flatMap(buildMissing => configs.map(config => ({ image: config.dockerImage, buildMissing }))));
  assert.equal(bundleBuilds, 0);
  for (const config of configs) assert.equal(registry.getAgentByAlias(config.alias)?.config.dockerImage, `${config.dockerImage}-runtime`);

  const prior = registry.getAgentByAlias('claude');
  resolutionFailure = true;
  await registry.prepareImagesAndRefresh();
  assert.equal(registry.getAgentByAlias('claude'), prior, 'failed replacement resolution must not clear the live registry');
  assert.equal(defaultResolutions, 0, 'failed configured image must not substitute environment credentials');
});

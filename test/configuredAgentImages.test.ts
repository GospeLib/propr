import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configuredAgentImages, isManagedBundleImage } from '../packages/core/src/agents/configuredAgentImages.js';

test('preserves distinct installed Claude and Codex images without a bundle build', async () => {
  const configs = [
    { id: 'claude', enabled: true, dockerImage: 'claude-native:local' },
    { id: 'codex', enabled: true, dockerImage: 'codex-existing:local' },
  ];
  assert.deepEqual(await configuredAgentImages(configs, async () => true), new Map([
    ['claude', 'claude-native:local'], ['codex', 'codex-existing:local'],
  ]));
});
test('uses existing bundle fallback when an enabled image is unavailable', async () => {
  assert.equal(await configuredAgentImages([{ id: 'codex', enabled: true, dockerImage: 'missing' }], async () => false), undefined);
});

test('configuration migration preserves operator-selected images and migrates only managed bundles', () => {
  assert.equal(isManagedBundleImage('gospelib/propr-agent:ezb-p1-03-native'), false);
  assert.equal(isManagedBundleImage('propr/agent:latest'), false);
  assert.equal(isManagedBundleImage('propr/agent:bundle-old'), true);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getDefaultAgentCliVersionMatrix, generateAgentBundleImageTag } from '../packages/core/src/agents/version/versionService.js';

test('deployed versions and tag stay fixed across process restarts and mutable context files', () => {
    const directory = mkdtempSync(join(tmpdir(), 'propr-pinned-bundle-'));
    const versions = { ...getDefaultAgentCliVersionMatrix(), codex: '0.152.0' };
    const expected = generateAgentBundleImageTag(versions, 'ef8b1e');
    const metadata = { versions, contentHash: 'ef8b1e', tag: expected.split(':')[1], repository: 'propr/agent' };
    const code = `import {getDefaultAgentCliVersionMatrix,computeContentHash,generateAgentBundleImageTag} from './packages/core/src/agents/version/versionService.ts';
console.log('PINNED=' + generateAgentBundleImageTag(getDefaultAgentCliVersionMatrix(),computeContentHash()));`;
    try {
        for (const content of ['old content', 'new content after restart']) {
            writeFileSync(join(directory, 'Dockerfile.agent'), content);
            const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
                encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', PROPR_ROOT: directory, PROPR_AGENT_BUNDLE_METADATA: JSON.stringify(metadata) },
            });
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, new RegExp(`PINNED=${expected}`));
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { buildDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';

const testRoot = mkdtempSync(path.join(tmpdir(), 'propr-claude-home-'));

after(() => rmSync(testRoot, { recursive: true, force: true }));

test('mounts the Claude config directory as the writable worker home', () => {
  const configHome = path.join(testRoot, 'home');
  mkdirSync(configHome);
  writeFileSync(path.join(configHome, '.claude.json'), '{}\n');
  const config: AgentConfig = {
    id: 'claude',
    type: 'claude',
    alias: 'claude',
    enabled: true,
    dockerImage: 'propr/agent:test',
    configPath: testRoot,
    supportedModels: ['claude-opus-5'],
    envVars: {},
  };

  const args = buildDockerArgs(config, 100, {
    worktreePath: '/tmp/worktree',
    githubToken: 'token',
    issueNumber: 2260,
  });

  assert.ok(args.includes(`${configHome}:/home/node/runtime-home:rw`));
  assert.ok(args.includes('HOME=/home/node/runtime-home'));
  assert.ok(args.includes(`${testRoot}:/home/node/.claude:rw`));
  assert.ok(!args.some(argument => argument.endsWith(':/home/node/.claude.json:rw')));
});

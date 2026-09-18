import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { closeConnection, PLANNING_ARTIFACT_MAX_OUTPUT_TOKENS } from '../packages/core/src/index.js';

import { buildDockerArgs } from '../packages/core/src/agents/impl/utils/dockerArgsBuilder.ts';
import type { AgentConfig } from '../packages/core/src/agents/types.ts';

const testRoot = mkdtempSync(path.join(tmpdir(), 'propr-claude-home-'));

after(async () => {
  await closeConnection();
  rmSync(testRoot, { recursive: true, force: true });
});

test('planning artifact environment admits no provider routing or repository credentials', () => {
  const config: AgentConfig = {
    id: 'claude', type: 'claude', alias: 'claude', enabled: true,
    dockerImage: 'propr/agent:test', configPath: testRoot, supportedModels: ['claude-opus-5'],
    envVars: Object.fromEntries(['GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
      'AWS_ACCESS_KEY_ID', 'GOOGLE_APPLICATION_CREDENTIALS', 'CUSTOM_SECRET']
      .map(name => [name, 'fake-review-fixture'])),
  };
  const args = buildDockerArgs(config, 100, {
    worktreePath: '/tmp/worktree', githubToken: 'fake-repository-credential', issueNumber: 0,
    analysisProfile: 'planning-artifact', environment: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9', ANTHROPIC_API_KEY: 'fake' },
    responseSchema: { type: 'object', required: ['artifacts'] },
  });
  assert.ok(!args.some(argument => argument.includes('fake')));
  const observedPlanningOutputTokens = 21_778;
  const observedModelOutputLimit = 64_000;
  assert.ok(PLANNING_ARTIFACT_MAX_OUTPUT_TOKENS > observedPlanningOutputTokens,
    'a single structured response must fit the observed planning output without text continuation');
  assert.ok(PLANNING_ARTIFACT_MAX_OUTPUT_TOKENS <= observedModelOutputLimit);
  assert.ok(args.includes(`CLAUDE_CODE_MAX_OUTPUT_TOKENS=${PLANNING_ARTIFACT_MAX_OUTPUT_TOKENS}`));
  assert.ok(args.includes('/tmp/worktree:/home/node/workspace:ro'));
  assert.ok(args.includes(`${testRoot}:/home/node/.claude:rw`));
  assert.ok(args.includes('PROPR_REPO_SETUP=0'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(args[args.indexOf('--json-schema') + 1], JSON.stringify({ type: 'object', required: ['artifacts'] }));
});

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
  assert.ok(args.includes(`${testRoot}:/home/node/runtime-home/.claude:rw`));
  assert.ok(args.includes('PROPR_CLAUDE_HOME=/home/node/runtime-home'));
  assert.ok(args.includes(`${testRoot}:/home/node/.claude:rw`));
  assert.ok(!args.some(argument => argument.endsWith(':/home/node/.claude.json:rw')));
  assert.ok(!args.some(argument => argument.startsWith('CLAUDE_CODE_MAX_OUTPUT_TOKENS=')));
});

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createContainerExecutionId } from '../packages/core/src/agents/impl/utils/containerExecutionId.js';
import { buildCodexDockerArgs } from '../packages/core/src/agents/impl/utils/codexDockerArgsBuilder.js';
import { wrapDockerRunArgsWithRepoSetup } from '../packages/core/src/claude/docker/repoSetupWrapper.js';
import { closeConnection } from '../packages/core/src/db/connection.js';
import {
  DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS,
  resolveContextAnalysisTimeoutMs,
} from '../packages/core/src/services/relevance/contextAnalysisConfig.js';

after(async () => {
  await closeConnection();
});

describe('context analysis runtime safeguards', () => {
  test('rejects skills seeding without both isolated mounts and for a different agent', () => {
    const image = 'propr/agent:test';
    assert.throws(() => wrapDockerRunArgsWithRepoSetup(['run', image, 'codex'], image, 'codex', true), /read-only source and execution-local tmpfs/);
    assert.throws(() => wrapDockerRunArgsWithRepoSetup(['run', image, 'claude'], image, 'claude', true), /Only Codex/);
  });

  test('seeds every Codex skill into an execution-local Linux mount without changing config or security', () => {
    const configPath = '/tmp/codex-config';
    const skillsPath = '/home/node/.codex/skills';
    const skillsTmpfsOptions = `${skillsPath}:rw,exec,nosuid,nodev,size=64m`;
    const skillsSourcePath = '/tmp/propr-codex-skills-source';
    const config = {
      id: 'codex-test', type: 'codex' as const, alias: 'codex', enabled: true,
      dockerImage: 'propr/agent:test', configPath, supportedModels: ['gpt-5.6-sol'],
    };
    const args = buildCodexDockerArgs(config, {
      worktreePath: '/tmp/review-worktree', githubToken: '', issueNumber: 0,
      executionType: 'pr-review', modelName: 'gpt-5.6-sol', readOnlyWorkspace: true,
    });
    assert.ok(args.includes(`type=bind,source=${configPath}/skills,target=${skillsSourcePath},readonly`));
    assert.ok(args.some((value, index) => args[index - 1] === '--tmpfs' && value === skillsTmpfsOptions));
    assert.ok(args.includes(`${configPath}:/home/node/.codex:rw`));
    assert.ok(args.includes('/tmp/review-worktree:/home/node/workspace:ro'));
    assert.ok(args.includes('no-new-privileges'));
    assert.ok(args.includes('features.multi_agent=false'));
    assert.ok(!args.includes('--ignore-rules'));
    assert.ok(!args.includes('--ignore-user-config'));
    assert.ok(!args.some((value) => /skills.*enabled=false|plugins=false/.test(value)));
    const imageIndex = args.indexOf(config.dockerImage);
    const wrapper = args[imageIndex + 2];
    assert.match(wrapper, /cp -a/);
    assert.ok(wrapper.indexOf('cp -a') < wrapper.indexOf('exec "$entrypoint" "$@"'));
  });

  test('creates distinct fallback container IDs for parallel calls in the same millisecond', (t) => {
    t.mock.method(Date, 'now', () => 1_785_825_895_919);

    const first = createContainerExecutionId();
    const second = createContainerExecutionId();

    assert.notStrictEqual(first, second);
    assert.match(first, /^[a-z0-9]+-[a-f0-9]{8}$/);
    assert.match(second, /^[a-z0-9]+-[a-f0-9]{8}$/);
  });

  test('keeps the task suffix while making every task-backed execution unique', () => {
    const first = createContainerExecutionId('first-command-79edfa5d');
    const second = createContainerExecutionId('second-command-79edfa5d');

    assert.notStrictEqual(first, second);
    assert.match(first, /^79edfa5d-[a-f0-9]{8}$/);
    assert.match(second, /^79edfa5d-[a-f0-9]{8}$/);
  });

  test('gives repeated Codex review attempts distinct Docker names', () => {
    const config = {
      id: 'codex-test',
      type: 'codex' as const,
      alias: 'codex',
      enabled: true,
      dockerImage: 'propr/agent:test',
      configPath: '/tmp/codex-config',
      supportedModels: ['gpt-5.6-sol'],
    };
    const params = {
      worktreePath: '/tmp/review-worktree',
      githubToken: '',
      issueNumber: 0,
      taskId: 'pr-comments-batch-integry-mcptest-268-006379edfa5d',
      executionType: 'pr-review',
      readOnlyWorkspace: true,
    };

    const firstArgs = buildCodexDockerArgs(config, params);
    const secondArgs = buildCodexDockerArgs(config, params);
    const boundedArgs = buildCodexDockerArgs(config, { ...params, disableOptionalStorybookMcp: true });
    assert.ok(boundedArgs.includes('mcp_servers.storybook.enabled=false'));
    assert.ok(!firstArgs.includes('mcp_servers.storybook.enabled=false'));
    assert.ok(!boundedArgs.includes('--ignore-rules'));
    assert.ok(!boundedArgs.includes('--ignore-user-config'));
    const firstName = firstArgs[firstArgs.indexOf('--name') + 1];
    const secondName = secondArgs[secondArgs.indexOf('--name') + 1];

    assert.match(firstName, /^codex-pr-review-79edfa5d-[a-f0-9]{8}$/);
    assert.match(secondName, /^codex-pr-review-79edfa5d-[a-f0-9]{8}$/);
    assert.notStrictEqual(firstName, secondName);
  });

  test('defaults context analysis to thirty minutes', () => {
    assert.strictEqual(DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS, 1_800_000);
    assert.strictEqual(resolveContextAnalysisTimeoutMs(undefined), 1_800_000);
  });

  test('accepts a positive timeout override and rejects invalid values', () => {
    assert.strictEqual(resolveContextAnalysisTimeoutMs('7200000'), 7_200_000);
    assert.strictEqual(resolveContextAnalysisTimeoutMs('0'), DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS);
    assert.strictEqual(resolveContextAnalysisTimeoutMs('not-a-number'), DEFAULT_CONTEXT_ANALYSIS_TIMEOUT_MS);
  });
});

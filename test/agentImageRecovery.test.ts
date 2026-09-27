import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const commands: string[][] = [];
let available = false;
let tags: string[] = [];
let inspected: object[] = [];
await mock.module('../packages/core/src/claude/docker/dockerExecutor.js', {
    namedExports: { executeDockerCommand: async (_command: string, args: string[]) => {
        commands.push(args);
        if (args[0] === 'images') return { exitCode: 0, stdout: available ? 'sha256:present' : '' };
        if (args[0] === 'pull') return { exitCode: 1, stdout: '', stderr: 'not found' };
        if (args[0] === 'buildx') return { exitCode: 1, stdout: '', stderr: 'buildx unavailable' };
        if (args[1] === 'ls') return { exitCode: 0, stdout: tags.join('\n') };
        if (args[1] === 'inspect') return { exitCode: 0, stdout: JSON.stringify(inspected) };
        throw new Error(`Unexpected Docker call ${args.join(' ')}`);
    } },
});
const { ensureAgentBundleImage } = await import('../packages/core/src/claude/docker/dockerImageBuilder.js');
const { findLocalBundleFallback } = await import('../packages/core/src/agents/localBundleFallback.js');
const { getDefaultAgentCliVersionMatrix, generateAgentBundleImageTag } = await import('../packages/core/src/agents/version/versionService.js');
const versions = getDefaultAgentCliVersionMatrix();
const missing = generateAgentBundleImageTag(versions, 'ef8b1e');

test('missing BuildKit fails fast without a build; an installed image needs no build capability', async () => {
    const result = await ensureAgentBundleImage(versions, 'ef8b1e');
    assert.equal(result.success, false);
    assert.match(result.error!, /BuildKit\/buildx is required/);
    assert.equal(commands.some(args => args.includes('build')), false);
    available = true;
    commands.length = 0;
    assert.equal((await ensureAgentBundleImage(versions, 'ef8b1e')).success, true);
    assert.deepEqual(commands.map(args => args[0]), ['images']);
});

test('fallback selects newest created local image only from the exact CLI family', async () => {
    const older = generateAgentBundleImageTag(versions, '1ab927');
    const newer = generateAgentBundleImageTag(versions, 'aaaaaa');
    const unrelated = 'propr/agent:bundle-aaaaaaaaaaaa-bbbbbb';
    tags = [older, newer, unrelated, 'propr/agent:latest'];
    inspected = [
        { Created: '2026-09-25T00:00:00Z', RepoTags: [older] },
        { Created: '2026-09-26T00:00:00Z', RepoTags: [newer] },
        { Created: '2026-09-27T00:00:00Z', RepoTags: [unrelated] },
    ];
    assert.equal(await findLocalBundleFallback(missing), newer);
    tags = [unrelated];
    assert.equal(await findLocalBundleFallback(missing), undefined);
    assert.equal(await findLocalBundleFallback('custom/image:latest'), undefined);
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    assertConfinedWorkerEnvironment,
    assertConfinedWorkerMounts,
    buildAgentContainerResourceArgs,
    buildAssignedWorktreeMountArgs,
    buildConfinedWorkerCapabilityArgs,
    buildConfinedWorkerCapsuleArgs,
    classifyConfinementRefusal,
    classifyEnvironmentRefusal,
    isWorkerConfinementRefusal,
    parseDockerMountArgs,
    resolveAssignedWorktreeGitDir,
    resolveDefaultAgentCpuLimit,
} from '../packages/core/src/agents/agentContainerResources.js';

describe('agent container resource policy', () => {
    test('caps the automatic CPU default at detected host capacity', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({}, 2), [
            '--memory', '6g',
            '--memory-swap', '6g',
            '--cpus', '2',
            '--pids-limit', '512',
        ]);
        assert.equal(resolveDefaultAgentCpuLimit(16), '4');
        assert.equal(resolveDefaultAgentCpuLimit(1), '1');
    });

    test('uses a conservative CPU fallback when detection is invalid', () => {
        assert.equal(resolveDefaultAgentCpuLimit(0), '1');
        assert.equal(resolveDefaultAgentCpuLimit(Number.NaN), '1');
    });

    test('accepts explicit operator overrides', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({
            AGENT_CONTAINER_MEMORY_LIMIT: ' 12G ',
            AGENT_CONTAINER_CPU_LIMIT: '1.5',
            AGENT_CONTAINER_PIDS_LIMIT: '1024',
        }), [
            '--memory', '12g',
            '--memory-swap', '12g',
            '--cpus', '1.5',
            '--pids-limit', '1024',
        ]);
    });

    test('enforces Docker\'s minimum memory limit', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({ AGENT_CONTAINER_MEMORY_LIMIT: '6m' }, 4), [
            '--memory', '6m',
            '--memory-swap', '6m',
            '--cpus', '4',
            '--pids-limit', '512',
        ]);
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_MEMORY_LIMIT: '5m' }),
            /AGENT_CONTAINER_MEMORY_LIMIT/
        );
    });

    test('enforces Docker\'s minimum effective CPU quota', () => {
        assert.deepEqual(buildAgentContainerResourceArgs({ AGENT_CONTAINER_CPU_LIMIT: '0.01' }), [
            '--memory', '6g',
            '--memory-swap', '6g',
            '--cpus', '0.01',
            '--pids-limit', '512',
        ]);
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_CPU_LIMIT: '0.009' }),
            /AGENT_CONTAINER_CPU_LIMIT/
        );
    });

    test('rejects malformed or unbounded values before invoking Docker', () => {
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_MEMORY_LIMIT: '0' }),
            /AGENT_CONTAINER_MEMORY_LIMIT/
        );
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_CPU_LIMIT: 'all' }),
            /AGENT_CONTAINER_CPU_LIMIT/
        );
        assert.throws(
            () => buildAgentContainerResourceArgs({ AGENT_CONTAINER_PIDS_LIMIT: '-1' }),
            /AGENT_CONTAINER_PIDS_LIMIT/
        );
    });
});

describe('confined worker runtime policy', () => {
    const ASSIGNED = '/tmp/git-processor/worktrees/GospeLib-propr-issue-7';

    test('names each locked path escape rather than failing generically', () => {
        assert.equal(classifyConfinementRefusal('/tmp/git-processor/clones/GospeLib/propr', ASSIGNED), 'primary-checkout');
        assert.equal(classifyConfinementRefusal('/tmp/git-processor/worktrees/another-unit', ASSIGNED), 'unrelated-worktree');
        assert.equal(classifyConfinementRefusal('/usr/src/app/data/propr.sqlite', ASSIGNED), 'controller-state');
        assert.equal(classifyConfinementRefusal('/run/propr/ezer-admission.json', ASSIGNED), 'attestation-store');
        assert.equal(classifyConfinementRefusal('/tmp/git-processor/propr-cache/transcripts', ASSIGNED), 'authoritative-evidence');
        assert.equal(classifyConfinementRefusal('/var/run/docker.sock', ASSIGNED), 'container-control-socket');
        assert.equal(classifyConfinementRefusal('/home/runner/.aws', ASSIGNED), 'out-of-scope-credential');
    });

    test('leaves the assigned worktree and the agent cache unclassified', () => {
        assert.equal(classifyConfinementRefusal(ASSIGNED, ASSIGNED), null);
        assert.equal(classifyConfinementRefusal(`${ASSIGNED}/src/index.ts`, ASSIGNED), null);
        assert.equal(classifyConfinementRefusal('/tmp/git-processor/propr-cache/claude', ASSIGNED), null);
    });

    test('refuses a mutating mount by name before the argument vector is used', () => {
        const args = ['run', '-v', '/tmp/git-processor:/tmp/git-processor:rw', 'image'];
        assert.throws(
            () => assertConfinedWorkerMounts(args, { worktreePath: ASSIGNED, mutating: true }),
            (error: Error) => isWorkerConfinementRefusal(error, 'primary-checkout')
                || isWorkerConfinementRefusal(error, 'unrelated-worktree'),
        );
        assert.doesNotThrow(() => assertConfinedWorkerMounts(
            ['run', '-v', `${ASSIGNED}:/home/node/workspace:rw`, 'image'],
            { worktreePath: ASSIGNED, mutating: true },
        ));
    });

    test('keeps read-only analysis of a checkout working while refusing to write it', () => {
        const readOnly = ['run', '-v', '/tmp/git-processor/clones/GospeLib/propr:/scout:ro', 'image'];
        assert.doesNotThrow(() => assertConfinedWorkerMounts(readOnly, { mutating: false }));
        assert.throws(
            () => assertConfinedWorkerMounts(readOnly, { mutating: true }),
            (error: Error) => isWorkerConfinementRefusal(error, 'primary-checkout'),
        );
        assert.throws(
            () => assertConfinedWorkerMounts(
                ['run', '-v', '/tmp/git-processor/clones/GospeLib/propr:/scout:rw', 'image'],
                { mutating: false },
            ),
            (error: Error) => isWorkerConfinementRefusal(error, 'primary-checkout'),
        );
    });

    test('separates the shared object store a linked worktree needs from the primary working tree', () => {
        const clone = '/tmp/git-processor/clones/GospeLib/propr';
        const args = [
            'run',
            '-v', `${ASSIGNED}:/home/node/workspace:rw`,
            '-v', `${clone}/.git:${clone}/.git:rw`,
            'image',
        ];
        // A linked worktree cannot function without the clone's `.git`, so it
        // travels; the checked-out files beside it never do.
        assert.doesNotThrow(() => assertConfinedWorkerMounts(args, {
            worktreePath: ASSIGNED,
            sharedGitDirPath: `${clone}/.git`,
            mutating: true,
        }), 'shared git storage for the assigned worktree must stay usable');

        for (const refused of [clone, `${clone}/src`]) {
            assert.throws(
                () => assertConfinedWorkerMounts(
                    ['run', '-v', `${refused}:/mnt/x:rw`, 'image'],
                    { worktreePath: ASSIGNED, sharedGitDirPath: `${clone}/.git`, mutating: true },
                ),
                (error: Error) => isWorkerConfinementRefusal(error, 'primary-checkout'),
                refused,
            );
        }
    });

    test('names stage credentials and protected-state imports in forwarded environment', () => {
        assert.equal(classifyEnvironmentRefusal('NPM_TOKEN'), 'stage-credential');
        assert.equal(classifyEnvironmentRefusal('PROPR_STAGE_DEPLOY_KEY'), 'stage-credential');
        assert.equal(classifyEnvironmentRefusal('AWS_SECRET_ACCESS_KEY'), 'stage-credential');
        assert.equal(classifyEnvironmentRefusal('PROPR_EZER_ADMISSION_MARKER_B64'), 'protected-state-import');
        // The credentials a worker legitimately needs stay forwardable.
        assert.equal(classifyEnvironmentRefusal('GH_TOKEN'), null);
        assert.equal(classifyEnvironmentRefusal('ANTHROPIC_API_KEY'), null);
        assert.equal(classifyEnvironmentRefusal('MISTRAL_API_KEY'), null);

        assert.throws(
            () => assertConfinedWorkerEnvironment([{ NPM_TOKEN: 'npm_x' }]),
            (error: Error) => isWorkerConfinementRefusal(error, 'stage-credential'),
        );
        assert.doesNotThrow(() => assertConfinedWorkerEnvironment([{ GH_TOKEN: 'gh_x' }, undefined]));
    });

    test('resolves the assigned worktree to the shared git storage it actually needs', () => {
        const gitDir = resolveAssignedWorktreeGitDir(
            ASSIGNED,
            () => 'gitdir: /tmp/git-processor/clones/GospeLib/propr/.git/worktrees/unit-7\n',
        );
        assert.equal(gitDir, '/tmp/git-processor/clones/GospeLib/propr/.git');
        assert.equal(resolveAssignedWorktreeGitDir(ASSIGNED, () => { throw new Error('missing'); }), null);
    });

    test('builds explicit mounts instead of the blanket git-processor mount', () => {
        const args = buildAssignedWorktreeMountArgs({
            worktreePath: ASSIGNED,
            agentType: 'claude',
            resolveGitDir: () => '/tmp/git-processor/clones/GospeLib/propr/.git',
        });
        assert.deepEqual(args, [
            '-v', '/tmp/git-processor/clones/GospeLib/propr/.git:/tmp/git-processor/clones/GospeLib/propr/.git:rw',
            '-v', '/tmp/git-processor/propr-cache/claude:/tmp/git-processor/propr-cache/claude:rw',
        ]);
        assert.ok(!args.includes('/tmp/git-processor:/tmp/git-processor:rw'));
        // The clone's own working tree never travels with the worktree.
        assert.ok(!args.some(argument => argument.includes('/propr:/tmp/git-processor/clones')));
    });

    test('drops the ambient capability set and seals the capsule', () => {
        const capabilities = buildConfinedWorkerCapabilityArgs();
        assert.deepEqual(capabilities.slice(0, 2), ['--cap-drop', 'ALL']);
        assert.ok(!capabilities.includes('SYS_ADMIN'));
        assert.ok(!capabilities.includes('NET_RAW'));

        const capsule = buildConfinedWorkerCapsuleArgs();
        assert.ok(capsule.includes('--read-only'));
        assert.ok(capsule.includes('/tmp:rw,mode=1777'));
        assert.ok(capsule.includes('/run:rw,mode=1777'));
    });

    test('parses only real host bind mounts out of an argument vector', () => {
        assert.deepEqual(
            parseDockerMountArgs(['run', '-v', '/host:/container:ro', '-e', 'X=/not:a:mount', 'image']),
            [{ hostPath: '/host', containerPath: '/container', mode: 'ro' }],
        );
        assert.deepEqual(parseDockerMountArgs(['run', '-v', 'named-volume:/container', 'image']), []);
    });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
    assertConfinedWorkerEnvironment,
    assertConfinedWorkerMounts,
    assertConfinedWorkerRuntimeArgs,
    buildAgentContainerResourceArgs,
    buildAssignedWorktreeMountArgs,
    buildConfinedWorkerCapabilityArgs,
    buildConfinedWorkerCapsuleArgs,
    classifyConfinementRefusal,
    classifyEnvironmentRefusal,
    isWorkerConfinementRefusal,
    parseDockerMountArgs,
    resolveAssignedBranchRefPaths,
    resolveAssignedGitCustody,
    resolveAssignedWorktreeGitDir,
    resolveAssignedWorktreeUnitDir,
    resolveDefaultAgentCpuLimit,
    type WorkerConfinementRefusalReason,
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

    const CLONE = '/tmp/git-processor/clones/GospeLib/propr';
    const CUSTODY = {
        sharedGitDir: `${CLONE}/.git`,
        writablePaths: [
            `${CLONE}/.git/objects`,
            `${CLONE}/.git/worktrees/unit-7`,
            `${CLONE}/.git/refs/heads/7`,
            `${CLONE}/.git/logs/refs/heads/7`,
        ],
    };

    test('separates the shared object store a linked worktree needs from the primary working tree', () => {
        const clone = CLONE;
        const args = [
            'run',
            '-v', `${ASSIGNED}:/home/node/workspace:rw`,
            '-v', `${clone}/.git:${clone}/.git:ro`,
            '-v', `${clone}/.git/objects:${clone}/.git/objects:rw`,
            'image',
        ];
        // A linked worktree cannot function without the clone's `.git`, so it
        // travels — read-only, with only the object store writable. The
        // checked-out files beside it never travel at all.
        assert.doesNotThrow(() => assertConfinedWorkerMounts(args, {
            worktreePath: ASSIGNED,
            assignedGitCustody: CUSTODY,
            mutating: true,
        }), 'shared git storage for the assigned worktree must stay usable');

        for (const refused of [clone, `${clone}/src`]) {
            assert.throws(
                () => assertConfinedWorkerMounts(
                    ['run', '-v', `${refused}:/mnt/x:rw`, 'image'],
                    { worktreePath: ASSIGNED, assignedGitCustody: CUSTODY, mutating: true },
                ),
                (error: Error) => isWorkerConfinementRefusal(error, 'primary-checkout'),
                refused,
            );
        }
    });

    /**
     * The hole the branch custody installed inside the worker could not close:
     * a read-write `.git` hands over `refs/heads`, `packed-refs` and the config
     * that carries the push credential, so plumbing and a plain redirect reach
     * every sibling and shared ref no matter which git binary or options the
     * worker picks.
     */
    test('refuses writable shared git metadata while keeping the unit\'s own storage writable', () => {
        for (const refused of [
            `${CLONE}/.git`,
            `${CLONE}/.git/refs`,
            `${CLONE}/.git/refs/heads`,
            `${CLONE}/.git/packed-refs`,
            `${CLONE}/.git/config`,
            `${CLONE}/.git/hooks`,
            `${CLONE}/.git/worktrees/sibling-unit-8`,
            `${CLONE}/.git/refs/heads/8`,
        ]) {
            assert.throws(
                () => assertConfinedWorkerMounts(
                    ['run', '-v', `${refused}:${refused}:rw`, 'image'],
                    { worktreePath: ASSIGNED, assignedGitCustody: CUSTODY, mutating: true },
                ),
                (error: Error) => isWorkerConfinementRefusal(error, 'shared-git-metadata'),
                refused,
            );
        }

        for (const permitted of CUSTODY.writablePaths) {
            assert.doesNotThrow(() => assertConfinedWorkerMounts(
                ['run', '-v', `${permitted}:${permitted}:rw`, 'image'],
                { worktreePath: ASSIGNED, assignedGitCustody: CUSTODY, mutating: true },
            ), permitted);
        }

        // Reading shared git storage is what makes the linked worktree work.
        assert.doesNotThrow(() => assertConfinedWorkerMounts(
            ['run', '-v', `${CLONE}/.git:${CLONE}/.git:ro`, 'image'],
            { worktreePath: ASSIGNED, assignedGitCustody: CUSTODY, mutating: true },
        ));
    });

    test('scopes the writable ref directory to the assigned unit branch', () => {
        assert.deepEqual(resolveAssignedBranchRefPaths(`${CLONE}/.git`, '7/claude-opus-5-s16-t01'), {
            refDir: `${CLONE}/.git/refs/heads/7`,
            logDir: `${CLONE}/.git/logs/refs/heads/7`,
        });
        // A flat branch name would make the whole of `refs/heads` writable.
        assert.equal(resolveAssignedBranchRefPaths(`${CLONE}/.git`, 'main'), null);
        assert.equal(resolveAssignedBranchRefPaths(`${CLONE}/.git`, '/main'), null);

        const custody = resolveAssignedGitCustody({
            worktreePath: ASSIGNED,
            branchName: '7/claude-opus-5-s16-t01',
            readFile: () => `gitdir: ${CLONE}/.git/worktrees/unit-7\n`,
        });
        assert.deepEqual(custody, CUSTODY);
        assert.equal(resolveAssignedGitCustody({
            worktreePath: ASSIGNED,
            branchName: '7/claude-opus-5-s16-t01',
            readFile: () => { throw new Error('missing'); },
        }), null);
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
        const pointer = () => 'gitdir: /tmp/git-processor/clones/GospeLib/propr/.git/worktrees/unit-7\n';
        assert.equal(resolveAssignedWorktreeGitDir(ASSIGNED, pointer), '/tmp/git-processor/clones/GospeLib/propr/.git');
        assert.equal(
            resolveAssignedWorktreeUnitDir(ASSIGNED, pointer),
            '/tmp/git-processor/clones/GospeLib/propr/.git/worktrees/unit-7',
        );
        assert.equal(resolveAssignedWorktreeGitDir(ASSIGNED, () => { throw new Error('missing'); }), null);
        assert.equal(resolveAssignedWorktreeUnitDir(ASSIGNED, () => 'gitdir: /srv/plain-repo/.git\n'), null);
    });

    test('builds explicit mounts instead of the blanket git-processor mount', () => {
        const clone = '/tmp/git-processor/clones/GospeLib/propr';
        const args = buildAssignedWorktreeMountArgs({
            worktreePath: ASSIGNED,
            agentType: 'claude',
            resolveGitDir: () => `${clone}/.git`,
            resolveUnitDir: () => `${clone}/.git/worktrees/unit-7`,
        });
        // Shared git storage travels read-only. Only the content-addressed
        // object store and this unit's own administrative directory are
        // writable, so no git binary and no option can move a shared ref.
        assert.deepEqual(args, [
            '-v', `${clone}/.git:${clone}/.git:ro`,
            '-v', `${clone}/.git/objects:${clone}/.git/objects:rw`,
            '-v', `${clone}/.git/worktrees/unit-7:${clone}/.git/worktrees/unit-7:rw`,
            '-v', '/tmp/git-processor/propr-cache/claude:/tmp/git-processor/propr-cache/claude:rw',
        ]);
        assert.ok(!args.includes(`${clone}/.git:${clone}/.git:rw`));
        assert.ok(!args.includes('/tmp/git-processor:/tmp/git-processor:rw'));
        // The clone's own working tree never travels with the worktree.
        assert.ok(!args.some(argument => argument.includes('/propr:/tmp/git-processor/clones')));
    });

    /**
     * The builder and the guard have to agree about the same run. The unit's own
     * administrative directory is this unit's index, HEAD and HEAD reflog — not
     * shared metadata — so the mount set `buildAssignedWorktreeMountArgs`
     * produces must survive `assertConfinedWorkerMounts` even when no assigned
     * branch was available to resolve full custody from.
     */
    test('accepts the builder\'s own mount set when no branch custody is resolved', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-custody-fallback-'));
        try {
            const clone = path.join(root, 'clone');
            const worktreePath = path.join(root, 'unit');
            fs.mkdirSync(worktreePath, { recursive: true });
            fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${clone}/.git/worktrees/unit-7\n`);

            const args = [
                'run',
                '-v', `${worktreePath}:/home/node/workspace:rw`,
                ...buildAssignedWorktreeMountArgs({ worktreePath, agentType: 'vibe' }),
                'image',
            ];
            assert.ok(args.includes(`${clone}/.git/worktrees/unit-7:${clone}/.git/worktrees/unit-7:rw`));
            assert.doesNotThrow(() => assertConfinedWorkerMounts(args, { worktreePath, mutating: true }));

            // A sibling unit's administrative directory is still shared metadata.
            assert.throws(
                () => assertConfinedWorkerMounts(
                    ['run', '-v', `${clone}/.git/worktrees/unit-8:${clone}/.git/worktrees/unit-8:rw`, 'image'],
                    { worktreePath, mutating: true },
                ),
                (error: Error) => isWorkerConfinementRefusal(error, 'shared-git-metadata'),
            );
            // The shared ref store is still refused through the same fallback.
            assert.throws(
                () => assertConfinedWorkerMounts(
                    ['run', '-v', `${clone}/.git/refs/heads:${clone}/.git/refs/heads:rw`, 'image'],
                    { worktreePath, mutating: true },
                ),
                (error: Error) => isWorkerConfinementRefusal(error, 'shared-git-metadata'),
            );
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
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

    /**
     * A bind mount has three spellings the Docker CLI accepts interchangeably.
     * Reading only `-v <spec>` would leave the blanket git-processor mount one
     * alternate spelling away from returning — the same shape of bypass as
     * reaching past the git shim by naming `/usr/bin/git`.
     */
    test('parses every spelling of a bind mount, not just the spaced short flag', () => {
        assert.deepEqual(
            parseDockerMountArgs(['run', '--volume=/host:/container:rw', 'image']),
            [{ hostPath: '/host', containerPath: '/container', mode: 'rw' }],
        );
        assert.deepEqual(
            parseDockerMountArgs(['run', '--mount', 'type=bind,source=/host,target=/container', 'image']),
            [{ hostPath: '/host', containerPath: '/container', mode: 'rw' }],
        );
        assert.deepEqual(
            parseDockerMountArgs(['run', '--mount=type=bind,src=/host,dst=/container,readonly', 'image']),
            [{ hostPath: '/host', containerPath: '/container', mode: 'ro' }],
        );
        // A named volume and a tmpfs carry no host path to classify.
        assert.deepEqual(parseDockerMountArgs(['run', '--mount', 'type=volume,source=cache,target=/c', 'image']), []);
        assert.deepEqual(parseDockerMountArgs(['run', '--mount', 'type=tmpfs,target=/tmp', 'image']), []);
    });

    test('refuses a locked path through the --mount and inline --volume spellings', () => {
        for (const escape of [
            ['--volume=/tmp/git-processor:/tmp/git-processor:rw'],
            ['--mount', 'type=bind,source=/tmp/git-processor,target=/tmp/git-processor'],
            ['--mount=type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock'],
        ]) {
            assert.throws(
                () => assertConfinedWorkerMounts(['run', ...escape, 'image'], {
                    worktreePath: ASSIGNED,
                    mutating: true,
                }),
                (error: Error) => isWorkerConfinementRefusal(error),
                escape.join(' '),
            );
        }
        // The assigned worktree stays usable through the same spellings.
        assert.doesNotThrow(() => assertConfinedWorkerMounts(
            ['run', '--mount', `type=bind,source=${ASSIGNED},target=/home/node/workspace`, 'image'],
            { worktreePath: ASSIGNED, mutating: true },
        ));
    });

    test('refuses runtime escapes past the container boundary by name', () => {
        const refusals: Array<[string[], WorkerConfinementRefusalReason]> = [
            [['--privileged'], 'privileged-runtime'],
            [['--cap-add', 'SYS_ADMIN'], 'privileged-runtime'],
            [['--pid', 'host'], 'privileged-runtime'],
            // Joining the controller's namespace reaches its processes exactly
            // as `host` reaches the VM's.
            [['--pid', 'container:propr-controller'], 'privileged-runtime'],
            [['--ipc=container:propr-controller'], 'privileged-runtime'],
            [['--network', 'host'], 'network-outside-policy'],
            // `--net` is the CLI's own alias for `--network`.
            [['--net', 'host'], 'network-outside-policy'],
            [['--net=container:propr-controller'], 'network-outside-policy'],
            [['--security-opt', 'seccomp=unconfined'], 'unconfined-security-profile'],
            [['--security-opt', 'apparmor:unconfined'], 'unconfined-security-profile'],
            // Inherits another container's whole mount table, naming no host
            // path for the mount classifier to see.
            [['--volumes-from', 'propr-controller'], 'container-volume-import'],
        ];
        for (const [escape, reason] of refusals) {
            assert.throws(
                () => assertConfinedWorkerRuntimeArgs(['run', ...escape, 'image']),
                (error: Error) => isWorkerConfinementRefusal(error, reason),
                escape.join(' '),
            );
        }

        // The runtime the builders actually produce stays accepted.
        assert.doesNotThrow(() => assertConfinedWorkerRuntimeArgs([
            'run', '--rm',
            '--network', 'bridge',
            '--security-opt', 'no-new-privileges',
            ...buildConfinedWorkerCapabilityArgs(),
            ...buildConfinedWorkerCapsuleArgs(),
            'image',
        ]));
    });
});

import { after, describe, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    GIT_CUSTODY_GIT_SHIM,
    GIT_CUSTODY_INSTALLER_SCRIPT,
    GIT_CUSTODY_LIBRARY_SCRIPT,
    GIT_CUSTODY_PRE_COMMIT_HOOK,
    GIT_CUSTODY_PRE_PUSH_HOOK,
    wrapDockerRunArgsWithRepoSetup,
} from '../packages/core/src/claude/docker/repoSetupWrapper.js';
import { resolveDefaultAgentCpuLimit } from '../packages/core/src/agents/agentContainerResources.js';

const ASSIGNED_BRANCH = '7/claude-opus-5-s16-t01';
const custodyRoots: string[] = [];

after(() => {
    for (const root of custodyRoots) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Install the custody scripts exactly as the wrapper does inside the container
 * and hand back a real git repository to run them against. The point is to
 * exercise the shipped shell, not a re-implementation of it.
 */
function installCustodyWorkspace(): { repo: string; custodyDir: string; env: NodeJS.ProcessEnv; remote: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-custody-'));
    custodyRoots.push(root);
    const repo = path.join(root, 'repo');
    const remote = path.join(root, 'remote.git');
    const custodyDir = path.join(root, 'custody');
    const gitConfigGlobal = path.join(root, 'gitconfig');

    execFileSync('git', ['init', '--quiet', '--initial-branch', ASSIGNED_BRANCH, repo]);
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    for (const [key, value] of [['user.email', 'unit@propr.dev'], ['user.name', 'Unit']]) {
        execFileSync('git', ['-C', repo, 'config', key, value]);
    }
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
    execFileSync('git', ['-C', repo, 'add', 'seed.txt']);
    execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'seed']);

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
        GIT_CONFIG_GLOBAL: gitConfigGlobal,
        PROPR_GIT_CUSTODY_DIR: custodyDir,
        PROPR_ASSIGNED_BRANCH: ASSIGNED_BRANCH,
        PROPR_GIT_CUSTODY_LIBRARY_B64: Buffer.from(GIT_CUSTODY_LIBRARY_SCRIPT).toString('base64'),
        PROPR_GIT_CUSTODY_PRE_COMMIT_B64: Buffer.from(GIT_CUSTODY_PRE_COMMIT_HOOK).toString('base64'),
        PROPR_GIT_CUSTODY_PRE_PUSH_B64: Buffer.from(GIT_CUSTODY_PRE_PUSH_HOOK).toString('base64'),
        PROPR_GIT_CUSTODY_SHIM_B64: Buffer.from(GIT_CUSTODY_GIT_SHIM).toString('base64'),
    };
    const install = spawnSync('sh', ['-c', GIT_CUSTODY_INSTALLER_SCRIPT], { env, encoding: 'utf8' });
    assert.strictEqual(install.status, 0, `custody installer failed: ${install.stderr}`);
    return { repo, custodyDir, env, remote };
}

function runCustodiedGit(
    workspace: { repo: string; custodyDir: string; env: NodeJS.ProcessEnv },
    args: string[],
): { status: number | null; stderr: string } {
    const result = spawnSync(path.join(workspace.custodyDir, 'bin', 'git'), ['-C', workspace.repo, ...args], {
        env: workspace.env,
        encoding: 'utf8',
    });
    return { status: result.status, stderr: `${result.stderr}${result.stdout}` };
}

function stageChange(repo: string, name: string): void {
    fs.writeFileSync(path.join(repo, name), `${name}\n`);
    execFileSync('git', ['-C', repo, 'add', name]);
}

describe('wrapDockerRunArgsWithRepoSetup', () => {
    test('wraps docker command with repo setup hook and original entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt', 'no-new-privileges',
            '-v', '/tmp/worktree:/home/node/workspace:rw',
            'propr/agent:latest',
            'codex', 'exec', '--json', '-'
        ], 'propr/agent:latest', 'codex');

        const imageIndex = wrapped.indexOf('propr/agent:latest');
        assert.ok(imageIndex > -1);
        assert.ok(wrapped.indexOf('--entrypoint') < imageIndex);
        assert.deepStrictEqual(wrapped.slice(imageIndex + 1, imageIndex + 3), ['-lc', wrapped[imageIndex + 2]]);
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/codex-entrypoint.sh');
        assert.deepStrictEqual(wrapped.slice(imageIndex + 4), ['codex', 'exec', '--json', '-']);

        const wrapperScript = wrapped[imageIndex + 2];
        assert.match(wrapperScript, /\.propr\/setup\.sh/);
        assert.match(wrapperScript, /\[ "\$\(id -u\)" = "0" \][\s\S]*su-exec node env HOME=\/home\/node USER=node LOGNAME=node \/bin\/bash/);
        assert.match(wrapperScript, /<\/dev\/null >&2/);
        assert.match(wrapperScript, /ProPR repo setup hook failed with exit code/);
        assert.match(wrapperScript, /PROPR_REPO_SETUP_STRICT/);
        assert.match(wrapperScript, /Continuing so the agent can inspect and repair/);
        assert.match(wrapperScript, /exec "\$entrypoint" "\$@"/);
        assert.ok(wrapped.includes('no-new-privileges'));
        assert.deepStrictEqual(wrapped.slice(1, 9), [
            '--memory', '6g', '--memory-swap', '6g',
            '--cpus', resolveDefaultAgentCpuLimit(), '--pids-limit', '512'
        ]);
    });

    test('preserves inline no-new-privileges before repo setup', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt=no-new-privileges',
            '--security-opt', 'label=disable',
            'propr/agent:latest',
            'codex', 'exec', '-'
        ], 'propr/agent:latest', 'codex');

        assert.ok(wrapped.includes('--security-opt=no-new-privileges'));
        assert.deepStrictEqual(
            wrapped.slice(wrapped.indexOf('--security-opt'), wrapped.indexOf('--security-opt') + 2),
            ['--security-opt', 'label=disable']
        );
    });

    test('refuses an unconfined seccomp or AppArmor profile by name', () => {
        for (const profile of ['seccomp=unconfined', 'apparmor=unconfined']) {
            assert.throws(() => wrapDockerRunArgsWithRepoSetup([
                'run', '--rm', '--security-opt', profile, 'propr/agent:latest', 'codex'
            ], 'propr/agent:latest', 'codex'), new RegExp(
                `propr-worker-confinement-refused:unconfined-security-profile --security-opt ${profile}`
            ));
        }
    });

    test('preserves docker boolean no-new-privileges forms before repo setup', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '--security-opt', 'no-new-privileges:true',
            '--security-opt=no-new-privileges:false',
            '--security-opt', 'label=disable',
            'propr/agent:latest',
            'codex', 'exec', '-'
        ], 'propr/agent:latest', 'codex');

        assert.ok(wrapped.includes('no-new-privileges:true'));
        assert.ok(wrapped.includes('--security-opt=no-new-privileges:false'));
        assert.deepStrictEqual(
            wrapped.slice(wrapped.indexOf('--security-opt'), wrapped.indexOf('--security-opt') + 2),
            ['--security-opt', 'no-new-privileges:true']
        );
    });

    test('adds setup environment for the selected agent type', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '-e', 'PROPR_REPO_SETUP=0',
            'propr/agent:latest',
            'agy', '--dangerously-skip-permissions'
        ], 'propr/agent:latest', 'antigravity');

        assert.ok(wrapped.includes('PROPR_AGENT_TYPE=antigravity'));
        assert.ok(wrapped.includes('PROPR_WORKSPACE=/home/node/workspace'));
        assert.ok(wrapped.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/antigravity'));
        assert.ok(wrapped.includes('PROPR_REPO_SETUP=0'));
        assert.ok(wrapped.includes('GIT_AUTHOR_NAME=ProPR Antigravity Bot'));
        assert.ok(wrapped.includes('GIT_AUTHOR_EMAIL=antigravity-bot@propr.dev'));
        assert.ok(wrapped.includes('GIT_COMMITTER_NAME=ProPR Antigravity Bot'));
        assert.ok(wrapped.includes('GIT_COMMITTER_EMAIL=antigravity-bot@propr.dev'));

        const imageIndex = wrapped.indexOf('propr/agent:latest');
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/antigravity-entrypoint.sh');
    });

    test('maps Vibe to the Vibe entrypoint', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            'propr/agent:latest',
            'vibe', '--prompt', 'Analyze the codebase'
        ], 'propr/agent:latest', 'vibe');

        assert.ok(wrapped.includes('PROPR_AGENT_TYPE=vibe'));
        assert.ok(wrapped.includes('PROPR_CACHE_DIR=/tmp/git-processor/propr-cache/vibe'));

        const imageIndex = wrapped.indexOf('propr/agent:latest');
        assert.strictEqual(wrapped[imageIndex + 3], '/home/node/vibe-entrypoint.sh');
        assert.deepStrictEqual(wrapped.slice(imageIndex + 4), ['vibe', '--prompt', 'Analyze the codebase']);
    });

    test('agent entrypoints do not require sudo under Docker no-new-privileges', () => {
        for (const scriptPath of [
            'scripts/codex-entrypoint.sh',
            'scripts/antigravity-entrypoint.sh'
        ]) {
            const script = fs.readFileSync(scriptPath, 'utf8');
            const executableLines = script
                .split('\n')
                .filter(line => !line.trim().startsWith('#'))
                .join('\n');
            assert.doesNotMatch(executableLines, /\bsudo\b/, `${scriptPath} should not invoke sudo`);
            assert.match(script, /exec su-exec node env HOME=\/home\/node USER=node LOGNAME=node "\$@"/);
        }
    });

    test('Claude creates an immutable admitted-worker marker before dropping privileges', () => {
        const script = fs.readFileSync('scripts/claude-entrypoint.sh', 'utf8');
        const markerIndex = script.indexOf('PROPR_EZER_ADMISSION_MARKER_B64');
        const dropPrivilegesIndex = script.indexOf('exec su-exec node');

        assert.ok(markerIndex > -1);
        assert.ok(markerIndex < dropPrivilegesIndex);
        assert.match(script, /chown root:root "\$PROPR_EZER_MARKER_DIR" "\$PROPR_EZER_MARKER_PATH"/);
        assert.match(script, /chmod 0444 "\$PROPR_EZER_MARKER_PATH"/);
        assert.match(script, /chmod 0555 "\$PROPR_EZER_MARKER_DIR"/);
        assert.match(script, /unset PROPR_EZER_ADMISSION_MARKER_B64/);
        assert.match(script, /exec su-exec node env HOME="\$\{PROPR_CLAUDE_HOME:-\/home\/node\}" USER=node LOGNAME=node "\$@"/);
    });

    test('confines the capsule and drops the ambient capability set', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'propr/agent:latest', 'claude'
        ], 'propr/agent:latest', 'claude');

        assert.ok(wrapped.includes('--read-only'), 'capsule must be read-only');
        assert.deepStrictEqual(
            wrapped.slice(wrapped.indexOf('--cap-drop'), wrapped.indexOf('--cap-drop') + 2),
            ['--cap-drop', 'ALL']
        );
        for (const capability of ['DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID']) {
            assert.ok(wrapped.includes(capability), `expected re-added capability ${capability}`);
        }
        for (const scratch of ['/tmp', '/run', '/home/node/bin']) {
            assert.ok(wrapped.includes(`${scratch}:rw,mode=1777`), `expected writable scratch at ${scratch}`);
        }
        assert.ok(wrapped.includes('GIT_CONFIG_GLOBAL=/tmp/propr-git-global.config'));
    });

    test('refuses runtime escapes past the existing network and privilege policy by name', () => {
        const escapes: Array<[string[], string]> = [
            [['--privileged'], 'privileged-runtime'],
            [['--network', 'host'], 'network-outside-policy'],
            [['--pid', 'host'], 'privileged-runtime'],
            [['--cap-add', 'SYS_ADMIN'], 'privileged-runtime'],
            [['--device', '/dev/fuse'], 'privileged-runtime'],
        ];
        for (const [escape, reason] of escapes) {
            assert.throws(() => wrapDockerRunArgsWithRepoSetup([
                'run', '--rm', ...escape, 'propr/agent:latest', 'claude'
            ], 'propr/agent:latest', 'claude'), new RegExp(`propr-worker-confinement-refused:${reason}\\b`), escape.join(' '));
        }
    });

    test('refuses mutating execution that cannot present its assigned unit branch', () => {
        assert.throws(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'propr/agent:latest', 'claude'
        ], 'propr/agent:latest', 'claude', { mutating: true, worktreePath: '/tmp/worktrees/unit' }),
        /propr-worker-confinement-refused:missing-assigned-branch claude mutating execution/);

        assert.doesNotThrow(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'propr/agent:latest', 'claude'
        ], 'propr/agent:latest', 'claude', {
            mutating: true, branchName: ASSIGNED_BRANCH, worktreePath: '/tmp/worktrees/unit',
        }));
    });

    test('refuses a mutating mount of the primary checkout or an unrelated worktree by name', () => {
        const cases: Array<[string, string]> = [
            ['/tmp/git-processor/clones/GospeLib/propr', 'primary-checkout'],
            ['/tmp/git-processor/worktrees/other-unit', 'unrelated-worktree'],
            ['/usr/src/app/data', 'controller-state'],
            ['/run/propr', 'attestation-store'],
            ['/tmp/git-processor/propr-cache/transcripts', 'authoritative-evidence'],
            ['/var/run/docker.sock', 'container-control-socket'],
            ['/home/runner/.ssh', 'out-of-scope-credential'],
        ];
        for (const [hostPath, reason] of cases) {
            assert.throws(() => wrapDockerRunArgsWithRepoSetup([
                'run', '--rm', '-v', `${hostPath}:/mnt/x:rw`, 'propr/agent:latest', 'claude'
            ], 'propr/agent:latest', 'claude', {
                mutating: true,
                branchName: ASSIGNED_BRANCH,
                worktreePath: '/tmp/git-processor/worktrees/assigned-unit',
            }), new RegExp(`propr-worker-confinement-refused:${reason} ${hostPath.replace(/\//g, '\\/')}`), hostPath);
        }
    });

    test('keeps the assigned worktree and its own transcript usable', () => {
        const worktreePath = '/tmp/git-processor/worktrees/assigned-unit';
        const transcript = '/tmp/git-processor/propr-cache/transcripts/antigravity/run-1.jsonl';
        assert.doesNotThrow(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm',
            '-v', `${worktreePath}:/home/node/workspace:rw`,
            '-v', `${transcript}:${transcript}:rw`,
            'propr/agent:latest', 'agy'
        ], 'propr/agent:latest', 'antigravity', {
            mutating: true, branchName: ASSIGNED_BRANCH, worktreePath, scopedEvidencePath: transcript,
        }));
    });

    test('carries the assigned unit branch into the container git custody environment', () => {
        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'propr/agent:latest', 'claude'
        ], 'propr/agent:latest', 'claude', { branchName: ASSIGNED_BRANCH, mutating: true });

        assert.ok(wrapped.includes(`PROPR_ASSIGNED_BRANCH=${ASSIGNED_BRANCH}`));
        assert.ok(wrapped.some(argument => argument.startsWith('PROPR_GIT_CUSTODY_INSTALLER_B64=')));
        const script = wrapped[wrapped.indexOf('-lc') + 1];
        assert.match(script, /PROPR_GIT_CUSTODY_INSTALLER_B64/);
    });

    test('throws when the configured docker image cannot be found', () => {
        assert.throws(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'other-image:latest', 'claude'
        ], 'propr/agent:latest', 'claude'), /Docker image 'propr\/agent:latest' was not found/);
    });
});

describe('git custody inside the worker', () => {
    test('keeps the assigned unit branch usable for commit and push', () => {
        const workspace = installCustodyWorkspace();
        stageChange(workspace.repo, 'unit-work.txt');

        const commit = runCustodiedGit(workspace, ['commit', '--quiet', '-m', 'unit work']);
        assert.strictEqual(commit.status, 0, commit.stderr);

        const push = runCustodiedGit(workspace, ['push', 'origin', ASSIGNED_BRANCH]);
        assert.strictEqual(push.status, 0, push.stderr);
        assert.match(
            execFileSync('git', ['-C', workspace.remote, 'branch', '--list'], { encoding: 'utf8' }),
            new RegExp(ASSIGNED_BRANCH.replace(/\//g, '\\/')),
        );
    });

    test('refuses commits outside custody by branch class', () => {
        for (const [branch, reason] of [
            ['1647-epic-github-app-11i', 'feature-branch'],
            ['8/codex-sibling-unit', 'sibling-unit-branch'],
            ['main', 'shared-branch'],
        ] as const) {
            const workspace = installCustodyWorkspace();
            execFileSync('git', ['-C', workspace.repo, 'checkout', '--quiet', '-b', branch]);
            stageChange(workspace.repo, 'escape.txt');

            const commit = runCustodiedGit(workspace, ['commit', '-m', 'escape']);
            assert.notStrictEqual(commit.status, 0, `${branch} commit should be refused`);
            assert.match(commit.stderr, new RegExp(`propr-branch-custody-refused:${reason} ${branch.replace(/\//g, '\\/')}`));
            assert.strictEqual(
                execFileSync('git', ['-C', workspace.repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(),
                '1',
                'refusal must land before the commit takes effect',
            );
        }
    });

    test('refuses pushes outside custody by branch class', () => {
        for (const [branch, reason] of [
            ['1647-epic-github-app-11i', 'feature-branch'],
            ['8/codex-sibling-unit', 'sibling-unit-branch'],
            ['main', 'shared-branch'],
        ] as const) {
            const workspace = installCustodyWorkspace();
            const push = runCustodiedGit(workspace, ['push', 'origin', `${ASSIGNED_BRANCH}:${branch}`]);
            assert.notStrictEqual(push.status, 0, `${branch} push should be refused`);
            assert.match(push.stderr, new RegExp(`propr-branch-custody-refused:${reason} ${branch.replace(/\//g, '\\/')}`));
            assert.strictEqual(
                execFileSync('git', ['-C', workspace.remote, 'branch', '--list'], { encoding: 'utf8' }).trim(),
                '',
                'refusal must land before the push takes effect',
            );
        }
    });

    test('refuses a --no-verify commit through the installed hook path', () => {
        const workspace = installCustodyWorkspace();
        execFileSync('git', ['-C', workspace.repo, 'checkout', '--quiet', '-b', 'main']);
        stageChange(workspace.repo, 'escape.txt');

        // The shim gates the command even when the caller disables hooks...
        const viaShim = runCustodiedGit(workspace, ['commit', '--no-verify', '-m', 'escape']);
        assert.notStrictEqual(viaShim.status, 0);
        assert.match(viaShim.stderr, /propr-branch-custody-refused:shared-branch main/);

        // ...and the hook gates the real binary when the shim is bypassed.
        const viaRealGit = spawnSync('git', ['-C', workspace.repo, 'commit', '-m', 'escape'], {
            env: workspace.env,
            encoding: 'utf8',
        });
        assert.notStrictEqual(viaRealGit.status, 0);
        assert.match(`${viaRealGit.stderr}${viaRealGit.stdout}`, /propr-branch-custody-refused:shared-branch main/);
    });

    test('refuses a bulk push that would carry every branch out of custody', () => {
        const workspace = installCustodyWorkspace();
        const push = runCustodiedGit(workspace, ['push', '--all', 'origin']);
        assert.notStrictEqual(push.status, 0);
        assert.match(push.stderr, /propr-branch-custody-refused:shared-branch --all/);
    });
});

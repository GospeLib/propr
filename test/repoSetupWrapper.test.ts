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
    GIT_CUSTODY_SEAL_SCRIPT,
    wrapDockerRunArgsWithRepoSetup,
} from '../packages/core/src/claude/docker/repoSetupWrapper.js';
import { resolveDefaultAgentCpuLimit } from '../packages/core/src/agents/agentContainerResources.js';

const ASSIGNED_BRANCH = '7/claude-opus-5-s16-t01';
/** The real binary, reached without the PATH shim the custody installer adds. */
const REAL_GIT = '/usr/bin/git';
const custodyRoots: string[] = [];

interface CustodyWorkspace {
    repo: string;
    custodyDir: string;
    env: NodeJS.ProcessEnv;
    remote: string;
    /** A commit that exists but that no branch outside custody points at yet. */
    unitHead: string;
}

after(() => {
    for (const root of custodyRoots) {
        // Custody seals the ref store read-only, including for its owner.
        try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* already gone */ }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

function runCustodyInstaller(env: NodeJS.ProcessEnv, workspacePath: string): { status: number | null; stderr: string } {
    const result = spawnSync('sh', ['-c', GIT_CUSTODY_INSTALLER_SCRIPT], {
        env: { ...env, PROPR_WORKSPACE: workspacePath },
        encoding: 'utf8',
    });
    return { status: result.status, stderr: `${result.stderr}${result.stdout}` };
}

/**
 * Install the custody scripts exactly as the wrapper does inside the container
 * and hand back a real git repository to run them against. The point is to
 * exercise the shipped shell, not a re-implementation of it.
 *
 * Branches outside custody are created before the install, because after it the
 * shared ref store is exactly what the worker can no longer write.
 */
function installCustodyWorkspace(branchesOutsideCustody: string[] = []): CustodyWorkspace {
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
    for (const branch of branchesOutsideCustody) {
        execFileSync('git', ['-C', repo, 'branch', branch]);
    }
    fs.writeFileSync(path.join(repo, 'unit.txt'), 'unit\n');
    execFileSync('git', ['-C', repo, 'add', 'unit.txt']);
    execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'unit']);
    const unitHead = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
        GIT_CONFIG_GLOBAL: gitConfigGlobal,
        PROPR_GIT_CUSTODY_DIR: custodyDir,
        PROPR_ASSIGNED_BRANCH: ASSIGNED_BRANCH,
        PROPR_GIT_CUSTODY_LIBRARY_B64: Buffer.from(GIT_CUSTODY_LIBRARY_SCRIPT).toString('base64'),
        PROPR_GIT_CUSTODY_SEAL_B64: Buffer.from(GIT_CUSTODY_SEAL_SCRIPT).toString('base64'),
        PROPR_GIT_CUSTODY_PRE_COMMIT_B64: Buffer.from(GIT_CUSTODY_PRE_COMMIT_HOOK).toString('base64'),
        PROPR_GIT_CUSTODY_PRE_PUSH_B64: Buffer.from(GIT_CUSTODY_PRE_PUSH_HOOK).toString('base64'),
        PROPR_GIT_CUSTODY_SHIM_B64: Buffer.from(GIT_CUSTODY_GIT_SHIM).toString('base64'),
    };
    // The push destination is a git storage too, so it carries the same custody.
    const remoteInstall = runCustodyInstaller(env, remote);
    assert.strictEqual(remoteInstall.status, 0, `custody installer failed on the remote: ${remoteInstall.stderr}`);
    const install = runCustodyInstaller(env, repo);
    assert.strictEqual(install.status, 0, `custody installer failed: ${install.stderr}`);
    return { repo, custodyDir, env, remote, unitHead };
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

/** The real git binary, with no shim ahead of it and no hook able to speak. */
function runDirectGit(
    workspace: { repo: string; env: NodeJS.ProcessEnv },
    args: string[],
): { status: number | null; stderr: string } {
    const result = spawnSync(REAL_GIT, ['-C', workspace.repo, ...args], {
        env: workspace.env,
        encoding: 'utf8',
    });
    return { status: result.status, stderr: `${result.stderr}${result.stdout}` };
}

function stageChange(repo: string, name: string): void {
    fs.writeFileSync(path.join(repo, name), `${name}\n`);
    execFileSync('git', ['-C', repo, 'add', name]);
}

function readBranchTip(repo: string, branch: string): string {
    return execFileSync('git', ['-C', repo, 'rev-parse', branch], { encoding: 'utf8' }).trim();
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

    /**
     * The shared gate has to read the argument as Docker will run it, not as one
     * preferred spelling. `--net` is the CLI's own alias, `--flag=value` is the
     * inline form, `--mount` is the documented bind syntax and `--volumes-from`
     * carries a whole mount table in without naming a host path — each one
     * reaches past a guard that only matches `--network`, `--pid` and `-v`.
     */
    test('refuses the same escapes through their alternate Docker spellings', () => {
        const escapes: Array<[string[], string]> = [
            [['--net', 'host'], 'network-outside-policy'],
            [['--network=host'], 'network-outside-policy'],
            [['--pid=host'], 'privileged-runtime'],
            [['--pid', 'container:propr-controller'], 'privileged-runtime'],
            [['--security-opt', 'apparmor:unconfined'], 'unconfined-security-profile'],
            [['--volumes-from', 'propr-controller'], 'container-volume-import'],
            [['--volume=/tmp/git-processor:/tmp/git-processor:rw'], 'primary-checkout'],
            [['--mount', 'type=bind,source=/usr/src/app/data,target=/data'], 'controller-state'],
            [['--mount=type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock'], 'container-control-socket'],
        ];
        for (const [escape, reason] of escapes) {
            assert.throws(() => wrapDockerRunArgsWithRepoSetup([
                'run', '--rm', ...escape, 'propr/agent:latest', 'claude'
            ], 'propr/agent:latest', 'claude', {
                mutating: true,
                branchName: ASSIGNED_BRANCH,
                worktreePath: '/tmp/git-processor/worktrees/assigned-unit',
            }), new RegExp(`propr-worker-confinement-refused:${reason}\\b`), escape.join(' '));
        }
    });

    test('still reads only Docker\'s own arguments, not the agent command line', () => {
        // An agent CLI argument that happens to read like an escape is the
        // model's text, not a runtime flag, and must not trip the guard.
        assert.doesNotThrow(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'propr/agent:latest',
            'claude', '-p', '--net host --volumes-from propr-controller',
            '--mount', 'type=bind,source=/usr/src/app/data,target=/data',
        ], 'propr/agent:latest', 'claude', {
            mutating: true,
            branchName: ASSIGNED_BRANCH,
            worktreePath: '/tmp/git-processor/worktrees/assigned-unit',
        }));
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

    test('refuses a mutating run whose assigned branch would open the whole ref store', () => {
        assert.throws(() => wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'propr/agent:latest', 'claude'
        ], 'propr/agent:latest', 'claude', {
            mutating: true, branchName: 'stage', worktreePath: '/tmp/worktrees/unit',
        }), /propr-worker-confinement-refused:unscoped-assigned-branch claude assigned branch stage/);
    });

    test('refuses a writable mount of shared git metadata by name', () => {
        const clone = '/tmp/git-processor/clones/GospeLib/propr';
        const worktreePath = '/tmp/git-processor/worktrees/assigned-unit';
        for (const shared of [`${clone}/.git`, `${clone}/.git/refs`, `${clone}/.git/config`]) {
            assert.throws(() => wrapDockerRunArgsWithRepoSetup([
                'run', '--rm', '-v', `${shared}:${shared}:rw`, 'propr/agent:latest', 'claude'
            ], 'propr/agent:latest', 'claude', {
                mutating: true, branchName: ASSIGNED_BRANCH, worktreePath,
            }), /propr-worker-confinement-refused:(shared-git-metadata|primary-checkout)/, shared);
        }
    });

    test('carries the assigned branch ref directory into the mount table', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propr-custody-mounts-'));
        custodyRoots.push(root);
        const clone = path.join(root, 'clone');
        const worktreePath = path.join(root, 'unit');
        fs.mkdirSync(worktreePath, { recursive: true });
        fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${clone}/.git/worktrees/unit\n`);

        const wrapped = wrapDockerRunArgsWithRepoSetup([
            'run', '--rm', 'propr/agent:latest', 'claude'
        ], 'propr/agent:latest', 'claude', { mutating: true, branchName: ASSIGNED_BRANCH, worktreePath });

        assert.ok(wrapped.includes(`${clone}/.git/refs/heads/7:${clone}/.git/refs/heads/7:rw`));
        assert.ok(wrapped.includes(`${clone}/.git/logs/refs/heads/7:${clone}/.git/logs/refs/heads/7:rw`));
        assert.ok(!wrapped.includes(`${clone}/.git:${clone}/.git:rw`));
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

const BRANCH_CLASSES = [
    ['1647-epic-github-app-11i', 'feature-branch'],
    ['8/codex-sibling-unit', 'sibling-unit-branch'],
    ['main', 'shared-branch'],
] as const;

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

    test('keeps the assigned unit usable through the real binary under the seal', () => {
        const workspace = installCustodyWorkspace();
        stageChange(workspace.repo, 'unit-work.txt');

        // Nothing about custody depends on the worker choosing the shim, so the
        // assigned unit has to stay usable when it does not.
        const commit = runDirectGit(workspace, ['commit', '--quiet', '--no-verify', '-m', 'unit work']);
        assert.strictEqual(commit.status, 0, commit.stderr);

        const push = runDirectGit(workspace, ['push', '--no-verify', 'origin', ASSIGNED_BRANCH]);
        assert.strictEqual(push.status, 0, push.stderr);
        assert.strictEqual(
            readBranchTip(workspace.remote, ASSIGNED_BRANCH),
            readBranchTip(workspace.repo, ASSIGNED_BRANCH),
        );
    });

    test('refuses commits outside custody by branch class', () => {
        for (const [branch, reason] of BRANCH_CLASSES) {
            const workspace = installCustodyWorkspace([branch]);
            execFileSync('git', ['-C', workspace.repo, 'checkout', '--quiet', branch]);
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
        for (const [branch, reason] of BRANCH_CLASSES) {
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

    test('refuses a bulk push that would carry every branch out of custody', () => {
        const workspace = installCustodyWorkspace();
        const push = runCustodiedGit(workspace, ['push', '--all', 'origin']);
        assert.notStrictEqual(push.status, 0);
        assert.match(push.stderr, /propr-branch-custody-refused:shared-branch --all/);
    });

    /**
     * The composed bypass the hook and the shim each leave open on their own:
     * the worker picks the executable *and* the options, so it can name
     * `/usr/bin/git`, pass `--no-verify`, drop to plumbing, or skip git and
     * write the ref file itself. Custody has to sit under all four.
     */
    test('refuses commits outside custody through the direct binary, --no-verify, plumbing and direct refs', () => {
        for (const [branch] of BRANCH_CLASSES) {
            const workspace = installCustodyWorkspace([branch]);
            const before = readBranchTip(workspace.repo, branch);
            execFileSync('git', ['-C', workspace.repo, 'checkout', '--quiet', branch]);
            stageChange(workspace.repo, 'escape.txt');

            const commit = runDirectGit(workspace, ['commit', '--no-verify', '-m', 'escape']);
            assert.notStrictEqual(commit.status, 0, `${branch}: direct --no-verify commit should be refused`);

            const plumbing = runDirectGit(workspace, ['update-ref', `refs/heads/${branch}`, workspace.unitHead]);
            assert.notStrictEqual(plumbing.status, 0, `${branch}: update-ref should be refused`);

            const symbolic = runDirectGit(workspace, ['branch', '--force', branch, workspace.unitHead]);
            assert.notStrictEqual(symbolic.status, 0, `${branch}: forced branch move should be refused`);

            assert.throws(
                () => fs.writeFileSync(path.join(workspace.repo, '.git', 'refs', 'heads', branch), `${workspace.unitHead}\n`),
                /EACCES|EPERM|EROFS/,
                `${branch}: a direct ref write should be refused`,
            );

            assert.strictEqual(readBranchTip(workspace.repo, branch), before, `${branch} must not have moved`);
        }
    });

    test('refuses pushes outside custody through the direct binary, --no-verify and plumbing', () => {
        for (const [branch] of BRANCH_CLASSES) {
            const workspace = installCustodyWorkspace();

            const push = runDirectGit(workspace, [
                'push', '--no-verify', 'origin', `${workspace.unitHead}:refs/heads/${branch}`,
            ]);
            assert.notStrictEqual(push.status, 0, `${branch}: direct --no-verify push should be refused`);

            const sendPack = spawnSync(REAL_GIT, [
                '-C', workspace.repo, 'send-pack', workspace.remote, `${workspace.unitHead}:refs/heads/${branch}`,
            ], { env: workspace.env, encoding: 'utf8' });
            assert.notStrictEqual(sendPack.status, 0, `${branch}: send-pack should be refused`);

            assert.strictEqual(
                execFileSync('git', ['-C', workspace.remote, 'branch', '--list'], { encoding: 'utf8' }).trim(),
                '',
                `${branch}: refusal must land before the push takes effect`,
            );
        }
    });

    test('custody survives the hooks and the PATH shim being removed', () => {
        const workspace = installCustodyWorkspace(['main']);
        // Hooks and the shim are legibility, not the control: take them away and
        // the refusal has to stand on the git storage alone.
        execFileSync('chmod', ['-R', 'u+w', workspace.custodyDir]);
        fs.rmSync(path.join(workspace.custodyDir, 'hooks'), { recursive: true, force: true });
        fs.rmSync(path.join(workspace.custodyDir, 'bin'), { recursive: true, force: true });

        execFileSync('git', ['-C', workspace.repo, 'checkout', '--quiet', 'main']);
        stageChange(workspace.repo, 'escape.txt');

        const commit = runDirectGit(workspace, ['commit', '--no-verify', '-m', 'escape']);
        assert.notStrictEqual(commit.status, 0);
        assert.match(commit.stderr, /cannot lock ref|Permission denied|unable to (create|update|append)/i);
        assert.strictEqual(
            execFileSync('git', ['-C', workspace.repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim(),
            '1',
        );
    });

    test('refuses the run when shared git storage arrives outside custody', () => {
        const workspace = installCustodyWorkspace();
        const linked = path.join(path.dirname(workspace.repo), 'linked-unit');
        // A linked worktree shares its ref store with the primary checkout and
        // every sibling unit, so custody there is the mount, not a chmod from
        // inside the container. Without it the run is refused before it starts.
        execFileSync('chmod', ['-R', 'u+w', path.join(workspace.repo, '.git')]);
        execFileSync('git', ['-C', workspace.repo, 'worktree', 'add', '--quiet', '-b', '9/linked-unit', linked]);

        const unsealed = runCustodyInstaller({ ...workspace.env, PROPR_ASSIGNED_BRANCH: '9/linked-unit' }, linked);
        assert.notStrictEqual(unsealed.status, 0, 'a writable shared ref store must refuse the run');
        assert.match(unsealed.stderr, /propr-branch-custody-refused:shared-ref-store/);

        // Read-only shared storage is what the mount plan delivers; verify it passes.
        for (const sealed of ['refs', 'logs/refs', 'packed-refs', 'config']) {
            const target = path.join(workspace.repo, '.git', sealed);
            if (fs.existsSync(target)) execFileSync('chmod', ['-R', 'a-w', target]);
        }
        execFileSync('chmod', ['-R', 'u+w', path.join(workspace.repo, '.git', 'refs', 'heads', '9')]);
        const sealedRun = runCustodyInstaller({ ...workspace.env, PROPR_ASSIGNED_BRANCH: '9/linked-unit' }, linked);
        assert.strictEqual(sealedRun.status, 0, sealedRun.stderr);
    });

    test('refuses an assigned branch that would make the whole ref store writable', () => {
        const workspace = installCustodyWorkspace();
        const unscoped = runCustodyInstaller({ ...workspace.env, PROPR_ASSIGNED_BRANCH: 'stage' }, workspace.repo);
        assert.notStrictEqual(unscoped.status, 0);
        assert.match(unscoped.stderr, /propr-branch-custody-refused:unscoped-assigned-branch stage/);
    });
});

import type { AgentType } from '../../agents/types.js';
import {
    assertConfinedWorkerMounts,
    assertConfinedWorkerRuntimeArgs,
    buildAgentContainerResourceArgs,
    buildAssignedBranchCustodyMountArgs,
    buildConfinedWorkerCapabilityArgs,
    buildConfinedWorkerCapsuleArgs,
    refuseWorkerConfinement,
    resolveAssignedGitCustody,
} from '../../agents/agentContainerResources.js';

export { buildAgentContainerResourceArgs };

const ENTRYPOINT_PATHS: Record<AgentType, string> = {
    claude: '/home/node/claude-entrypoint.sh',
    codex: '/home/node/codex-entrypoint.sh',
    antigravity: '/home/node/antigravity-entrypoint.sh',
    opencode: '/home/node/opencode-entrypoint.sh',
    vibe: '/home/node/vibe-entrypoint.sh'
};

const GIT_IDENTITIES: Record<AgentType, { name: string; email: string }> = {
    claude: { name: 'ProPR Claude Bot', email: 'claude-bot@propr.dev' },
    codex: { name: 'ProPR Codex Bot', email: 'codex-bot@propr.dev' },
    antigravity: { name: 'ProPR Antigravity Bot', email: 'antigravity-bot@propr.dev' },
    opencode: { name: 'ProPR OpenCode Bot', email: 'opencode-bot@propr.dev' },
    vibe: { name: 'ProPR Vibe Bot', email: 'vibe-bot@propr.dev' }
};

const WORKSPACE_PATH = '/home/node/workspace';
const DEFAULT_CACHE_ROOT = '/tmp/git-processor/propr-cache';
const GIT_CUSTODY_DIR = '/tmp/propr-git-custody';

export const BRANCH_CUSTODY_REFUSAL_PREFIX = 'propr-branch-custody-refused';

/**
 * Git custody, installed inside the worker.
 *
 * Confinement decides which paths a worker can touch; it deliberately does not
 * decide which branches it may write. A worker holding a legitimate,
 * fully-confined worktree still shares the clone's object store with every
 * other unit, so commit and push custody is enforced separately here.
 *
 * Enforcement is the git *storage*, not the git *command*: see
 * {@link GIT_CUSTODY_SEAL_SCRIPT}. The classifier and the two hooks and shim
 * below sit above it and exist only to name the branch class in the worker's
 * own output — the feature branch, a sibling unit's branch and a shared branch
 * each get their own name, and only the assigned unit branch is usable. They
 * are legibility, never the control: `/usr/bin/git commit --no-verify` reaches
 * past all three, and the seal is what stops it.
 */
export const GIT_CUSTODY_LIBRARY_SCRIPT = `
propr_custody_refuse() {
    printf '${BRANCH_CUSTODY_REFUSAL_PREFIX}:%s %s\\n' "$1" "$2" >&2
    exit 1
}

propr_custody_class() {
    propr_branch="$1"
    if [ -n "$propr_branch" ] && [ "$propr_branch" = "\${PROPR_ASSIGNED_BRANCH:-}" ]; then
        printf 'assigned'
        return 0
    fi
    if [ -z "$propr_branch" ]; then
        printf 'detached-head'
        return 0
    fi
    case "$propr_branch" in
        main|master|develop|development|staging|stage|production|prod|release|trunk)
            printf 'shared-branch'; return 0;;
        release/*|hotfix/*|gospelib/*)
            printf 'shared-branch'; return 0;;
    esac
    case "$propr_branch" in
        */*) printf 'sibling-unit-branch'; return 0;;
    esac
    printf 'feature-branch'
}

propr_custody_require_assigned() {
    propr_class="$(propr_custody_class "$1")"
    [ "$propr_class" = 'assigned' ] || propr_custody_refuse "$propr_class" "$1"
}

propr_custody_current_branch() {
    if [ -n "\${1:-}" ]; then
        "\${PROPR_REAL_GIT:-git}" -C "$1" symbolic-ref --quiet --short HEAD 2>/dev/null || printf ''
    else
        "\${PROPR_REAL_GIT:-git}" symbolic-ref --quiet --short HEAD 2>/dev/null || printf ''
    fi
}
`.trim();

/**
 * Names a commit whose HEAD is outside custody. Advisory only: `--no-verify`
 * skips it, which is why {@link GIT_CUSTODY_SEAL_SCRIPT} is the enforcement.
 */
export const GIT_CUSTODY_PRE_COMMIT_HOOK = `#!/bin/sh
. "\${PROPR_GIT_CUSTODY_DIR:-${GIT_CUSTODY_DIR}}/custody.sh"
propr_custody_require_assigned "$(propr_custody_current_branch)"
`;

/** Names a push to a destination ref outside custody. Advisory only. */
export const GIT_CUSTODY_PRE_PUSH_HOOK = `#!/bin/sh
. "\${PROPR_GIT_CUSTODY_DIR:-${GIT_CUSTODY_DIR}}/custody.sh"
while read -r propr_local_ref propr_local_sha propr_remote_ref propr_remote_sha; do
    [ -n "$propr_remote_ref" ] || continue
    case "$propr_remote_ref" in
        refs/heads/*) propr_custody_require_assigned "\${propr_remote_ref#refs/heads/}";;
    esac
done
`;

/**
 * A `git` shim placed ahead of the real binary on PATH, so an ordinary `git`
 * invocation is refused by name rather than by a bare `Permission denied`.
 * Advisory only: the worker selects its own executable, so `/usr/bin/git`
 * walks straight past this.
 */
export const GIT_CUSTODY_GIT_SHIM = `#!/bin/sh
. "\${PROPR_GIT_CUSTODY_DIR:-${GIT_CUSTODY_DIR}}/custody.sh"

propr_subcommand=''
propr_repo_dir=''
propr_skip_next=''
propr_seen_remote=''
propr_pushed_ref=''

for propr_arg in "$@"; do
    if [ -n "$propr_skip_next" ]; then
        [ "$propr_skip_next" = 'repo' ] && propr_repo_dir="$propr_arg"
        propr_skip_next=''
        continue
    fi
    if [ -z "$propr_subcommand" ]; then
        # Skip git's own global options so the subcommand is identified
        # correctly even behind "-C <dir>" or "-c <name>=<value>".
        case "$propr_arg" in
            -C) propr_skip_next='repo'; continue;;
            -c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)
                propr_skip_next='value'; continue;;
            --git-dir=*|--work-tree=*) propr_repo_dir="\${propr_arg#*=}"; continue;;
            -*) continue;;
            *) propr_subcommand="$propr_arg"; continue;;
        esac
    fi
    [ "$propr_subcommand" = 'push' ] || continue
    case "$propr_arg" in
        --all|--mirror)
            propr_custody_refuse 'shared-branch' "$propr_arg";;
        --delete|-d)
            propr_custody_refuse 'shared-branch' 'branch deletion';;
        -*) ;;
        *)
            if [ -z "$propr_seen_remote" ]; then
                propr_seen_remote="$propr_arg"
            else
                propr_pushed_ref="\${propr_arg##*:}"
                propr_custody_require_assigned "\${propr_pushed_ref#refs/heads/}"
            fi
            ;;
    esac
done

case "$propr_subcommand" in
    commit)
        propr_custody_require_assigned "$(propr_custody_current_branch "$propr_repo_dir")"
        ;;
    push)
        [ -n "$propr_pushed_ref" ] \\
            || propr_custody_require_assigned "$(propr_custody_current_branch "$propr_repo_dir")"
        ;;
esac

exec "\${PROPR_REAL_GIT:-/usr/bin/git}" "$@"
`;

/**
 * Git custody as the worker's git *storage*, which is what the hooks and the
 * shim above cannot be.
 *
 * A hook is skipped by `--no-verify`, a PATH shim is skipped by naming
 * `/usr/bin/git`, and both are skipped entirely by plumbing (`git update-ref`)
 * or by writing `.git/refs/heads/main` with a redirect. All four of those still
 * go through one thing the worker does not select: the filesystem the git
 * process runs on. So custody lives there.
 *
 * The custody shape is a single split of the shared git directory:
 *
 * - `refs`, `logs/refs`, `packed-refs` and `config` — every shared branch, tag
 *   and remote-tracking ref, plus the config carrying the push credential —
 *   are not writable by the worker.
 * - `objects` stays writable. Objects are content addressed, so writing one
 *   cannot move a ref or rewrite another unit's history.
 * - `refs/heads/<assigned parent>` and its reflog stay writable, which is what
 *   keeps the assigned unit's own commit and push genuinely usable. Git updates
 *   a ref by creating `<ref>.lock` beside it, so the containing directory is
 *   the smallest writable unit the files ref backend can express.
 *
 * For a linked worktree that shape arrives as read-only bind mounts from
 * {@link buildAssignedWorktreeMountArgs}: the common directory is shared with
 * the primary checkout and every sibling unit, so tightening it from inside the
 * container would rewrite host state for all of them. This script therefore
 * only *verifies* it there, and refuses the run before the agent starts when it
 * is absent. A self-contained repository is private to this unit, so the same
 * shape is applied in place.
 *
 * The verification probe runs as the unprivileged worker account, because root
 * is writable everywhere and would report custody that the worker does not
 * actually have.
 */
export const GIT_CUSTODY_SEAL_SCRIPT = `
propr_custody_as_worker() {
    if [ "$(id -u)" = '0' ] && command -v su-exec >/dev/null 2>&1 && id node >/dev/null 2>&1; then
        su-exec node /bin/sh -c "$1" propr-custody "$2"
    else
        /bin/sh -c "$1" propr-custody "$2"
    fi
}

propr_custody_dir_writable() {
    propr_custody_as_worker \\
        'propr_probe="$1/.propr-custody-probe.$$"
         (: > "$propr_probe") 2>/dev/null || exit 1
         rm -f "$propr_probe"' "$1"
}

propr_custody_path_writable() {
    propr_custody_as_worker 'test -w "$1"' "$1"
}

propr_custody_resolve_gitdir() {
    if [ -f "$1/.git" ]; then
        sed -n 's/^gitdir:[[:space:]]*//p' "$1/.git" | head -n 1 | tr -d '\\n'
    elif [ -d "$1/.git" ]; then
        printf '%s' "$1/.git"
    elif [ -f "$1/HEAD" ] && [ -d "$1/objects" ]; then
        printf '%s' "$1"
    else
        printf ''
    fi
}

propr_custody_common_gitdir() {
    case "$1" in
        */.git/worktrees/*) printf '%s' "\${1%/.git/worktrees/*}/.git";;
        *) printf '%s' "$1";;
    esac
}

propr_custody_seal_tree() {
    [ -e "$1" ] || return 0
    find "$1" -exec chmod a-w {} + 2>/dev/null || true
}

propr_custody_reopen_tree() {
    [ -e "$1" ] || return 0
    chmod -R u+w "$1" 2>/dev/null || true
}

propr_custody_seal() {
    propr_custody_branch="\${PROPR_ASSIGNED_BRANCH:-}"
    [ -n "$propr_custody_branch" ] || propr_custody_refuse 'missing-assigned-branch' '(unset)'
    case "$propr_custody_branch" in
        */*) propr_custody_ref_parent="refs/heads/\${propr_custody_branch%/*}";;
        *) propr_custody_refuse 'unscoped-assigned-branch' "$propr_custody_branch";;
    esac

    propr_custody_workspace="\${PROPR_WORKSPACE:-${WORKSPACE_PATH}}"
    propr_custody_gitdir="$(propr_custody_resolve_gitdir "$propr_custody_workspace")"
    [ -n "$propr_custody_gitdir" ] \\
        || propr_custody_refuse 'missing-assigned-worktree' "$propr_custody_workspace"
    propr_custody_common="$(propr_custody_common_gitdir "$propr_custody_gitdir")"
    propr_custody_refs="$propr_custody_common/$propr_custody_ref_parent"
    propr_custody_reflogs="$propr_custody_common/logs/$propr_custody_ref_parent"

    if [ "$propr_custody_gitdir" = "$propr_custody_common" ]; then
        mkdir -p "$propr_custody_refs" "$propr_custody_reflogs" 2>/dev/null || true
        # An absent packed-refs is a writable ref store in waiting.
        [ -e "$propr_custody_common/packed-refs" ] || : > "$propr_custody_common/packed-refs" 2>/dev/null || true
        propr_custody_seal_tree "$propr_custody_common/refs"
        propr_custody_seal_tree "$propr_custody_common/logs/refs"
        chmod a-w "$propr_custody_common/packed-refs" 2>/dev/null || true
        chmod a-w "$propr_custody_common/config" 2>/dev/null || true
        propr_custody_reopen_tree "$propr_custody_refs"
        propr_custody_reopen_tree "$propr_custody_reflogs"
    fi

    # A ref directory Docker had to create for this unit arrives owned by root.
    # Opening that one directory is the whole of the widening: it is sticky, and
    # it is the unit's own.
    if [ "$(id -u)" = '0' ] && ! propr_custody_dir_writable "$propr_custody_refs"; then
        chmod 1777 "$propr_custody_refs" 2>/dev/null || true
        chmod 1777 "$propr_custody_reflogs" 2>/dev/null || true
    fi

    for propr_custody_shared in refs refs/heads logs/refs/heads; do
        if propr_custody_dir_writable "$propr_custody_common/$propr_custody_shared"; then
            propr_custody_refuse 'shared-ref-store' "$propr_custody_common/$propr_custody_shared"
        fi
    done
    for propr_custody_secret in packed-refs config; do
        if [ -e "$propr_custody_common/$propr_custody_secret" ] \\
            && propr_custody_path_writable "$propr_custody_common/$propr_custody_secret"; then
            propr_custody_refuse 'shared-git-credential' "$propr_custody_common/$propr_custody_secret"
        fi
    done
    if ! propr_custody_dir_writable "$propr_custody_refs"; then
        propr_custody_refuse 'unusable-assigned-branch' "$propr_custody_refs"
    fi

    echo "ProPR git custody sealed $propr_custody_common to $propr_custody_branch" >&2
}
`.trim();

/**
 * Sourced by the repo-setup wrapper before the agent entrypoint runs. Kept as
 * one self-contained script so tests can execute it directly against a real
 * repository instead of asserting on its text.
 */
export const GIT_CUSTODY_INSTALLER_SCRIPT = `
propr_custody_dir="\${PROPR_GIT_CUSTODY_DIR:-${GIT_CUSTODY_DIR}}"
PROPR_REAL_GIT="$(command -v git 2>/dev/null || printf '/usr/bin/git')"
export PROPR_REAL_GIT PROPR_GIT_CUSTODY_DIR="$propr_custody_dir"

mkdir -p "$propr_custody_dir/bin" "$propr_custody_dir/hooks"
printf '%s' "$PROPR_GIT_CUSTODY_LIBRARY_B64" | base64 -d > "$propr_custody_dir/custody.sh"
printf '%s' "$PROPR_GIT_CUSTODY_SEAL_B64" | base64 -d > "$propr_custody_dir/seal.sh"
printf '%s' "$PROPR_GIT_CUSTODY_PRE_COMMIT_B64" | base64 -d > "$propr_custody_dir/hooks/pre-commit"
printf '%s' "$PROPR_GIT_CUSTODY_PRE_PUSH_B64" | base64 -d > "$propr_custody_dir/hooks/pre-push"
printf '%s' "$PROPR_GIT_CUSTODY_SHIM_B64" | base64 -d > "$propr_custody_dir/bin/git"
chmod 0555 "$propr_custody_dir/hooks/pre-commit" "$propr_custody_dir/hooks/pre-push" "$propr_custody_dir/bin/git"
chmod 0444 "$propr_custody_dir/custody.sh" "$propr_custody_dir/seal.sh"

# The shim and hooks only name a refusal. The seal is the control, so it runs
# first and takes the run down with it when the git storage is not in custody.
. "$propr_custody_dir/custody.sh"
. "$propr_custody_dir/seal.sh"
propr_custody_seal

"$PROPR_REAL_GIT" config --global core.hooksPath "$propr_custody_dir/hooks" 2>/dev/null || true
PATH="$propr_custody_dir/bin:$PATH"
export PATH

unset PROPR_GIT_CUSTODY_LIBRARY_B64 PROPR_GIT_CUSTODY_SEAL_B64 PROPR_GIT_CUSTODY_PRE_COMMIT_B64 \\
    PROPR_GIT_CUSTODY_PRE_PUSH_B64 PROPR_GIT_CUSTODY_SHIM_B64
echo "ProPR git custody bound to branch \${PROPR_ASSIGNED_BRANCH}" >&2
`.trim();

const REPO_SETUP_WRAPPER_SCRIPT = `
set -e

entrypoint="$0"
setup_script="\${PROPR_WORKSPACE:-/home/node/workspace}/.propr/setup.sh"

export PROPR_WORKSPACE="\${PROPR_WORKSPACE:-/home/node/workspace}"
export PROPR_CACHE_DIR="\${PROPR_CACHE_DIR:-/tmp/git-processor/propr-cache/\${PROPR_AGENT_TYPE:-agent}}"

if [ -n "\${PROPR_GIT_CUSTODY_INSTALLER_B64:-}" ]; then
    propr_custody_installer="$(mktemp)"
    printf '%s' "$PROPR_GIT_CUSTODY_INSTALLER_B64" | base64 -d > "$propr_custody_installer"
    unset PROPR_GIT_CUSTODY_INSTALLER_B64
    . "$propr_custody_installer"
    rm -f "$propr_custody_installer"
fi

if [ "\${PROPR_REPO_SETUP:-1}" != "0" ] && [ -f "$setup_script" ]; then
    mkdir -p "$PROPR_CACHE_DIR" 2>/dev/null || true
    chown node:node "$PROPR_CACHE_DIR" 2>/dev/null || true

    echo "Running ProPR repo setup hook: $setup_script" >&2
    set +e
    if [ "$(id -u)" = "0" ] && command -v su-exec >/dev/null 2>&1 && id node >/dev/null 2>&1; then
        cd "$PROPR_WORKSPACE"
        su-exec node env HOME=/home/node USER=node LOGNAME=node /bin/bash "$setup_script" </dev/null >&2
        setup_exit=$?
    else
        cd "$PROPR_WORKSPACE"
        /bin/bash "$setup_script" </dev/null >&2
        setup_exit=$?
    fi
    set -e
    if [ "$setup_exit" -ne 0 ]; then
        echo "ProPR repo setup hook failed with exit code $setup_exit" >&2
        if [ "\${PROPR_REPO_SETUP_STRICT:-0}" = "1" ]; then
            exit "$setup_exit"
        fi
        echo "Continuing so the agent can inspect and repair repository setup/build issues" >&2
    else
        echo "ProPR repo setup hook completed" >&2
    fi
fi

exec "$entrypoint" "$@"
`.trim();

function encode(script: string): string {
    return Buffer.from(script, 'utf8').toString('base64');
}

function buildGitCustodyEnv(branchName: string): string[] {
    return [
        '-e', `PROPR_ASSIGNED_BRANCH=${branchName}`,
        '-e', `PROPR_GIT_CUSTODY_DIR=${GIT_CUSTODY_DIR}`,
        '-e', `PROPR_GIT_CUSTODY_INSTALLER_B64=${encode(GIT_CUSTODY_INSTALLER_SCRIPT)}`,
        '-e', `PROPR_GIT_CUSTODY_LIBRARY_B64=${encode(GIT_CUSTODY_LIBRARY_SCRIPT)}`,
        '-e', `PROPR_GIT_CUSTODY_SEAL_B64=${encode(GIT_CUSTODY_SEAL_SCRIPT)}`,
        '-e', `PROPR_GIT_CUSTODY_PRE_COMMIT_B64=${encode(GIT_CUSTODY_PRE_COMMIT_HOOK)}`,
        '-e', `PROPR_GIT_CUSTODY_PRE_PUSH_B64=${encode(GIT_CUSTODY_PRE_PUSH_HOOK)}`,
        '-e', `PROPR_GIT_CUSTODY_SHIM_B64=${encode(GIT_CUSTODY_GIT_SHIM)}`,
    ];
}

export interface RepoSetupConfinementOptions {
    /**
     * The assigned unit branch from `AgentTaskOptions.branchName`. Required for
     * a mutating run: without it there is no custody to enforce, so the run is
     * refused rather than allowed to proceed unconfined.
     */
    branchName?: string;
    /** Assigned disposable worktree, used to validate the explicit mount set. */
    worktreePath?: string;
    /** The single per-run evidence artifact this worker owns. */
    scopedEvidencePath?: string;
    /** False for read-only analysis and repository-inspection runs. */
    mutating?: boolean;
}

/**
 * Wrap a `docker run` argument vector with the shared repo setup hook and the
 * confined worker runtime.
 *
 * This is the single shared path every agent builder already funnels through,
 * so it is where confinement becomes a prerequisite rather than a convention:
 * a mutating run that cannot present an assigned branch, or that carries a
 * refused mount or runtime escape, never reaches the executor.
 */
export function wrapDockerRunArgsWithRepoSetup(
    dockerArgs: string[],
    dockerImage: string,
    agentType: AgentType,
    options: RepoSetupConfinementOptions = {}
): string[] {
    const imageIndex = dockerArgs.indexOf(dockerImage);
    if (imageIndex === -1) {
        throw new Error(`Cannot enable repo setup hook: Docker image '${dockerImage}' was not found in docker run arguments`);
    }

    const { branchName, worktreePath, scopedEvidencePath, mutating = false } = options;
    const assignedBranch = branchName?.trim();
    if (mutating && !assignedBranch) {
        refuseWorkerConfinement('missing-assigned-branch', `${agentType} mutating execution without an assigned unit branch`);
    }
    // An unscoped branch would make the whole of `refs/heads` the assigned
    // unit's writable ref directory, which is no custody at all.
    if (mutating && assignedBranch && !assignedBranch.includes('/')) {
        refuseWorkerConfinement('unscoped-assigned-branch', `${agentType} assigned branch ${assignedBranch}`);
    }

    // Split the shared git directory into the read-only part and the paths this
    // unit may hold writable, so the mount table — not a hook — is what decides
    // which refs the worker can move.
    const assignedGitCustody = mutating && assignedBranch && worktreePath
        ? resolveAssignedGitCustody({ worktreePath, branchName: assignedBranch })
        : null;

    const beforeImage = dockerArgs.slice(0, imageIndex);
    // Only Docker's own arguments carry mounts and runtime flags. Scanning past
    // the image would let an agent CLI argument that happens to read like
    // `--privileged` or `-v host:path` trip the guard.
    assertConfinedWorkerRuntimeArgs(beforeImage);
    assertConfinedWorkerMounts(beforeImage, { worktreePath, scopedEvidencePath, mutating, assignedGitCustody });

    const afterImage = dockerArgs.slice(imageIndex + 1);
    const cacheDir = `${DEFAULT_CACHE_ROOT}/${agentType}`;
    const gitIdentity = GIT_IDENTITIES[agentType];
    const resourceArgs = [
        ...buildAgentContainerResourceArgs(),
        ...buildConfinedWorkerCapabilityArgs(),
        ...buildConfinedWorkerCapsuleArgs(),
        ...(assignedGitCustody ? buildAssignedBranchCustodyMountArgs(assignedGitCustody, assignedBranch!) : []),
    ];
    const setupEnv = [
        '-e', `PROPR_AGENT_TYPE=${agentType}`,
        '-e', `PROPR_WORKSPACE=${WORKSPACE_PATH}`,
        '-e', `PROPR_CACHE_DIR=${cacheDir}`,
        '-e', `GIT_AUTHOR_NAME=${gitIdentity.name}`,
        '-e', `GIT_AUTHOR_EMAIL=${gitIdentity.email}`,
        '-e', `GIT_COMMITTER_NAME=${gitIdentity.name}`,
        '-e', `GIT_COMMITTER_EMAIL=${gitIdentity.email}`,
        ...(branchName?.trim() ? buildGitCustodyEnv(branchName.trim()) : []),
    ];
    const beforeImageWithSetupEnv = beforeImage[0] === 'run'
        ? [beforeImage[0], ...resourceArgs, ...setupEnv, ...beforeImage.slice(1)]
        : [...resourceArgs, ...setupEnv, ...beforeImage];

    return [
        ...beforeImageWithSetupEnv,
        '--entrypoint', '/bin/bash',
        dockerImage,
        '-lc',
        REPO_SETUP_WRAPPER_SCRIPT,
        ENTRYPOINT_PATHS[agentType],
        ...afterImage
    ];
}

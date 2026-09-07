import { availableParallelism } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MEMORY_LIMIT = '6g';
const DEFAULT_CPU_LIMIT_CEILING = 4;
const DEFAULT_CPU_LIMIT_FALLBACK = 1;
const DEFAULT_PIDS_LIMIT = '512';
const MIN_MEMORY_LIMIT_BYTES = 6n * 1024n * 1024n;
const MIN_CPU_LIMIT = 0.01;

const DOCKER_MEMORY_LIMIT_PATTERN = /^([1-9]\d*)([bkmg])?$/i;
const DOCKER_CPU_LIMIT_PATTERN = /^(?:0?\.\d+|[1-9]\d*(?:\.\d+)?)$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export interface AgentContainerResourceEnvironment {
    AGENT_CONTAINER_MEMORY_LIMIT?: string;
    AGENT_CONTAINER_CPU_LIMIT?: string;
    AGENT_CONTAINER_PIDS_LIMIT?: string;
}

function configuredValue(value: string | undefined, fallback: string): string {
    return value?.trim() || fallback;
}

function validateMemoryLimit(value: string): string {
    const match = DOCKER_MEMORY_LIMIT_PATTERN.exec(value);
    let memoryBytes: bigint | undefined;

    if (match) {
        const amount = BigInt(match[1]);
        switch (match[2]?.toLowerCase()) {
            case 'g':
                memoryBytes = amount * 1024n * 1024n * 1024n;
                break;
            case 'm':
                memoryBytes = amount * 1024n * 1024n;
                break;
            case 'k':
                memoryBytes = amount * 1024n;
                break;
            case 'b':
            case undefined:
                memoryBytes = amount;
                break;
        }
    }

    if (memoryBytes === undefined || memoryBytes < MIN_MEMORY_LIMIT_BYTES) {
        throw new Error(`AGENT_CONTAINER_MEMORY_LIMIT must be a Docker memory value of at least 6m, got: ${value}`);
    }
    return value.toLowerCase();
}

function validateCpuLimit(value: string): string {
    if (!DOCKER_CPU_LIMIT_PATTERN.test(value) || !Number.isFinite(Number(value)) || Number(value) < MIN_CPU_LIMIT) {
        throw new Error(`AGENT_CONTAINER_CPU_LIMIT must be at least ${MIN_CPU_LIMIT} CPUs, got: ${value}`);
    }
    return value;
}

/**
 * Keep the default agent quota within the CPUs actually available to the worker.
 *
 * The normal deployment runs the worker against the same host Docker daemon, so
 * Node's cgroup-aware availableParallelism() reflects the capacity Docker will
 * accept. An explicit AGENT_CONTAINER_CPU_LIMIT remains authoritative. The
 * conservative one-CPU fallback prevents a failed probe from recreating the
 * original failure mode (asking a small Docker host for four CPUs).
 */
export function resolveDefaultAgentCpuLimit(detectedCapacity: number = availableParallelism()): string {
    if (!Number.isSafeInteger(detectedCapacity) || detectedCapacity < 1) {
        return String(DEFAULT_CPU_LIMIT_FALLBACK);
    }
    return String(Math.min(DEFAULT_CPU_LIMIT_CEILING, detectedCapacity));
}

function validatePidsLimit(value: string): string {
    if (!POSITIVE_INTEGER_PATTERN.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`AGENT_CONTAINER_PIDS_LIMIT must be a positive integer, got: ${value}`);
    }
    return value;
}

/**
 * Return the common Docker resource boundary for every coding-agent run.
 *
 * Memory and memory+swap use the same ceiling so an agent cannot move its
 * allocation into host swap after reaching the memory limit. Operators can
 * tune the limits for unusually large repositories, but malformed values fail
 * before Docker starts instead of silently leaving a container unbounded.
 */
export function buildAgentContainerResourceArgs(
    environment: AgentContainerResourceEnvironment = process.env,
    detectedCpuCapacity?: number,
): string[] {
    const memory = validateMemoryLimit(configuredValue(environment.AGENT_CONTAINER_MEMORY_LIMIT, DEFAULT_MEMORY_LIMIT));
    const cpus = validateCpuLimit(configuredValue(
        environment.AGENT_CONTAINER_CPU_LIMIT,
        resolveDefaultAgentCpuLimit(detectedCpuCapacity),
    ));
    const pids = validatePidsLimit(configuredValue(environment.AGENT_CONTAINER_PIDS_LIMIT, DEFAULT_PIDS_LIMIT));

    return [
        '--memory', memory,
        '--memory-swap', memory,
        '--cpus', cpus,
        '--pids-limit', pids,
    ];
}

/* ------------------------------------------------------------------------- *
 * Confined worker runtime policy
 *
 * A git worktree is not a sandbox: the historical `/tmp/git-processor:rw`
 * mount handed every agent the primary checkout and every other task's
 * worktree. The policy below is the single place that decides which host
 * resources a mutating worker may see, what capabilities it keeps, and which
 * runtime escapes are refused. Path capability lives here; branch capability
 * is a separate custody control in the shared git setup path.
 * ------------------------------------------------------------------------- */

export const WORKER_CONFINEMENT_REFUSAL_PREFIX = 'propr-worker-confinement-refused';

export type WorkerConfinementRefusalReason =
    | 'primary-checkout'
    | 'unrelated-worktree'
    | 'controller-state'
    | 'attestation-store'
    | 'authoritative-evidence'
    | 'protected-state-import'
    | 'out-of-scope-credential'
    | 'stage-credential'
    | 'container-control-socket'
    | 'container-volume-import'
    | 'privileged-runtime'
    | 'network-outside-policy'
    | 'unconfined-security-profile'
    | 'missing-assigned-worktree'
    | 'missing-assigned-branch'
    | 'shared-git-metadata'
    | 'unscoped-assigned-branch';

/**
 * Refuse a confinement violation by name. Callers raise this before the
 * `docker run` argument vector is handed to the executor, so the refusal
 * happens before the attempt can take effect rather than after.
 */
export function refuseWorkerConfinement(reason: WorkerConfinementRefusalReason, detail: string): never {
    throw new Error(`${WORKER_CONFINEMENT_REFUSAL_PREFIX}:${reason} ${detail}`);
}

/** True when `error` is a confinement refusal, optionally of one specific class. */
export function isWorkerConfinementRefusal(error: unknown, reason?: WorkerConfinementRefusalReason): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith(reason
        ? `${WORKER_CONFINEMENT_REFUSAL_PREFIX}:${reason} `
        : `${WORKER_CONFINEMENT_REFUSAL_PREFIX}:`);
}

/** Existing runtime configuration for the shared git storage roots. */
export function resolveClonesBasePath(): string {
    return process.env.GIT_CLONES_BASE_PATH || '/tmp/git-processor/clones';
}

export function resolveWorktreesBasePath(): string {
    return process.env.GIT_WORKTREES_BASE_PATH || '/tmp/git-processor/worktrees';
}

/**
 * Controller state the ProPR control plane keeps on disk. A worker that could
 * mount any of these could read queue state, logs and managed repositories, or
 * rewrite the record of its own run.
 */
const CONTROLLER_STATE_ROOTS = [
    '/usr/src/app/data',
    '/usr/src/app/logs',
    '/usr/src/app/repos',
    '/app/data',
    '/app/logs',
    '/app/repos',
];

/**
 * The root-owned Ezer admission marker the entrypoint writes before dropping
 * privileges. Mounting over it would let a worker forge its own attestation.
 */
const ATTESTATION_STORE_ROOTS = ['/run/propr'];

/** Persisted transcripts and execution logs are the authoritative evidence of a run. */
const AUTHORITATIVE_EVIDENCE_ROOTS = ['/tmp/git-processor/propr-cache/transcripts'];

/** Host credential material that is out of scope for any agent container. */
const OUT_OF_SCOPE_CREDENTIAL_SEGMENTS = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.docker',
    '.kube',
    '.netrc',
    '.npmrc',
];

const CONTAINER_CONTROL_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];

function normalizeHostPath(hostPath: string): string {
    return path.posix.normalize(hostPath).replace(/\/+$/, '') || '/';
}

function isWithin(candidate: string, root: string): boolean {
    const normalizedRoot = normalizeHostPath(root);
    return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

/**
 * Classify a host path a mutating worker asked to mount. Returns `null` when
 * the path carries no locked refusal class; the caller still applies the
 * default-deny allow-set so an unclassified path cannot slip through.
 */
export function classifyConfinementRefusal(
    hostPath: string,
    assignedWorktreePath?: string,
): WorkerConfinementRefusalReason | null {
    const candidate = normalizeHostPath(hostPath);
    const assigned = assignedWorktreePath ? normalizeHostPath(assignedWorktreePath) : null;
    const classes: Array<[WorkerConfinementRefusalReason, string[]]> = [
        ['primary-checkout', [resolveClonesBasePath()]],
        ['unrelated-worktree', [resolveWorktreesBasePath()]],
        ['controller-state', CONTROLLER_STATE_ROOTS],
        ['attestation-store', ATTESTATION_STORE_ROOTS],
        ['authoritative-evidence', AUTHORITATIVE_EVIDENCE_ROOTS],
        ['container-control-socket', CONTAINER_CONTROL_SOCKETS],
    ];

    // A path inside a locked root is named by that root. Checking containment
    // first keeps the most specific class winning over a broad mount that
    // happens to sit above several roots at once.
    for (const [reason, roots] of classes) {
        if (!roots.some(root => isWithin(candidate, root))) continue;
        if (reason === 'unrelated-worktree' && assigned && isWithin(candidate, assigned)) return null;
        return reason;
    }
    // A mount that merely contains a locked root is named by the first root it
    // exposes, so the blanket git-processor mount reports the checkout.
    for (const [reason, roots] of classes) {
        if (roots.some(root => isWithin(normalizeHostPath(root), candidate))) return reason;
    }

    const segments = candidate.split('/');
    if (OUT_OF_SCOPE_CREDENTIAL_SEGMENTS.some(segment => segments.includes(segment))) {
        return 'out-of-scope-credential';
    }
    return null;
}

/**
 * Credentials that belong to a delivery stage rather than to a worker run.
 * The worker keeps the scoped GitHub token and the model-provider key it needs;
 * publishing, deployment and signing material is refused by name.
 */
const STAGE_CREDENTIAL_PATTERN = new RegExp(
    '^(?:'
    + 'PROPR_STAGE_.*'
    + '|.*STAG(?:E|ING)_.*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|CREDENTIALS)'
    + '|NPM_TOKEN|NODE_AUTH_TOKEN'
    + '|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)'
    + '|(?:GOOGLE|GCP)_(?:APPLICATION_CREDENTIALS|SERVICE_ACCOUNT_KEY)'
    + '|AZURE_(?:CLIENT_SECRET|TENANT_ID)'
    + '|(?:DOCKERHUB|DOCKER)_(?:TOKEN|PASSWORD)'
    + '|(?:CLOUDFLARE|VERCEL|NETLIFY|FLY)_(?:API_)?TOKEN'
    + '|(?:GPG|COSIGN|SIGSTORE)_(?:PRIVATE_KEY|PASSWORD|PASSPHRASE)'
    + ')$',
);

/** Protected control-plane state must never be imported into a worker as environment. */
const PROTECTED_STATE_IMPORT_PATTERN = /^(?:PROPR_EZER_[A-Z0-9_]*|PROPR_ADMISSION_[A-Z0-9_]*|PROPR_CONTROLLER_[A-Z0-9_]*)$/;

export function classifyEnvironmentRefusal(name: string): WorkerConfinementRefusalReason | null {
    const normalized = name.toUpperCase();
    if (STAGE_CREDENTIAL_PATTERN.test(normalized)) return 'stage-credential';
    if (PROTECTED_STATE_IMPORT_PATTERN.test(normalized)) return 'protected-state-import';
    return null;
}

/**
 * Refuse per-execution environment that would hand a worker a stage credential
 * or import protected control-plane state. The Ezer admission marker is still
 * delivered by the daemon caller, which this policy does not touch: it is
 * injected outside the per-execution `environment` map this guard inspects.
 */
export function assertConfinedWorkerEnvironment(
    sources: Array<Record<string, string> | undefined>,
): void {
    for (const source of sources) {
        if (!source) continue;
        for (const name of Object.keys(source)) {
            const refusal = classifyEnvironmentRefusal(name);
            if (refusal) refuseWorkerConfinement(refusal, name);
        }
    }
}

/**
 * Read one Docker CLI flag and its value, accepting both `--flag value` and the
 * inline `--flag=value` spelling. Matching only the spaced form would let the
 * same argument arrive unread, which is how a guard becomes advisory.
 */
function readFlagValue(
    dockerArgs: readonly string[],
    index: number,
): { flag: string; value: string | undefined } {
    const arg = dockerArgs[index];
    const separator = arg.indexOf('=');
    return separator === -1
        ? { flag: arg, value: dockerArgs[index + 1] }
        : { flag: arg.slice(0, separator), value: arg.slice(separator + 1) };
}

/**
 * Runtime escapes that are refused regardless of which builder produced them.
 * `--network bridge` remains the existing runtime policy; this guard only
 * refuses arguments that reach *past* that policy. It deliberately defines no
 * egress allowlist, because the locked inputs define none.
 */
export function assertConfinedWorkerRuntimeArgs(dockerArgs: readonly string[]): void {
    for (let index = 0; index < dockerArgs.length; index++) {
        const { flag, value: flagValue } = readFlagValue(dockerArgs, index);
        const value = flagValue ?? '';

        if (flag === '--privileged') refuseWorkerConfinement('privileged-runtime', '--privileged');
        if (flag === '--device' || flag === '--device-cgroup-rule') {
            refuseWorkerConfinement('privileged-runtime', `${flag} ${value}`);
        }
        // `container:<name>` joins another container's namespace, which reaches
        // the controller's processes and IPC exactly as `host` reaches the VM's.
        if ((flag === '--pid' || flag === '--ipc' || flag === '--uts' || flag === '--userns' || flag === '--cgroupns')
            && (value === 'host' || value.startsWith('container:'))) {
            refuseWorkerConfinement('privileged-runtime', `${flag} ${value}`);
        }
        // `--net` is the CLI's own alias for `--network`; reading only the long
        // spelling would leave `--net host` outside the egress policy.
        if ((flag === '--network' || flag === '--net') && value !== 'bridge' && value !== 'none') {
            refuseWorkerConfinement('network-outside-policy', `${flag} ${value}`);
        }
        // Docker accepts both `profile=unconfined` and the legacy `profile:unconfined`.
        if (flag === '--security-opt' && /(?:seccomp|apparmor)[=:]unconfined/.test(value)) {
            refuseWorkerConfinement('unconfined-security-profile', `--security-opt ${value}`);
        }
        if (flag === '--cap-add' && !CONFINED_WORKER_CAPABILITIES.includes(value.toUpperCase())) {
            refuseWorkerConfinement('privileged-runtime', `--cap-add ${value}`);
        }
        // `--volumes-from` inherits another container's whole mount table. It
        // names no host path at all, so the mount classifier never sees the
        // primary checkout or the controller state it can carry in.
        if (flag === '--volumes-from') {
            refuseWorkerConfinement('container-volume-import', `--volumes-from ${value}`);
        }
    }
}

/**
 * The only capabilities a confined worker keeps. Docker's default set is
 * dropped wholesale; these are re-added because the agent entrypoints repair
 * bind-mount ownership and then `su-exec` down to uid 1000. Changing user
 * clears the effective set, so the model process itself holds none of them,
 * and the bounding set makes NET_RAW, MKNOD, SYS_CHROOT and friends
 * unreachable for the whole run.
 */
export const CONFINED_WORKER_CAPABILITIES = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID'];

/**
 * Writable scratch inside an otherwise read-only capsule. Each entry exists
 * because an entrypoint or agent CLI provably writes there: `/run` holds the
 * Ezer admission marker, `/home/node/bin` the `gh` wrapper symlink that the
 * entrypoints create under `set -e`, and the rest are per-agent caches and XDG
 * directories that the builders already point into `/tmp`.
 */
export const CONFINED_WORKER_TMPFS_PATHS = [
    '/tmp',
    '/run',
    '/home/node/bin',
    '/home/node/.cache',
    '/home/node/.config',
    '/home/node/.npm',
    '/home/node/.local/state',
];

/**
 * The read-only capsule plus its explicit writable scratch. `git config
 * --global` is redirected into the writable scratch so the entrypoints keep
 * working when `$HOME` itself is read-only.
 *
 * The scratch is sticky (`1777`), which matters for `/run`: the entrypoint
 * creates the root-owned `/run/propr` admission marker there, and the sticky
 * bit stops the unprivileged model from unlinking or replacing a directory it
 * does not own.
 */
export function buildConfinedWorkerCapsuleArgs(): string[] {
    return [
        '--read-only',
        ...CONFINED_WORKER_TMPFS_PATHS.flatMap(target => ['--tmpfs', `${target}:rw,mode=1777`]),
        '-e', 'GIT_CONFIG_GLOBAL=/tmp/propr-git-global.config',
    ];
}

/** Capability confinement shared by every agent builder. */
export function buildConfinedWorkerCapabilityArgs(): string[] {
    return [
        '--cap-drop', 'ALL',
        ...CONFINED_WORKER_CAPABILITIES
            .filter(capability => capability !== 'CHOWN')
            .flatMap(capability => ['--cap-add', capability]),
    ];
}

/**
 * Resolve the git storage the assigned worktree genuinely needs.
 *
 * A linked worktree keeps its administrative directory and its object database
 * inside the clone's `.git`, so that directory has to travel with the worktree.
 * The clone's *working tree* does not, and neither does any sibling worktree —
 * which is exactly what the old blanket `/tmp/git-processor` mount handed over.
 */
function readWorktreeGitPointer(
    worktreePath: string,
    readFile: (target: string) => string,
): string | null {
    let pointer: string;
    try {
        pointer = readFile(path.join(worktreePath, '.git'));
    } catch {
        return null;
    }
    const gitdir = /gitdir:\s*(.+)/.exec(pointer)?.[1]?.trim();
    return gitdir?.startsWith('/') ? gitdir : null;
}

export function resolveAssignedWorktreeGitDir(
    worktreePath: string,
    readFile: (target: string) => string = target => fs.readFileSync(target, 'utf8'),
): string | null {
    const gitdir = readWorktreeGitPointer(worktreePath, readFile);
    if (!gitdir) return null;
    // `<clone>/.git/worktrees/<unit>` — the shared object store is its grandparent.
    const marker = `${path.posix.sep}.git${path.posix.sep}`;
    const markerIndex = gitdir.indexOf(marker);
    return markerIndex === -1 ? gitdir : gitdir.slice(0, markerIndex + marker.length - 1);
}

/**
 * The assigned unit's own administrative directory,
 * `<clone>/.git/worktrees/<unit>`. It holds this unit's index, HEAD and HEAD
 * reflog and nothing another unit depends on, so it is the one part of the
 * shared git directory that stays writable without widening custody.
 */
export function resolveAssignedWorktreeUnitDir(
    worktreePath: string,
    readFile: (target: string) => string = target => fs.readFileSync(target, 'utf8'),
): string | null {
    const gitdir = readWorktreeGitPointer(worktreePath, readFile);
    return gitdir?.includes(`${path.posix.sep}.git${path.posix.sep}worktrees${path.posix.sep}`) ? gitdir : null;
}

/**
 * The loose-ref directory and reflog directory that hold the assigned unit
 * branch, e.g. `refs/heads/7` and `logs/refs/heads/7` for `7/claude-s16-t01`.
 *
 * Git updates a ref by creating `<ref>.lock` beside it and renaming, so the
 * smallest writable unit the files ref backend can express is the directory
 * that contains the ref. Returning `null` for an unscoped branch name is
 * deliberate: a flat branch would make the whole of `refs/heads` writable,
 * which is not custody at all.
 */
export function resolveAssignedBranchRefPaths(
    sharedGitDir: string,
    branchName: string,
): { refDir: string; logDir: string } | null {
    const branch = branchName.trim().replace(/^\/+|\/+$/g, '');
    const separator = branch.lastIndexOf('/');
    if (separator <= 0) return null;
    const parent = branch.slice(0, separator);
    return {
        refDir: path.posix.join(sharedGitDir, 'refs', 'heads', parent),
        logDir: path.posix.join(sharedGitDir, 'logs', 'refs', 'heads', parent),
    };
}

/**
 * The shared git directory a mutating worker sees, and the exact paths inside
 * it that the assigned unit may hold writable.
 *
 * This is the custody split that a hook or a PATH shim cannot express: it is
 * applied to the container's mount table, so it holds under `/usr/bin/git`,
 * under `--no-verify`, under plumbing such as `git update-ref`, and under a
 * plain redirect into `.git/refs`.
 */
export interface AssignedGitCustody {
    /** `<clone>/.git`, shared with the primary checkout and every sibling unit. */
    sharedGitDir: string;
    /** Everything under {@link sharedGitDir} this unit may mount read-write. */
    writablePaths: string[];
}

export function resolveAssignedGitCustody(options: {
    worktreePath: string;
    branchName?: string;
    readFile?: (target: string) => string;
}): AssignedGitCustody | null {
    const { worktreePath, branchName, readFile = (target: string) => fs.readFileSync(target, 'utf8') } = options;
    if (!worktreePath) return null;
    const sharedGitDir = resolveAssignedWorktreeGitDir(worktreePath, readFile);
    if (!sharedGitDir) return null;

    const unitAdminDir = resolveAssignedWorktreeUnitDir(worktreePath, readFile);
    const branchPaths = branchName ? resolveAssignedBranchRefPaths(sharedGitDir, branchName) : null;
    return {
        sharedGitDir,
        writablePaths: [
            // Objects are content addressed: writing one cannot move a ref or
            // rewrite another unit's history, so the shared store stays usable.
            path.posix.join(sharedGitDir, 'objects'),
            ...(unitAdminDir ? [unitAdminDir] : []),
            ...(branchPaths ? [branchPaths.refDir, branchPaths.logDir] : []),
        ],
    };
}

/**
 * Explicit mounts for a mutating worker, replacing the blanket git-processor
 * mount. Every entry is named; anything else the caller adds still has to
 * survive {@link assertConfinedWorkerMounts}.
 *
 * The shared git directory travels read-only. A linked worktree cannot function
 * without it, but handing it over read-write also hands over `refs/heads`,
 * `packed-refs` and the `config` that carries the push credential — which is
 * why the branch custody installed inside the worker used to be bypassable by
 * plumbing and direct ref writes. The unit's own writable surface is mounted
 * back on top by name.
 */
export function buildAssignedWorktreeMountArgs(options: {
    worktreePath: string;
    agentType: string;
    resolveGitDir?: (worktreePath: string) => string | null;
    resolveUnitDir?: (worktreePath: string) => string | null;
}): string[] {
    const {
        worktreePath,
        agentType,
        resolveGitDir = resolveAssignedWorktreeGitDir,
        resolveUnitDir = resolveAssignedWorktreeUnitDir,
    } = options;
    if (!worktreePath) refuseWorkerConfinement('missing-assigned-worktree', 'no assigned worktree path');
    const cacheDir = `/tmp/git-processor/propr-cache/${agentType}`;
    const sharedGitDir = resolveGitDir(worktreePath);
    const unitAdminDir = sharedGitDir ? resolveUnitDir(worktreePath) : null;
    const objectStore = sharedGitDir ? path.posix.join(sharedGitDir, 'objects') : null;
    return [
        ...(sharedGitDir ? ['-v', `${sharedGitDir}:${sharedGitDir}:ro`] : []),
        ...(objectStore ? ['-v', `${objectStore}:${objectStore}:rw`] : []),
        ...(unitAdminDir ? ['-v', `${unitAdminDir}:${unitAdminDir}:rw`] : []),
        '-v', `${cacheDir}:${cacheDir}:rw`,
    ];
}

/**
 * The writable ref and reflog mounts for the assigned unit branch. Kept apart
 * from {@link buildAssignedWorktreeMountArgs} because only the shared git setup
 * path knows the assigned branch; the per-agent builders do not.
 */
export function buildAssignedBranchCustodyMountArgs(custody: AssignedGitCustody, branchName: string): string[] {
    const branchPaths = resolveAssignedBranchRefPaths(custody.sharedGitDir, branchName);
    if (!branchPaths) refuseWorkerConfinement('unscoped-assigned-branch', branchName);
    return [
        '-v', `${branchPaths.refDir}:${branchPaths.refDir}:rw`,
        '-v', `${branchPaths.logDir}:${branchPaths.logDir}:rw`,
    ];
}

interface ParsedMount {
    hostPath: string;
    containerPath: string;
    mode: string;
}

/** `-v /host:/container` and `--volume=/host:/container` are the same mount. */
function parseVolumeSpec(spec: string): ParsedMount | null {
    const parts = spec.split(':');
    if (parts.length < 2 || !parts[0].startsWith('/')) return null;
    return { hostPath: parts[0], containerPath: parts[1], mode: parts[2] ?? 'rw' };
}

/**
 * `--mount type=bind,source=...,target=...` is the same bind mount as `-v`,
 * spelled the way the Docker CLI documents first. Reading only `-v` would leave
 * the blanket git-processor mount one alternate spelling away from returning —
 * the same class of bypass as reaching past a git shim by naming `/usr/bin/git`.
 */
function parseMountSpec(spec: string): ParsedMount | null {
    const fields = new Map<string, string>();
    for (const field of spec.split(',')) {
        const separator = field.indexOf('=');
        const key = (separator === -1 ? field : field.slice(0, separator)).trim().toLowerCase();
        if (key) fields.set(key, separator === -1 ? 'true' : field.slice(separator + 1).trim());
    }
    // An absent `type` defaults to a named volume, which carries no host path.
    if ((fields.get('type') ?? 'volume') !== 'bind') return null;
    const hostPath = fields.get('source') ?? fields.get('src');
    const containerPath = fields.get('target') ?? fields.get('destination') ?? fields.get('dst');
    if (!hostPath?.startsWith('/') || !containerPath) return null;
    const readOnly = ['readonly', 'ro'].some(key => {
        const value = fields.get(key);
        return value !== undefined && value !== 'false';
    });
    return { hostPath, containerPath, mode: readOnly ? 'ro' : 'rw' };
}

export function parseDockerMountArgs(dockerArgs: readonly string[]): ParsedMount[] {
    const mounts: ParsedMount[] = [];
    for (let index = 0; index < dockerArgs.length; index++) {
        const { flag, value } = readFlagValue(dockerArgs, index);
        if (!value) continue;
        let mount: ParsedMount | null = null;
        if (flag === '-v' || flag === '--volume') mount = parseVolumeSpec(value);
        else if (flag === '--mount') mount = parseMountSpec(value);
        if (mount) mounts.push(mount);
    }
    return mounts;
}

/**
 * Refuse, by name, every mount a mutating worker must not receive.
 *
 * The assigned worktree, the agent's own cache and configuration, and the
 * shared git storage a linked worktree genuinely needs are permitted; the
 * clone's working tree, sibling worktrees, controller state, the attestation
 * marker, persisted evidence, the container control socket and host credential
 * directories are each refused under their own class name.
 *
 * Shared git storage is permitted read-only, plus the named writable paths in
 * {@link AssignedGitCustody}. Any other writable exposure of the shared git
 * directory — `refs`, `packed-refs`, `config`, `hooks`, a sibling unit's
 * administrative directory, or the whole directory at once — is refused as
 * `shared-git-metadata`, because it would put the branch custody enforced
 * inside the worker back within reach of plumbing and direct ref writes.
 */
export function assertConfinedWorkerMounts(
    dockerArgs: readonly string[],
    context: {
        worktreePath?: string;
        /** Shared git storage split into its read-only and writable parts. */
        assignedGitCustody?: AssignedGitCustody | null;
        /**
         * The single per-run evidence artifact this worker owns (its own
         * transcript file). The surrounding evidence store stays refused, so a
         * worker cannot read or rewrite another run's record.
         */
        scopedEvidencePath?: string;
        /**
         * Shared git storage for the assigned worktree, as resolved when the
         * mounts were built. Falls back to resolving from the worktree pointer.
         */
        sharedGitDirPath?: string | null;
        /**
         * A mutating worker is refused any mount of a locked class. Read-only
         * analysis keeps its existing ability to inspect a checkout it mounts
         * `ro`; only writable access is refused there.
         */
        mutating?: boolean;
    },
): void {
    const assigned = context.worktreePath ? normalizeHostPath(context.worktreePath) : undefined;
    const sharedGitDir = context.sharedGitDirPath !== undefined
        ? context.sharedGitDirPath
        : (context.assignedGitCustody?.sharedGitDir
            ?? (context.worktreePath ? resolveAssignedWorktreeGitDir(context.worktreePath) : null));
    // Without resolved branch custody the writable set still has to be the one
    // `buildAssignedWorktreeMountArgs` actually produces: the content-addressed
    // object store *and* this unit's own administrative directory. Omitting the
    // latter made the guard refuse the builder's own mount set as shared
    // metadata, which fails every run that has no assigned branch to resolve.
    const writableGitPaths = (context.assignedGitCustody?.writablePaths ?? [
        ...(sharedGitDir ? [path.posix.join(sharedGitDir, 'objects')] : []),
        ...(context.worktreePath
            ? [resolveAssignedWorktreeUnitDir(context.worktreePath)].filter((unit): unit is string => unit !== null)
            : []),
    ]).map(normalizeHostPath);
    const scopedEvidence = context.scopedEvidencePath ? normalizeHostPath(context.scopedEvidencePath) : undefined;
    for (const mount of parseDockerMountArgs(dockerArgs)) {
        const hostPath = normalizeHostPath(mount.hostPath);
        const readOnly = mount.mode.split(',').includes('ro');
        if (assigned && isWithin(hostPath, assigned)) continue;
        if (sharedGitDir && isWithin(hostPath, normalizeHostPath(sharedGitDir))) {
            if (readOnly) continue;
            if (writableGitPaths.some(writable => isWithin(hostPath, writable))) continue;
            refuseWorkerConfinement('shared-git-metadata', `${mount.hostPath} -> ${mount.containerPath}:${mount.mode}`);
        }
        if (scopedEvidence && hostPath === scopedEvidence) continue;
        if (!context.mutating && readOnly) continue;
        const refusal = classifyConfinementRefusal(hostPath, assigned);
        if (refusal) refuseWorkerConfinement(refusal, `${mount.hostPath} -> ${mount.containerPath}:${mount.mode}`);
    }
}

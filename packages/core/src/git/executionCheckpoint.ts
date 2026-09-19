/**
 * Partial-work checkpoints for admitted story executions.
 *
 * An admitted execution that stops before success (turn limit, lease/timeout,
 * or any other agent failure) must never publish: no feature-branch push, no
 * PR, no success. Its worktree changes are still evidence Ezer may hand to a
 * fresh attempt, so they are preserved as one labelled commit on a dedicated
 * non-branch ref (`refs/propr/checkpoints/...`). A later signed execution may
 * name that exact ref and SHA in `recovery.checkpoint`; its worktree then
 * starts from the checkpoint's in-scope changes as uncommitted work.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { requireStoryExecutionContract, type StoryExecutionContract } from '../admission/storyExecutionContract.js';
import { EXECUTION_CHECKPOINT_REF_PREFIX, requireExecutionCheckpointRef } from '../admission/executionRecoveryContext.js';
import { createHooklessGit, DISABLED_GIT_HOOKS_PATH } from './hooklessGit.js';
import { redactAuthenticatedGitUrl, setupAuthenticatedRemote } from './repoBranching.js';

const runFile = promisify(execFile);
const NUL = '\0';
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const TASK_SEGMENT_UNSAFE = /[^A-Za-z0-9._-]+/g;
const MAX_ERROR_CHARACTERS = 2_000;

export { EXECUTION_CHECKPOINT_REF_PREFIX };

export type ExecutionFailureClassification = 'max_turns' | 'timeout' | 'agent_error';

/** Durable terminal evidence for a stopped admitted execution. Never a publication. */
export interface ExecutionCheckpointRecord {
    status: 'preserved' | 'no_changes' | 'failed';
    failureClassification: ExecutionFailureClassification;
    publication: 'none';
    baseSha: string;
    featureBranch: string;
    ref?: string;
    sha?: string;
    /** Every changed path in the worktree, in or out of scope. Names only. */
    changedPaths: string[];
    /** Changed paths outside `allowedPaths`: reported by name, never committed or pushed. */
    outOfScopePaths: string[];
    error?: string;
}

export interface PreserveExecutionCheckpointOptions {
    worktreePath: string;
    execution: StoryExecutionContract;
    taskId: string;
    failureClassification: ExecutionFailureClassification;
    author: { name: string; email: string };
    remote?: string;
    repoUrl?: string;
    authToken?: string;
}

export interface RestoredExecutionCheckpoint {
    ref: string;
    sha: string;
    restoredPaths: string[];
    ignoredPaths: string[];
}

type GitEnvironment = Record<string, string | undefined>;

async function git(cwd: string, args: string[], env?: GitEnvironment): Promise<string> {
    const { stdout } = await runFile('git', ['-c', `core.hooksPath=${DISABLED_GIT_HOOKS_PATH}`, ...args], {
        cwd, env: env ?? process.env, maxBuffer: MAX_GIT_OUTPUT_BYTES,
    });
    return stdout;
}

function splitNul(output: string): string[] {
    return output.split(NUL).filter(Boolean);
}

/** The exact checkpoint ref for one task attempt; distinct from every publication branch. */
export function executionCheckpointRef(featureBranch: string, taskId: string): string {
    const taskSegment = taskId.replace(TASK_SEGMENT_UNSAFE, '-').replace(/^[.-]+|[.-]+$/g, '');
    if (!taskSegment) throw Error('EXECUTION_CHECKPOINT_TASK_INVALID');
    return requireExecutionCheckpointRef(`${EXECUTION_CHECKPOINT_REF_PREFIX}${featureBranch}/${taskSegment}`);
}

function checkpointMessage(options: PreserveExecutionCheckpointOptions, preservedPaths: string[]): string {
    return [
        `chore(checkpoint): preserve partial work for ${options.execution.featureBranch}`,
        '',
        'NOT FOR PUBLICATION. ProPR preserved this incomplete admitted execution so a later',
        'attempt can continue from it. It is not a candidate, never a pull request, and',
        'carries no acceptance.',
        '',
        `ProPR-Checkpoint-Task: ${options.taskId}`,
        `ProPR-Checkpoint-Failure: ${options.failureClassification}`,
        `ProPR-Checkpoint-Base: ${options.execution.baseSha}`,
        `ProPR-Checkpoint-Paths: ${preservedPaths.length}`,
    ].join('\n');
}

/**
 * Every path whose worktree content differs from the admitted base: tracked changes
 * and deletions plus untracked non-ignored files. Names only; no content is hashed
 * into the object store, so an out-of-scope file never becomes a blob here.
 */
async function listChangedPaths(worktreePath: string, env: GitEnvironment): Promise<string[]> {
    const tracked = splitNul(await git(worktreePath, ['diff', '--name-only', '--no-renames', '-z'], env));
    const untracked = splitNul(await git(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], env));
    return [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Commits the in-scope worktree changes (paths in `allowedPaths`: tracked, staged,
 * and untracked non-ignored) on top of the admitted base using a private index, then
 * pushes only the checkpoint ref. Out-of-scope changes are reported by name only and
 * never enter the checkpoint tree, so nothing outside the contract is published.
 * The worktree, its index, and the feature branch are left untouched.
 */
export async function preserveExecutionCheckpoint(options: PreserveExecutionCheckpointOptions): Promise<ExecutionCheckpointRecord> {
    const execution = requireStoryExecutionContract(options.execution);
    const remote = options.remote ?? 'origin';
    const record: ExecutionCheckpointRecord = {
        status: 'failed', failureClassification: options.failureClassification, publication: 'none',
        baseSha: execution.baseSha, featureBranch: execution.featureBranch, changedPaths: [], outOfScopePaths: [],
    };
    const indexDirectory = await mkdtemp(join(tmpdir(), 'propr-checkpoint-index-'));
    try {
        const env: GitEnvironment = { ...process.env, GIT_INDEX_FILE: join(indexDirectory, 'index') };
        await git(options.worktreePath, ['read-tree', execution.baseSha], env);
        record.changedPaths = await listChangedPaths(options.worktreePath, env);
        const allowed = new Set(execution.allowedPaths);
        record.outOfScopePaths = record.changedPaths.filter(path => !allowed.has(path));
        const inScopePaths = record.changedPaths.filter(path => allowed.has(path));
        // Stage only exact in-scope paths; literal pathspecs keep a path from acting as a glob.
        if (inScopePaths.length > 0)
            await git(options.worktreePath, ['--literal-pathspecs', 'add', '-A', '--', ...inScopePaths], env);
        const tree = (await git(options.worktreePath, ['write-tree'], env)).trim();
        const baseTree = (await git(options.worktreePath, ['rev-parse', `${execution.baseSha}^{tree}`])).trim();
        if (tree === baseTree) {
            record.status = 'no_changes';
            return record;
        }

        const ref = executionCheckpointRef(execution.featureBranch, options.taskId);
        const identity: GitEnvironment = {
            ...process.env,
            GIT_AUTHOR_NAME: options.author.name, GIT_AUTHOR_EMAIL: options.author.email,
            GIT_COMMITTER_NAME: options.author.name, GIT_COMMITTER_EMAIL: options.author.email,
        };
        const sha = (await git(options.worktreePath, ['commit-tree', '--no-gpg-sign', tree, '-p', execution.baseSha,
            '-m', checkpointMessage(options, inScopePaths)], identity)).trim();
        record.ref = ref;
        record.sha = sha;

        if (options.repoUrl && options.authToken)
            await setupAuthenticatedRemote(createHooklessGit(options.worktreePath), options.repoUrl, options.authToken);
        // Never forced: an existing checkpoint for this exact task attempt is kept, not replaced.
        await git(options.worktreePath, ['push', remote, `${sha}:${ref}`]);
        const remoteSha = (await git(options.worktreePath, ['ls-remote', remote, ref])).trim().split(/\s+/)[0];
        if (remoteSha !== sha) throw Error('EXECUTION_CHECKPOINT_REMOTE_MISMATCH');
        record.status = 'preserved';
        return record;
    } catch (error) {
        record.status = 'failed';
        record.error = redactAuthenticatedGitUrl((error as Error).message || String(error)).slice(0, MAX_ERROR_CHARACTERS);
        return record;
    } finally {
        await rm(indexDirectory, { recursive: true, force: true });
    }
}

/**
 * Restores the in-scope changes of an exact, previously preserved checkpoint into a
 * freshly created admitted worktree as uncommitted work. HEAD stays at the admitted base.
 */
export async function restoreExecutionCheckpoint(worktreePath: string, value: StoryExecutionContract,
    remote = 'origin'): Promise<RestoredExecutionCheckpoint | undefined> {
    const execution = requireStoryExecutionContract(value);
    const checkpoint = execution.recovery?.checkpoint;
    if (!checkpoint) return undefined;
    if ((await git(worktreePath, ['rev-parse', 'HEAD'])).trim() !== execution.baseSha)
        throw Error('STORY_EXECUTION_BASE_CHANGED');
    await git(worktreePath, ['fetch', '--no-tags', remote, checkpoint.ref]);
    if ((await git(worktreePath, ['rev-parse', 'FETCH_HEAD'])).trim() !== checkpoint.sha)
        throw Error('STORY_EXECUTION_CHECKPOINT_CHANGED');
    if ((await git(worktreePath, ['rev-parse', `${checkpoint.sha}^1`])).trim() !== execution.baseSha)
        throw Error('STORY_EXECUTION_CHECKPOINT_BASE_CHANGED');

    const entries = splitNul(await git(worktreePath,
        ['diff-tree', '-r', '--name-status', '--no-renames', '-z', execution.baseSha, checkpoint.sha]));
    const restoredPaths: string[] = [];
    const ignoredPaths: string[] = [];
    for (let index = 0; index + 1 < entries.length; index += 2) {
        const status = entries[index];
        const path = entries[index + 1];
        if (!execution.allowedPaths.includes(path)) { ignoredPaths.push(path); continue; }
        if (status === 'D') await rm(join(worktreePath, path), { force: true });
        else await git(worktreePath, ['restore', `--source=${checkpoint.sha}`, '--worktree', '--', path]);
        restoredPaths.push(path);
    }
    return { ref: checkpoint.ref, sha: checkpoint.sha, restoredPaths: restoredPaths.sort(), ignoredPaths: ignoredPaths.sort() };
}

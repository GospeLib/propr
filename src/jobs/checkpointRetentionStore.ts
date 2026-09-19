/**
 * Durable registry of worktrees retained because a partial-work checkpoint push failed.
 *
 * One JSON record per retained worktree, kept outside the worktrees root so expired-
 * worktree sweeps never touch it. The record carries only local facts (paths, task id,
 * timing); the checkpoint ref/SHA and the repository are always re-read from the
 * durable task record, never trusted from this file.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { getWorktreesBasePath } from '@propr/core';

const STORE_DIRECTORY_NAME = 'checkpoint-retention';
const RECORD_EXTENSION = '.json';
const RECORD_NAME_HEX_LENGTH = 32;

export interface RetainedCheckpointEntry {
    taskId: string;
    worktreePath: string;
    /** The repository's shared git directory: survives the worktree's removal. */
    gitDir: string;
    branchName: string;
    retainedAt: string;
    /** Set once the worktree was removed after its commit was pinned or snapshotted. */
    worktreeRemovedAt?: string;
    /** Local-only snapshot ref taken at expiry when there was no checkpoint commit. */
    snapshotRef?: string;
    publishAttempts: number;
    lastError?: string;
}

export function retainedCheckpointStoreDir(): string {
    return process.env.CHECKPOINT_RETENTION_DIR || path.join(path.dirname(getWorktreesBasePath()), STORE_DIRECTORY_NAME);
}

function recordPath(storeDir: string, worktreePath: string): string {
    const name = createHash('sha256').update(path.resolve(worktreePath)).digest('hex').slice(0, RECORD_NAME_HEX_LENGTH);
    return path.join(storeDir, `${name}${RECORD_EXTENSION}`);
}

function isEntry(value: unknown): value is RetainedCheckpointEntry {
    const entry = value as RetainedCheckpointEntry;
    return !!entry && typeof entry === 'object' && typeof entry.taskId === 'string' && typeof entry.worktreePath === 'string' &&
        typeof entry.gitDir === 'string' && typeof entry.branchName === 'string' && typeof entry.retainedAt === 'string' &&
        !Number.isNaN(Date.parse(entry.retainedAt)) && typeof entry.publishAttempts === 'number';
}

/** Writes (or replaces) the record atomically: a torn write never loses a registration. */
export async function saveRetainedCheckpoint(entry: RetainedCheckpointEntry, storeDir = retainedCheckpointStoreDir()): Promise<void> {
    await fs.ensureDir(storeDir);
    const target = recordPath(storeDir, entry.worktreePath);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeJson(temporary, entry);
    await fs.rename(temporary, target);
}

export async function removeRetainedCheckpoint(worktreePath: string, storeDir = retainedCheckpointStoreDir()): Promise<void> {
    await fs.remove(recordPath(storeDir, worktreePath));
}

export async function isRetainedCheckpointWorktree(worktreePath: string, storeDir = retainedCheckpointStoreDir()): Promise<boolean> {
    return fs.pathExists(recordPath(storeDir, worktreePath));
}

/** Every well-formed record, oldest retention first. Malformed files are reported, never deleted. */
export async function listRetainedCheckpoints(storeDir = retainedCheckpointStoreDir()):
    Promise<{ entries: RetainedCheckpointEntry[]; malformed: string[] }> {
    if (!await fs.pathExists(storeDir)) return { entries: [], malformed: [] };
    const entries: RetainedCheckpointEntry[] = [];
    const malformed: string[] = [];
    for (const name of await fs.readdir(storeDir)) {
        if (!name.endsWith(RECORD_EXTENSION)) continue;
        const file = path.join(storeDir, name);
        try {
            const value: unknown = await fs.readJson(file);
            if (isEntry(value) && recordPath(storeDir, value.worktreePath) === file) entries.push(value);
            else malformed.push(file);
        } catch {
            malformed.push(file);
        }
    }
    entries.sort((left, right) => Date.parse(left.retainedAt) - Date.parse(right.retainedAt));
    return { entries, malformed };
}

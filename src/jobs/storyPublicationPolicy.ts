import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requireStoryPublicationPolicyFromReader } from '@propr/core';

const FILE_NOT_FOUND_CODE = 'ENOENT';

export async function requireStoryPublicationPolicy(input: {
    worktreePath: string;
    changedPaths: readonly string[];
    signedStoryId: string | undefined;
}): Promise<{ taskLinkRequired: boolean }> {
    return requireStoryPublicationPolicyFromReader({
        changedPaths: input.changedPaths,
        signedStoryId: input.signedStoryId,
        readFile: async path => {
            try {
                return await readFile(join(input.worktreePath, path), 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND_CODE) return null;
                throw error;
            }
        },
    });
}

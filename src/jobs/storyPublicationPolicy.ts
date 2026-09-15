import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    requireStoryPublicationId,
    storyPublicationSpecLinkPath,
    storyPublicationTaskLinkRequired,
} from './publicationMetadata.js';

const SPEC_LINK_GATE_PATH = 'checks/spec-link.sh';
const PULL_REQUEST_TEMPLATE_PATHS = ['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md'] as const;

async function pathExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function repositoryRequiresTaskLink(worktreePath: string): Promise<boolean> {
    const specLinkGatePresent = await pathExists(join(worktreePath, SPEC_LINK_GATE_PATH));
    let pullRequestTemplate: string | null = null;
    for (const templatePath of PULL_REQUEST_TEMPLATE_PATHS) {
        const absolutePath = join(worktreePath, templatePath);
        if (!await pathExists(absolutePath)) continue;
        pullRequestTemplate = await readFile(absolutePath, 'utf8');
        break;
    }
    return storyPublicationTaskLinkRequired({ specLinkGatePresent, pullRequestTemplate });
}

export async function requireStoryPublicationPolicy(input: {
    worktreePath: string;
    changedPaths: readonly string[];
    signedStoryId: string | undefined;
}): Promise<{ taskLinkRequired: boolean }> {
    if (!input.signedStoryId) throw new Error('STORY_PUBLICATION_SIGNED_STORY_ID_REQUIRED');
    if ([SPEC_LINK_GATE_PATH, ...PULL_REQUEST_TEMPLATE_PATHS].some(path => input.changedPaths.includes(path))) {
        throw new Error('STORY_PUBLICATION_POLICY_CHANGED');
    }

    const taskLinkRequired = await repositoryRequiresTaskLink(input.worktreePath);
    requireStoryPublicationId(input.signedStoryId, taskLinkRequired);
    if (!taskLinkRequired) return { taskLinkRequired };

    const specLinkPath = storyPublicationSpecLinkPath(input.signedStoryId);
    if (input.changedPaths.includes(specLinkPath)) throw new Error('STORY_PUBLICATION_SPEC_LINK_CHANGED');
    if (!await pathExists(join(input.worktreePath, specLinkPath))) {
        throw new Error('STORY_PUBLICATION_SPEC_LINK_REQUIRED');
    }
    return { taskLinkRequired };
}

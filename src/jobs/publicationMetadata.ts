const STORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STORY_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*-T[0-9]+$/;
const STORY_TASK_SUFFIX_PATTERN = /-T[0-9]+$/;
const PUBLICATION_COMMIT_PREFIX = 'fix(ai): Implement ';
const CONSERVATIVE_RISK_LEVEL = 'high';
const TASK_POLICY_DECLARATION = 'Task: <story>-<task>';
const SPEC_DIRECTORY_PREFIX = 'specs/';
const SPEC_LINK_FILENAME = 'link.md';

export interface StoryPublicationMetadata {
    commitMessage: string;
    prTitle: string;
    prBody: string;
}

export interface StoryPublicationMetadataInput {
    storyId: string;
    issueNumber: number;
    repository: string;
    commitHash: string;
    taskLinkRequired?: boolean;
}

export function storyPublicationTaskLinkRequired(input: {
    specLinkGatePresent: boolean;
    pullRequestTemplate: string | null;
}): boolean {
    return input.specLinkGatePresent && input.pullRequestTemplate?.includes(TASK_POLICY_DECLARATION) === true;
}

export function requireStoryPublicationId(storyId: string, taskLinkRequired = false): string {
    if (!STORY_ID_PATTERN.test(storyId)) throw new Error('STORY_PUBLICATION_STORY_ID_INVALID');
    if (taskLinkRequired && !STORY_TASK_ID_PATTERN.test(storyId)) {
        throw new Error('STORY_PUBLICATION_TASK_ID_REQUIRED');
    }
    return storyId;
}

function buildPublicationSubject(storyId: string, taskLinkRequired: boolean): string {
    return `${PUBLICATION_COMMIT_PREFIX}${requireStoryPublicationId(storyId, taskLinkRequired)}`;
}

export function buildStoryCommitMessage(storyId: string, taskLinkRequired = false): string {
    const publicationId = requireStoryPublicationId(storyId, taskLinkRequired);
    const subject = buildPublicationSubject(publicationId, taskLinkRequired);
    return STORY_TASK_ID_PATTERN.test(publicationId) ? `${subject}\n\nTask: ${publicationId}` : subject;
}

export function storyPublicationSpecLinkPath(taskId: string): string {
    const storyId = requireStoryPublicationId(taskId, true).replace(STORY_TASK_SUFFIX_PATTERN, '');
    return `${SPEC_DIRECTORY_PREFIX}${storyId}/${SPEC_LINK_FILENAME}`;
}

export function buildStoryPublicationMetadata(input: StoryPublicationMetadataInput): StoryPublicationMetadata {
    const publicationId = requireStoryPublicationId(input.storyId, input.taskLinkRequired);
    const storyId = publicationId.replace(STORY_TASK_SUFFIX_PATTERN, '');
    const specLine = input.taskLinkRequired ? `- Spec: \`${SPEC_DIRECTORY_PREFIX}${storyId}/\`` : '';
    const prTitle = buildPublicationSubject(publicationId, input.taskLinkRequired ?? false);
    const commitMessage = buildStoryCommitMessage(publicationId, input.taskLinkRequired);
    const prBody = `## Summary

Implements the exact signed story authority \`${publicationId}\` for issue #${input.issueNumber}.

## Story / task

- Story / task: \`${publicationId}\`
${specLine}

## Impact & Risk

- **Domains / repos touched:** \`${input.repository}\`
- **Contract surface touched:** not asserted by generated publication metadata
- **Risk level:** ${CONSERVATIVE_RISK_LEVEL}
- **Rollback plan:** revert commit \`${input.commitHash}\`

## Testing

ProPR does not infer passing checks from model prose. Use the repository checks for this commit and the execution evidence comment.

## Checklist

- Signed story authority recorded: \`${publicationId}\`
- No approval or merge is asserted by this generated description.
`;

    return { commitMessage, prTitle, prBody };
}

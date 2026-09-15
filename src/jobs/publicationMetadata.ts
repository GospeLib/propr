import { requireAuthorizedPublicationMetadata, type StoryExecutionContract, requireStoryPublicationId, STORY_PUBLICATION_TASK_ID_PATTERN as STORY_TASK_ID_PATTERN,
    STORY_PUBLICATION_TASK_SUFFIX_PATTERN as STORY_TASK_SUFFIX_PATTERN,
    STORY_PUBLICATION_SPEC_DIRECTORY_PREFIX as SPEC_DIRECTORY_PREFIX } from '@propr/core';
export { requireStoryPublicationId, storyPublicationSpecLinkPath, storyPublicationTaskLinkRequired } from '@propr/core';

const PUBLICATION_COMMIT_PREFIX = 'fix(ai): Implement ';
const CONSERVATIVE_RISK_LEVEL = 'high';

export interface StoryPublicationMetadata {
    commitMessage: string;
    prTitle: string;
    prBody: string;
}

export interface StoryPublicationMetadataInput {
    execution?: StoryExecutionContract;
    storyId: string;
    issueNumber: number;
    repository: string;
    commitHash: string;
    taskLinkRequired?: boolean;
}

function buildPublicationSubject(storyId: string, taskLinkRequired: boolean): string {
    return `${PUBLICATION_COMMIT_PREFIX}${requireStoryPublicationId(storyId, taskLinkRequired)}`;
}

export function buildStoryCommitMessage(storyId: string, taskLinkRequired = false, execution?: StoryExecutionContract): string {
    if (execution?.publicationMetadata) {
        if (execution.taskAssignment?.taskId !== storyId) throw Error('STORY_PUBLICATION_METADATA_TASK');
        return requireAuthorizedPublicationMetadata(execution.publicationMetadata, execution.taskAssignment).commitMessage;
    }
    const publicationId = requireStoryPublicationId(storyId, taskLinkRequired);
    const subject = buildPublicationSubject(publicationId, taskLinkRequired);
    return STORY_TASK_ID_PATTERN.test(publicationId) ? `${subject}\n\nTask: ${publicationId}` : subject;
}

export function buildStoryPublicationMetadata(input: StoryPublicationMetadataInput): StoryPublicationMetadata {
    if (input.execution?.publicationMetadata) {
        if (input.execution.taskAssignment?.taskId !== input.storyId) throw Error('STORY_PUBLICATION_METADATA_TASK');
        const { commitMessage, prTitle, prBody } = requireAuthorizedPublicationMetadata(input.execution.publicationMetadata, input.execution.taskAssignment);
        return { commitMessage, prTitle, prBody };
    }
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

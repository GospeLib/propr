import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildStoryPublicationMetadata, storyPublicationSpecLinkPath, storyPublicationTaskLinkRequired } from '../src/jobs/publicationMetadata.js';

const SIGNED_TASK_ID = 'EP-publication-policy-S01-T02';

describe('signed story publication metadata', () => {
    test('replaces model prose with deterministic conventional commit and PR subjects', () => {
        const metadata = buildStoryPublicationMetadata({
            storyId: SIGNED_TASK_ID,
            issueNumber: 2357,
            repository: 'example/code',
            commitHash: 'a'.repeat(40),
            taskLinkRequired: true,
        });

        assert.equal(metadata.commitMessage, `fix(ai): Implement ${SIGNED_TASK_ID}\n\nTask: ${SIGNED_TASK_ID}`);
        assert.equal(metadata.prTitle, `fix(ai): Implement ${SIGNED_TASK_ID}`);
        assert.doesNotMatch(metadata.commitMessage, /Implementation complete/);
        assert.doesNotMatch(metadata.prTitle, /Preserve exact publication authority/);
    });

    test('uses the code PR template sections without unchecked claims', () => {
        const metadata = buildStoryPublicationMetadata({
            storyId: SIGNED_TASK_ID,
            issueNumber: 2357,
            repository: 'example/code',
            commitHash: 'b'.repeat(40),
            taskLinkRequired: true,
        });

        for (const heading of ['## Summary', '## Story / task', '## Impact & Risk', '## Testing', '## Checklist']) {
            assert.match(metadata.prBody, new RegExp(`^${heading.replaceAll('#', '\\#')}$`, 'm'));
        }
        assert.ok(metadata.prBody.includes(`Story / task: \`${SIGNED_TASK_ID}\``));
        assert.match(metadata.prBody, /\*\*Risk level:\*\* high/);
        assert.doesNotMatch(metadata.prBody, /- \[[ xX]\]/);
        assert.doesNotMatch(metadata.prBody, /All story checks/);
    });

    test('refuses a story-only identifier rather than inventing a task suffix', () => {
        assert.throws(() => buildStoryPublicationMetadata({
            storyId: 'EP-publication-policy-S01',
            issueNumber: 2357,
            repository: 'example/code',
            commitHash: 'c'.repeat(40),
            taskLinkRequired: true,
        }), /STORY_PUBLICATION_TASK_ID_REQUIRED/);
    });

    test('preserves a signed story-level identifier when the repository does not declare a task-link gate', () => {
        const storyId = 'EP-publication-policy-S01';
        const metadata = buildStoryPublicationMetadata({
            storyId,
            issueNumber: 2357,
            repository: 'example/code',
            commitHash: 'd'.repeat(40),
            taskLinkRequired: false,
        });

        assert.equal(metadata.commitMessage, `fix(ai): Implement ${storyId}`);
        assert.equal(metadata.prTitle, `fix(ai): Implement ${storyId}`);
        assert.doesNotMatch(metadata.commitMessage, /Task:/);
        assert.doesNotMatch(metadata.prBody, /- Spec:/);
    });

    test('requires task-level authority only when both repository policy declarations are present', () => {
        assert.equal(storyPublicationTaskLinkRequired({
            specLinkGatePresent: true,
            pullRequestTemplate: '<!-- Commits carry a Task: <story>-<task> trailer. -->',
        }), true);
        assert.equal(storyPublicationTaskLinkRequired({
            specLinkGatePresent: false,
            pullRequestTemplate: '<!-- Commits carry a Task: <story>-<task> trailer. -->',
        }), false);
        assert.equal(storyPublicationTaskLinkRequired({
            specLinkGatePresent: true,
            pullRequestTemplate: 'No task-link policy declared here.',
        }), false);
    });

    test('derives a repository spec link only from a validated task-level signed identifier', () => {
        assert.equal(storyPublicationSpecLinkPath(SIGNED_TASK_ID), 'specs/EP-publication-policy-S01/link.md');
        assert.throws(() => storyPublicationSpecLinkPath('EP-publication-policy-S01'), /STORY_PUBLICATION_TASK_ID_REQUIRED/);
    });
});

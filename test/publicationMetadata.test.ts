import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { closeConnection } from '@propr/core';
import { createHash } from 'node:crypto';
import { publicationMetadataDigest } from '../packages/core/src/admission/authorizedPublicationMetadata.js';

import { buildStoryPublicationMetadata, storyPublicationSpecLinkPath, storyPublicationTaskLinkRequired } from '../src/jobs/publicationMetadata.js';

const SIGNED_TASK_ID = 'EP-publication-policy-S01-T02';
after(async () => { await closeConnection(); });

describe('signed story publication metadata', () => {
    test('uses only exact admitted task metadata rather than regenerating the title or body', () => {
        const defaults = buildStoryPublicationMetadata({ storyId: SIGNED_TASK_ID, issueNumber: 2357,
            repository: 'example/code', commitHash: 'a'.repeat(40), taskLinkRequired: true });
        const taskAssignment = { taskId: SIGNED_TASK_ID, artifacts: ['tasks.md', 'link.md'].map(name => {
            const content = `${SIGNED_TASK_ID}\n`;
            return { path: `specs/EP-publication-policy-S01/${name}`, content,
                digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
        }) };
        const metadata = { ...defaults, commitMessage: `docs(ezer): publish fixture\n\nTask: ${SIGNED_TASK_ID}`,
            prTitle: 'docs(ezer): publish fixture' };
        const execution = { baseSha: 'a'.repeat(40), featureBranch: 'task/publication', targetBranch: 'stage',
            allowedPaths: ['docs/fixture.md'], taskAssignment,
            publicationMetadata: { ...metadata, digest: publicationMetadataDigest(taskAssignment, metadata) } };
        assert.deepEqual(buildStoryPublicationMetadata({ storyId: SIGNED_TASK_ID, issueNumber: 9999,
            repository: 'example/code', commitHash: 'b'.repeat(40), execution }), metadata);
        assert.throws(() => buildStoryPublicationMetadata({ storyId: 'EP-other-S01-T01', issueNumber: 2357,
            repository: 'example/code', commitHash: 'b'.repeat(40), execution }), /PUBLICATION_METADATA_TASK/);
    });
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

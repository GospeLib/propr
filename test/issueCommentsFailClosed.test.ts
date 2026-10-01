import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchIssueComments } from '../src/jobs/issueJob/github.js';

const logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never;
const issueRef = { repoOwner: 'GospeLib', repoName: 'main', number: 2471 } as never;

test('an issue whose comments cannot be read is refused, never run on its body alone', async () => {
    const octokit = { request: async () => { throw new Error('HTTP 502'); } } as never;
    await assert.rejects(fetchIssueComments(octokit, issueRef, logger), /ISSUE_COMMENTS_UNREADABLE: HTTP 502/);
});

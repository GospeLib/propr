import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import pino from 'pino';
import { closeConnection, VISUAL_PREVIEW_SLOT, type IssueJobData, type WorktreeInfo } from '@propr/core';
import { createPullRequest } from '../src/jobs/issueJobHelpers.js';

const ISSUE_NUMBER = 17;
const PR_NUMBER = 19;
const SIGNED_BODY = `Exact signed content\n${VISUAL_PREVIEW_SLOT}\nPreserve Unicode: café.`;
after(closeConnection);

test('signed publication body remains byte-exact despite ordinary visual-preview decoration', async () => {
  const calls: Array<{ endpoint: string; options: Record<string, unknown> }> = [];
  const octokit = { async request<T>(endpoint: string, options: Record<string, unknown>): Promise<T> {
    calls.push({ endpoint, options });
    return { data: { number: PR_NUMBER, html_url: 'https://example.test/pull/19', title: 'Signed title' } } as T;
  } };
  const result = await createPullRequest(octokit,
    { number: ISSUE_NUMBER, repoOwner: 'fixture', repoName: 'repo', baseBranch: 'stage' } as IssueJobData,
    { branchName: 'task/signed', path: '/unused' } as WorktreeInfo, {
      commitResult: { commitHash: 'a'.repeat(40) } as Parameters<typeof createPullRequest>[3]['commitResult'],
      claudeResult: null, modelName: 'fixture', repoValidation: {} as Parameters<typeof createPullRequest>[3]['repoValidation'],
      PR_LABEL: 'fixture', correlatedLogger: pino({ enabled: false }), issueTitle: 'Model title',
      publicationMetadata: { commitMessage: 'Signed commit', prTitle: 'Signed title', prBody: SIGNED_BODY },
      visualPreview: { worktreePath: '/must-not-read', evidence: {
        assets: [{ path: 'must-not-upload.png' }], toolSuggestions: [],
      } as unknown as NonNullable<Parameters<typeof createPullRequest>[3]['visualPreview']>['evidence'] },
    });
  assert.equal(result.success, true);
  assert.equal(calls[0]?.options.body, SIGNED_BODY);
  assert.equal(calls[0]?.options.title, 'Signed title');
  assert.deepEqual(calls.map(call => call.endpoint), [
    'POST /repos/{owner}/{repo}/pulls', 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
  ]);
});

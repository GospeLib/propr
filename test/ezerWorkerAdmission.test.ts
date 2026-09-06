import { after, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyConfiguredEzerAdmission } from '../src/jobs/ezerExecutionAdmission.js';
import type { IssueJobData } from '../packages/core/src/queue/taskQueue.types.js';
import { closeConnection } from '../packages/core/src/db/connection.js';

const REQUIRED_LABEL = 'propr-admitted';

function issue(triggeringLabel: string): IssueJobData {
  return { repoOwner: 'GospeLib', repoName: 'main', number: 2260, triggeringLabel, isChildJob: true };
}

afterEach(() => {
  delete process.env.EZER_ADMISSION_REQUIRED_LABEL;
  delete process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES;
});

after(async () => {
  await closeConnection();
});

describe('worker-start Ezer admission boundary', () => {
  test('preserves existing non-Ezer ProPR processing labels', async () => {
    process.env.EZER_ADMISSION_REQUIRED_LABEL = REQUIRED_LABEL;
    await assert.doesNotReject(() => verifyConfiguredEzerAdmission(issue('AI')));
  });

  test('refuses a direct Ezer child-worker job with no server receipt', async () => {
    process.env.EZER_ADMISSION_REQUIRED_LABEL = REQUIRED_LABEL;
    await assert.rejects(
      () => verifyConfiguredEzerAdmission(issue(REQUIRED_LABEL)),
      /missing-worker-receipt/,
    );
  });

  test('refuses a direct protected-repository job even when its label is forged', async () => {
    process.env.EZER_ADMISSION_REQUIRED_LABEL = REQUIRED_LABEL;
    process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES = 'GospeLib/main,GospeLib/product-hub';
    await assert.rejects(
      () => verifyConfiguredEzerAdmission(issue('AI')),
      /missing-worker-receipt/,
    );
  });
});

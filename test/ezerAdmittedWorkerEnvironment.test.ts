import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAdmittedWorkerEnvironment } from '../src/jobs/ezerAdmittedWorkerEnvironment.js';
import type { IssueJobData } from '../packages/core/src/queue/taskQueue.types.js';

const ISSUE: IssueJobData = {
  repoOwner: 'GospeLib',
  repoName: 'main',
  number: 2262,
  baseBranch: 'stage',
  executionAdmissionReceipt: {
    admissionId: 'adm-test',
    operationId: 'op-test',
    receiptKey: 'receipt-test',
  },
};

describe('admitted Ezer worker environment', () => {
  test('emits no marker before receipt verification', () => {
    assert.equal(buildAdmittedWorkerEnvironment(ISSUE, 'task-test', false), undefined);
  });

  test('binds the root-marker payload to the verified issue, target, admission, and task', () => {
    const environment = buildAdmittedWorkerEnvironment(ISSUE, 'task-test', true);
    assert.ok(environment);
    const claim = JSON.parse(
      Buffer.from(environment.PROPR_EZER_ADMISSION_MARKER_B64, 'base64').toString('utf8'),
    );
    assert.deepEqual(claim, {
      version: 1,
      repository: 'GospeLib/main',
      target: 'stage',
      issueNumber: 2262,
      admissionId: 'adm-test',
      taskId: 'task-test',
    });
  });
});

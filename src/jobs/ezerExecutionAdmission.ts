import { Redis } from 'ioredis';
import {
  createRedisAdmissionStore,
  requiresEzerExecutionAdmission,
  verifyWorkerAdmissionReceipt,
  type IssueJobData,
} from '@propr/core';

export async function verifyConfiguredEzerAdmission(issueRef: IssueJobData): Promise<void> {
  const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
  if (!requiresEzerExecutionAdmission({
    repository,
    triggeringLabel: issueRef.triggeringLabel,
    requiredLabel: process.env.EZER_ADMISSION_REQUIRED_LABEL,
    protectedRepositories: process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES,
  })) return;
  if (!issueRef.executionAdmissionReceipt) {
    throw new Error('ezer-execution-admission-refused:missing-worker-receipt');
  }
  const admissionRedis = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  try {
    await verifyWorkerAdmissionReceipt({
      receipt: issueRef.executionAdmissionReceipt,
      expected: { repository, issueNumber: issueRef.number },
      store: createRedisAdmissionStore(admissionRedis),
    });
  } finally {
    admissionRedis.disconnect();
  }
}

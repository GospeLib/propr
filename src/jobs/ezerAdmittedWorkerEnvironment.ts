import type { IssueJobData } from '@propr/core';

export function buildAdmittedWorkerEnvironment(
  issueRef: IssueJobData,
  taskId: string,
  verified: boolean | undefined,
): Record<string, string> | undefined {
  if (!verified) return undefined;
  return {
    PROPR_EZER_ADMISSION_MARKER_B64: Buffer.from(JSON.stringify({
      version: 1,
      repository: `${issueRef.repoOwner}/${issueRef.repoName}`,
      target: issueRef.baseBranch ?? '',
      issueNumber: issueRef.number,
      admissionId: issueRef.executionAdmissionReceipt?.admissionId,
      taskId,
    })).toString('base64'),
  };
}

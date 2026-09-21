import { Redis } from 'ioredis';
import {
  AgentRegistry,
  createRedisAdmissionStore,
  requiresEzerExecutionAdmission,
  verifyWorkerAdmissionReceipt,
  inspectWorkerAdmissionReceipt,
  type IssueJobData,
  type TypedInvestigationAdmission,
  type StoryExecutionContract,
} from '@propr/core';

export async function verifyConfiguredEzerAdmission(issueRef: IssueJobData, onTyped?: (typed: TypedInvestigationAdmission) => void, onStoryExecution?: (execution: StoryExecutionContract) => void, onExecutionDeadline?: (deadline: string) => void): Promise<boolean> {
  return checkConfiguredEzerAdmission(verifyWorkerAdmissionReceipt, issueRef, onTyped, onStoryExecution, onExecutionDeadline);
}

/** Read and validate before preparation; this does not establish verified execution. */
export async function inspectConfiguredEzerAdmission(issueRef: IssueJobData, onTyped?: (typed: TypedInvestigationAdmission) => void, onStoryExecution?: (execution: StoryExecutionContract) => void, onExecutionDeadline?: (deadline: string) => void): Promise<boolean> {
  return checkConfiguredEzerAdmission(inspectWorkerAdmissionReceipt, issueRef, onTyped, onStoryExecution, onExecutionDeadline);
}

async function checkConfiguredEzerAdmission(checkReceipt: typeof verifyWorkerAdmissionReceipt | typeof inspectWorkerAdmissionReceipt, issueRef: IssueJobData, onTyped?: (typed: TypedInvestigationAdmission) => void, onStoryExecution?: (execution: StoryExecutionContract) => void, onExecutionDeadline?: (deadline: string) => void): Promise<boolean> {
  const repository = `${issueRef.repoOwner}/${issueRef.repoName}`;
  if (!requiresEzerExecutionAdmission({
    repository,
    triggeringLabel: issueRef.triggeringLabel,
    requiredLabel: process.env.EZER_ADMISSION_REQUIRED_LABEL,
    protectedRepositories: process.env.EZER_ADMISSION_PROTECTED_REPOSITORIES,
  })) return false;
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
    const registry=AgentRegistry.getInstance();await registry.ensureInitialized();
    const agent=issueRef.agentAlias?registry.getAgentByAlias(issueRef.agentAlias):undefined;
    if(issueRef.executionAdmissionReceipt.route&&(!agent?.config.enabled||!issueRef.modelName||!agent.config.supportedModels?.includes(issueRef.modelName)))throw new Error('ezer-execution-admission-refused:selected-route-unavailable');
    const typed = await checkReceipt({
      ...(agent&&issueRef.modelName?{expectedRoute:{agentId:agent.config.id,agentAlias:agent.config.alias,provider:agent.config.type,model:issueRef.modelName}}:{}),
      receipt: issueRef.executionAdmissionReceipt,
      expected: { repository, issueNumber: issueRef.number, target: issueRef.baseBranch ?? '' },
      store: createRedisAdmissionStore(admissionRedis),
      requireStoryExecution: true,
      onStoryExecution,
      onExecutionDeadline,
    });
    if (typed) onTyped?.(typed);
    return true;
  } finally {
    admissionRedis.disconnect();
  }
}

/** Exact ordinary-story authority, shared by canonical planning and admission issuance. */
import { requireTaskAssignment, type TaskAssignment } from './taskAssignment.js';
import { requireAuthorizedPublicationMetadata, type AuthorizedPublicationMetadata } from './authorizedPublicationMetadata.js';
import { requireExecutionRecoveryContext, type ExecutionRecoveryContext } from './executionRecoveryContext.js';
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*$/;
const PATH = /^[a-zA-Z0-9_.@/-]+$/;
const RESERVED_BRANCHES = new Set(['main', 'master', 'stage']);
const UNSAFE_SEGMENT = /(?:^|\/)(?:\.{1,2}|\.git)(?:\/|$)/;
const KEYS = ['baseSha', 'featureBranch', 'targetBranch', 'allowedPaths'] as const;

export interface StoryExecutionContract {
  publicationMetadata?: AuthorizedPublicationMetadata;
  recovery?: ExecutionRecoveryContext;
  taskAssignment?: TaskAssignment;
  baseSha: string;
  featureBranch: string;
  targetBranch: string;
  allowedPaths: string[];
}

export const STORY_EXECUTION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: KEYS,
  properties: {
    publicationMetadata: { type: 'object', description: 'Exact conventional commit and template-complete PR metadata, digest-bound to the canonical task artifacts.' },
    taskAssignment: { type: 'object', description: 'Exact canonical task ID and digest-bound tasks.md/link.md artifacts.' },
    recovery: { type: 'object', description: 'Bounded prior attempt evidence and the current autonomous implementation route.' },
    baseSha: { type: 'string', pattern: SHA.source },
    featureBranch: { type: 'string', description: 'Exact new feature branch; never an integration/default branch.' },
    targetBranch: { type: 'string', description: 'Exact PR destination branch.' },
    allowedPaths: { type: 'array', minItems: 1, uniqueItems: true,
      items: { type: 'string' }, description: 'Complete exact repository-relative file paths, no globs or directories.' },
  },
});

function branch(value: unknown): value is string {
  return typeof value === 'string' && BRANCH.test(value) &&
    !value.startsWith('refs/') && !value.includes('//') && !value.endsWith('/');
}

export function requireStoryExecutionContract(value: unknown): StoryExecutionContract {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('STORY_EXECUTION_CONTRACT_REQUIRED');
  const contract = value as StoryExecutionContract;
  if (Object.keys(contract).some((key) => key !== 'publicationMetadata' && key !== 'recovery' && key !== 'taskAssignment' && !KEYS.includes(key as typeof KEYS[number])) ||
    !SHA.test(contract.baseSha) || !branch(contract.featureBranch) ||
    RESERVED_BRANCHES.has(contract.featureBranch) || !branch(contract.targetBranch) ||
    contract.targetBranch === 'master' || contract.featureBranch === contract.targetBranch ||
    !Array.isArray(contract.allowedPaths) || contract.allowedPaths.length === 0 ||
    new Set(contract.allowedPaths).size !== contract.allowedPaths.length ||
    contract.allowedPaths.some((path) => typeof path !== 'string' || !PATH.test(path) ||
      path.startsWith('/') || path.endsWith('/') || path.includes('//') || UNSAFE_SEGMENT.test(path)))
    throw Error('STORY_EXECUTION_CONTRACT_INVALID');
  return { ...(contract.publicationMetadata === undefined ? {} : { publicationMetadata: requireAuthorizedPublicationMetadata(contract.publicationMetadata, contract.taskAssignment) }), ...(contract.recovery === undefined ? {} : { recovery: requireExecutionRecoveryContext(contract.recovery) }), ...(contract.taskAssignment === undefined ? {} : { taskAssignment: requireTaskAssignment(contract.taskAssignment) }), baseSha: contract.baseSha, featureBranch: contract.featureBranch,
    targetBranch: contract.targetBranch, allowedPaths: [...contract.allowedPaths] };
}

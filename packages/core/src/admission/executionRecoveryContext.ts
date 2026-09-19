/** Bounded recovery evidence carried as data inside each fresh signed execution. */
const MAX_CHECKPOINT_CHARACTERS = 16_384;
const MAX_INSTRUCTION_CHARACTERS = 4_096;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const ACTIONS = ['continue', 'handoff', 'replan'] as const;
const FIELDS = ['sourceTaskId', 'evidenceDigest', 'action', 'checkpointText', 'instructions'] as const;
const OPTIONAL_FIELDS = ['checkpoint'] as const;
const CHECKPOINT_FIELDS = ['ref', 'sha'] as const;
/** Partial-work checkpoints live outside refs/heads, so they can never be a PR head or publication branch. */
export const EXECUTION_CHECKPOINT_REF_PREFIX = 'refs/propr/checkpoints/';
const CHECKPOINT_REF_TAIL = /^[A-Za-z0-9_][A-Za-z0-9_./-]*[A-Za-z0-9_]$/;
const UNSAFE_REF_SEQUENCE = /\/\/|\.\.|\/\.|\.lock(?:\/|$)/;

/** Exact prior partial-work checkpoint a fresh attempt starts from; the ref and SHA both bind. */
export interface ExecutionRecoveryCheckpoint {
  ref: string;
  sha: string;
}
export interface ExecutionRecoveryContext {
  sourceTaskId: string;
  evidenceDigest: string;
  action: typeof ACTIONS[number];
  checkpointText: string;
  instructions: string;
  checkpoint?: ExecutionRecoveryCheckpoint;
}

export function requireExecutionCheckpointRef(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith(EXECUTION_CHECKPOINT_REF_PREFIX)) throw Error('EXECUTION_CHECKPOINT_REF_INVALID');
  const tail = value.slice(EXECUTION_CHECKPOINT_REF_PREFIX.length);
  if (!CHECKPOINT_REF_TAIL.test(tail) || UNSAFE_REF_SEQUENCE.test(tail)) throw Error('EXECUTION_CHECKPOINT_REF_INVALID');
  return value;
}

/** Validates an exact `{ ref, sha }` checkpoint pair (no other fields). */
export function requireExecutionRecoveryCheckpoint(value: unknown): ExecutionRecoveryCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('EXECUTION_RECOVERY_CONTEXT_INVALID');
  const checkpoint = value as ExecutionRecoveryCheckpoint;
  if (Object.keys(checkpoint).some(key => !CHECKPOINT_FIELDS.includes(key as typeof CHECKPOINT_FIELDS[number])) ||
    typeof checkpoint.sha !== 'string' || !SHA.test(checkpoint.sha)) throw Error('EXECUTION_RECOVERY_CONTEXT_INVALID');
  try { requireExecutionCheckpointRef(checkpoint.ref); } catch { throw Error('EXECUTION_RECOVERY_CONTEXT_INVALID'); }
  return { ref: checkpoint.ref, sha: checkpoint.sha };
}

export function requireExecutionRecoveryContext(value: unknown): ExecutionRecoveryContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('EXECUTION_RECOVERY_CONTEXT_INVALID');
  const context = value as ExecutionRecoveryContext;
  if (Object.keys(context).some(key => !FIELDS.includes(key as typeof FIELDS[number]) &&
      !OPTIONAL_FIELDS.includes(key as typeof OPTIONAL_FIELDS[number])) ||
    FIELDS.some(key => typeof context[key] !== 'string') ||
    !context.sourceTaskId.trim() || !DIGEST.test(context.evidenceDigest) || !ACTIONS.includes(context.action) ||
    context.checkpointText.length > MAX_CHECKPOINT_CHARACTERS ||
    !context.instructions.trim() || context.instructions.length > MAX_INSTRUCTION_CHARACTERS)
    throw Error('EXECUTION_RECOVERY_CONTEXT_INVALID');
  return { sourceTaskId: context.sourceTaskId, evidenceDigest: context.evidenceDigest, action: context.action,
    checkpointText: context.checkpointText, instructions: context.instructions,
    ...(context.checkpoint === undefined ? {} : { checkpoint: requireExecutionRecoveryCheckpoint(context.checkpoint) }) };
}

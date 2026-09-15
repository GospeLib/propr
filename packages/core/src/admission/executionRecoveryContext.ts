/** Bounded recovery evidence carried as data inside each fresh signed execution. */
const MAX_CHECKPOINT_CHARACTERS = 16_384;
const MAX_INSTRUCTION_CHARACTERS = 4_096;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTIONS = ['continue', 'handoff', 'replan'] as const;
const FIELDS = ['sourceTaskId', 'evidenceDigest', 'action', 'checkpointText', 'instructions'] as const;
export interface ExecutionRecoveryContext {
  sourceTaskId: string;
  evidenceDigest: string;
  action: typeof ACTIONS[number];
  checkpointText: string;
  instructions: string;
}
export function requireExecutionRecoveryContext(value: unknown): ExecutionRecoveryContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('EXECUTION_RECOVERY_CONTEXT_INVALID');
  const context = value as ExecutionRecoveryContext;
  if (Object.keys(context).some(key => !FIELDS.includes(key as typeof FIELDS[number])) ||
    FIELDS.some(key => typeof context[key] !== 'string') ||
    !context.sourceTaskId.trim() || !DIGEST.test(context.evidenceDigest) || !ACTIONS.includes(context.action) ||
    context.checkpointText.length > MAX_CHECKPOINT_CHARACTERS ||
    !context.instructions.trim() || context.instructions.length > MAX_INSTRUCTION_CHARACTERS)
    throw Error('EXECUTION_RECOVERY_CONTEXT_INVALID');
  return { sourceTaskId: context.sourceTaskId, evidenceDigest: context.evidenceDigest, action: context.action,
    checkpointText: context.checkpointText, instructions: context.instructions };
}

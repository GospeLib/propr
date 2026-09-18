/** One execution snapshot owns stop authorization, signaling, selection and settlement. */
import { buildPlannerAbortSignalKey, taskStateExpectation, type TaskStateData, type TaskStateExpectation } from '@propr/core';

export interface StopExecutionBinding { admissionId: string; operationId: string; containerId: string }
export interface StopHistoryEntry {
  state: string;
  metadata?: Partial<StopExecutionBinding> & { containerName?: string; preserveTerminalEvidence?: boolean };
}
export interface StopState { history: StopHistoryEntry[] }
export interface StopOwnership {
  entry: StopHistoryEntry;
  historyIndex: number;
  stateJson: string;
}
export const STOP_EXECUTION_CHANGED = 'ezer-stop-refused:execution-changed';
export const STOP_ABORT_TTL_SECONDS = 3600;
export const STOP_CONTAINER_TIMEOUT_SECONDS = 10;
const EXECUTION_STATE = 'claude_execution';
const SIGNAL_CURRENT_EXECUTION = `
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('setex', KEYS[2], ARGV[2], ARGV[3])
return 1
`;

export function stopOwnership(state: StopState, stateJson: string, expected?: StopExecutionBinding): StopOwnership {
  const entry = currentExecutionEntry(state);
  if (!entry || (expected && (entry.state !== EXECUTION_STATE ||
    Object.entries(expected).some(([key, value]) => entry.metadata?.[key as keyof StopExecutionBinding] !== value))))
    throw Error(STOP_EXECUTION_CHANGED);
  return { entry, historyIndex: state.history.length - 1, stateJson };
}

/** No fallback to a previous attempt when the current entry has no container. */
export function currentExecutionEntry(state: StopState): StopHistoryEntry | undefined {
  return state.history.at(-1);
}

/** Latest execution, including one without a container; never resurrect an older attempt. */
export function latestExecutionEntry(state: StopState): StopHistoryEntry | undefined {
  return state.history.findLast(entry => entry.state === EXECUTION_STATE);
}

function sameStopEntry(current: StopHistoryEntry | undefined, bound: StopHistoryEntry): boolean {
  return current?.state === bound.state && current?.metadata?.containerId === bound.metadata?.containerId &&
    current?.metadata?.admissionId === bound.metadata?.admissionId && current?.metadata?.operationId === bound.metadata?.operationId;
}

export function stopSettlementExpectation(current: StopState, ownership: StopOwnership,
  scope: 'execution' | 'task' = 'execution'): TaskStateExpectation | undefined {
  if (scope === 'task') {
    // Progress within the selected attempt is not replacement. Any later execution
    // start is replacement, even if it reuses the old container or copied bindings.
    if (current.history.length <= ownership.historyIndex ||
      current.history.slice(ownership.historyIndex + 1).some(entry => entry.state === EXECUTION_STATE)) return undefined;
    if (!sameStopEntry(current.history[ownership.historyIndex], ownership.entry)) return undefined;
    return taskStateExpectation(current as TaskStateData);
  }
  const entry = currentExecutionEntry(current);
  if (current.history.length - 1 !== ownership.historyIndex || !sameStopEntry(entry, ownership.entry)) return undefined;
  return taskStateExpectation(current as TaskStateData);
}

export async function signalOwnedExecution(
  taskId: string, ownership: StopOwnership, marker: string,
  evalScript: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>,
): Promise<void> {
  const updated = await evalScript(SIGNAL_CURRENT_EXECUTION, {
    keys: [`worker:state:${taskId}`, buildPlannerAbortSignalKey(taskId, ownership.entry.metadata!.containerId!)],
    arguments: [ownership.stateJson, String(STOP_ABORT_TTL_SECONDS), marker],
  });
  if (Number(updated) !== 1) throw Error(STOP_EXECUTION_CHANGED);
}

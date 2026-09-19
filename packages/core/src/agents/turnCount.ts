/**
 * Provider-aware model-turn counting for implementation runs.
 *
 * Each CLI reports progress in its own unit, and a run stopped at its lease or turn
 * limit often never emits a final result line. The count is therefore taken from the
 * strongest evidence the provider actually produced:
 *
 * - claude: the result line's `num_turns`; otherwise distinct assistant messages.
 * - vibe: distinct assistant messages (Vibe's `--max-turns` unit).
 * - codex: `turn.started`/`turn.completed`/`turn.failed` events (Codex's own turn unit).
 * - opencode: `step_start`/`step_finish` events (one model call per step).
 * - antigravity: the stream result's `num_turns`; the CLI exposes no per-turn marker.
 *
 * When there is no evidence at all (no reported count and no parsed events, or a
 * provider that only reports at completion), the count is unknown and `undefined` is
 * returned. A missing count is never reported as 0.
 */

export type TurnCountingProvider = 'claude' | 'vibe' | 'codex' | 'opencode' | 'antigravity';

export interface TurnEvidence {
    /** A turn count the CLI reported itself, if any. */
    reportedTurns?: unknown;
    /** The parsed event stream of the run, in the provider's own shape. */
    events?: ReadonlyArray<unknown>;
}

type EventRecord = Record<string, unknown>;

const CODEX_TURN_FINISH_TYPES: ReadonlySet<string> = new Set(['turn.completed', 'turn.failed']);
const OPENCODE_STEP_FINISH_TYPES: ReadonlySet<string> = new Set(['step_finish']);

function isRecord(value: unknown): value is EventRecord {
    return typeof value === 'object' && value !== null;
}

function isTurnCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One streamed message can span several events that share its id. */
function countDistinctAssistantMessages(events: ReadonlyArray<unknown>): number {
    const messageIds = new Set<string>();
    let anonymousMessages = 0;
    for (const entry of events) {
        if (!isRecord(entry) || entry.type !== 'assistant') continue;
        const id = isRecord(entry.message) ? entry.message.id : undefined;
        if (typeof id === 'string' && id) messageIds.add(id);
        else anonymousMessages += 1;
    }
    return messageIds.size + anonymousMessages;
}

/** A started unit that never finished (killed mid-turn) still counts; a finish implies its start. */
function countMarkedUnits(events: ReadonlyArray<unknown>, startType: string, finishTypes: ReadonlySet<string>): number {
    let started = 0;
    let finished = 0;
    for (const entry of events) {
        if (!isRecord(entry) || typeof entry.type !== 'string') continue;
        if (entry.type === startType) started += 1;
        else if (finishTypes.has(entry.type)) finished += 1;
    }
    return Math.max(started, finished);
}

function reportedAntigravityTurns(events: ReadonlyArray<unknown>): number | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (isRecord(entry) && entry.event === 'result' && isRecord(entry.result) && isTurnCount(entry.result.num_turns))
            return entry.result.num_turns;
    }
    return undefined;
}

export function countAgentTurns(provider: TurnCountingProvider, evidence: TurnEvidence): number | undefined {
    if (isTurnCount(evidence.reportedTurns)) return evidence.reportedTurns;
    const events = evidence.events ?? [];
    if (provider === 'antigravity') return reportedAntigravityTurns(events);
    if (events.length === 0) return undefined;
    switch (provider) {
        case 'claude':
        case 'vibe':
            return countDistinctAssistantMessages(events);
        case 'codex':
            return countMarkedUnits(events, 'turn.started', CODEX_TURN_FINISH_TYPES);
        case 'opencode':
            return countMarkedUnits(events, 'step_start', OPENCODE_STEP_FINISH_TYPES);
    }
}

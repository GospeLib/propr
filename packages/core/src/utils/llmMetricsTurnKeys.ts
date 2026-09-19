/**
 * Redis keys for the turn-count aggregates.
 *
 * The legacy `turns` sums (`llm:metrics:total:turns`, `llm:metrics:model:<m>:turns`)
 * predate known-turn evidence: older writers added `numTurns ?? 0` for every request and
 * kept no divisor. Their sums still report total turns, but they can never be divided by
 * a known-turn count, because the count for those historic runs does not exist.
 *
 * The average therefore reads only the versioned pair below. Both halves are written
 * together, only for runs with a proven turn count, so the numerator and divisor always
 * describe the same set of executions. Legacy sums are ignored for the average.
 */
const TURN_AGGREGATE_VERSION_PREFIX = 'llm:metrics:turns:v2';

export const LEGACY_TOTAL_TURNS_KEY = 'llm:metrics:total:turns';
export const legacyModelTurnsKey = (model: string): string => `llm:metrics:model:${model}:turns`;

export const KNOWN_TOTAL_TURNS_KEY = `${TURN_AGGREGATE_VERSION_PREFIX}:total:knownTurns`;
export const KNOWN_TOTAL_TURNS_COUNT_KEY = `${TURN_AGGREGATE_VERSION_PREFIX}:total:knownCount`;
export const knownModelTurnsKey = (model: string): string => `${TURN_AGGREGATE_VERSION_PREFIX}:model:${model}:knownTurns`;
export const knownModelTurnsCountKey = (model: string): string => `${TURN_AGGREGATE_VERSION_PREFIX}:model:${model}:knownCount`;

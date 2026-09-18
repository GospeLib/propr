import type { AgentType } from './types.js';

export const AGENT_TYPES = ['claude', 'codex', 'antigravity', 'opencode', 'vibe'] as const satisfies readonly AgentType[];
export const AGENT_IMAGE_NAME = 'propr/agent';
export const DEFAULT_AGENT_EXECUTION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Leaves one minute for teardown before Ezer's ten-minute planning lease. */
export const PLANNING_ARTIFACT_TIMEOUT_MS = 9 * 60 * 1000;
/** One structured artifact response: observed 20-story author used 21,778 tokens.
 * Keep bounded headroom below the native model's 64,000-token ceiling; the
 * execution deadline and full artifact validation remain independent limits. */
export const PLANNING_ARTIFACT_MAX_OUTPUT_TOKENS = 32_768;
export const PLANNING_ARTIFACT_PROFILE = 'planning-artifact';

const VALID_AGENT_TYPES_SET = new Set<string>(AGENT_TYPES);

export type AgentTypeValidationResult = { ok: true; agentType: AgentType } | { ok: false; error: string };

export function validateAgentType(agentType: unknown): AgentTypeValidationResult {
    if (typeof agentType === 'string' && VALID_AGENT_TYPES_SET.has(agentType)) {
        return { ok: true, agentType: agentType as AgentType };
    }
    return {
        ok: false,
        error: `Invalid agent type '${String(agentType)}'. Must be one of: ${[...AGENT_TYPES].sort().join(', ')}`
    };
}

export const DEFAULT_AGENT_DOCKER_IMAGES: Record<AgentType, string> = {
    claude: `${AGENT_IMAGE_NAME}:latest`,
    codex: `${AGENT_IMAGE_NAME}:latest`,
    antigravity: `${AGENT_IMAGE_NAME}:latest`,
    opencode: `${AGENT_IMAGE_NAME}:latest`,
    vibe: `${AGENT_IMAGE_NAME}:latest`
};

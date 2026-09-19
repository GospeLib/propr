/**
 * Public package barrel. Split into topic sub-barrels to stay under the file-size cap
 * (INV-4); each sub-barrel is re-exported here so the public API surface is unchanged.
 */
export * from './index.core.js';
export * from './index.jobs.js';
export * from './index.claude-agents.js';
export * from './index.services-admission.js';

// Explicit re-exports to resolve name collisions between wildcard sub-barrel exports
// (mirrors the original single-file barrel, where an explicit named export always won
// over a same-name wildcard export).
export type { AgentConfig } from './agents/types.js';
export type { VersionedImageBuildResult } from './claude/docker/dockerExecutor.js';

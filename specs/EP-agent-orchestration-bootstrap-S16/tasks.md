---
feature-id: EP-agent-orchestration-bootstrap-S16
task-id: EP-agent-orchestration-bootstrap-S16-T01
speckit: not-installed
---

# Tasks — S16

## T01 — EP-agent-orchestration-bootstrap-S16-T01: implement confined worker runtime

Implement the locked S16 behavior in one ProPR runtime change. The implementation may touch only these
source files:

- `packages/core/src/agents/agentContainerResources.ts`
- `packages/core/src/agents/impl/utils/dockerArgsBuilder.ts`
- `packages/core/src/agents/impl/utils/codexDockerArgsBuilder.ts`
- `packages/core/src/agents/impl/openCodeUtils.ts`
- `packages/core/src/agents/impl/ClaudeAgent.ts`
- `packages/core/src/agents/impl/CodexAgent.ts`
- `packages/core/src/agents/impl/OpenCodeAgent.ts`
- `packages/core/src/agents/impl/AntigravityAgent.ts`
- `packages/core/src/agents/impl/VibeAgent.ts`
- `packages/core/src/claude/docker/repoSetupWrapper.ts`
- `packages/core/src/claude/docker/dockerExecutor.ts`
- `packages/core/src/claude/docker/dockerExecutionOwnership.ts`

It may add focused assertions only in these existing tests:

- `test/agentContainerResources.test.ts`
- `packages/core/test/antigravityConfig.test.ts`
- `packages/core/test/vibeAgent.test.ts`
- `packages/core/test/dockerExecutionOwnership.test.ts`
- `test/e2e/recovery.test.ts`
- `test/reviewContextScoutRuntime.test.ts`
- `test/repoSetupWrapper.test.ts`

Required outcome: actual unprivileged, explicitly mounted, read-only-capsule workers; named real-worker
refusals for every locked escape; separate commit and push custody refusals; usable assigned worktree
and unit branch; process-group child-death observation; and prerequisite refusal for mutating execution.
Do not modify the Ezer admission implementation or daemon caller, T04, protected-state import behavior,
or any non-listed file. Do not add a T06 or a new process, guardrail, monitor, documentation, or
acceptance framework. Do not invent an egress allowlist.

Verification request after implementation: existing focused tests, full existing tests, and hosted CI;
then independent Codex review of the exact candidate head. No merge is part of this task.

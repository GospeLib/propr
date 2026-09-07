---
feature-id: EP-agent-orchestration-bootstrap-S16
speckit: not-installed
---

# Research — S16 runtime confinement

## Locked inputs

The canonical story is `EP-agent-orchestration-bootstrap-S16` in product-hub commit
`52593488eff0556a41a3c74237810137596d09d3`; its repository binding is `[main, propr]` and its
acceptance criteria require actual unprivileged workers, named real-worker refusals, separate branch
custody, usable assigned work, process-group termination, and prerequisite refusal. The accepted
contract lock is `sha256:661b99fdd0f4f17ff2cf3c9361f38224713cf54436e97e7254cf1837570028ca`.

The ProPR implementation release is `gospelib/0.8.15` at
`cdc85eed9b68f608bca6bfc675691aa12ae3a494`. This is the source revision for this task; the divergent
repository default branch is not a substitute base.

## Source-reconciled implementation facts

- Claude currently runs as UID 1000 despite root startup, but argument builders hard-code CHOWN,
  bridge networking, broad writable `/tmp` and git-processor paths, writable configuration, and a
  `GH_TOKEN` path.
- `AgentTaskOptions.branchName` already exists, but the agent classes do not relay it to their Docker
  argument builders. `repoSetupWrapper` is the sole shared git environment/setup path and currently
  has no custody enforcement.
- The five agent classes and their builders share the policy problem. Vibe has no explicit root setup,
  but it still shares the confinement holes.
- Current locked inputs do not define an egress allowlist. The implementation must only bind concrete
  current configuration and authority necessary for a usable confined worker; it must not manufacture
  a new policy surface.

## Decision

Use one reusable container-resource policy and carry the assigned branch through every agent to the
builders and shared git setup. Enforce path confinement and git custody as separate runtime controls,
then prove both with existing focused tests and actual worker behavior. This is a scoped implementation
decision, not a new contract or a replacement execution system.

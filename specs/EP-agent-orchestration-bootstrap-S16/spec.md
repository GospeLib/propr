---
feature-id: EP-agent-orchestration-bootstrap-S16
story: EP-agent-orchestration-bootstrap-S16
epic: EP-agent-orchestration-bootstrap
repo: propr
speckit: not-installed
contract-lock: sha256:661b99fdd0f4f17ff2cf3c9361f38224713cf54436e97e7254cf1837570028ca
source-revision: cdc85eed9b68f608bca6bfc675691aa12ae3a494
---

# S16 — Confined ProPR workers

Implement the ProPR runtime half of S16 only. Every mutating ProPR worker must execute as an
unprivileged runtime with explicit mounts and a read-only capsule, while preserving a usable assigned
disposable worktree and its own unit branch. Git worktree isolation is not a sandbox.

This spec is bound to the locked product-hub story at
`52593488eff0556a41a3c74237810137596d09d3` and its contract lock. It does not add a cross-repository
contract surface or advance Yadflow front-half state.

## Required behavior

- A real worker runs unprivileged with only explicit mounts and a read-only capsule.
- From that real worker, each attempt to read or write the primary checkout, an unrelated worktree,
  controller state, attestations, authoritative evidence, protected state, or an out-of-scope
  credential is refused by name before it can take effect.
- A real worker cannot use any stage credential, or reach the network outside the existing runtime
  policy. This task must not invent a canonical network allowlist where the locked contract and current
  builders specify none.
- Commit and push attempts to the feature branch, a sibling-unit branch, and a shared branch are each
  separately refused by name when outside the worker's custody; confinement does not stand in for that
  custody check.
- The assigned disposable worktree and assigned unit branch remain usable.
- Termination kills the worker process group; a child left by the worker is observed dead.
- S16 is a prerequisite refusal for mutating ProPR execution, not merely an ordering convention.

## Boundaries

The main repository owns admission and the control plane. ProPR owns this runtime implementation.
The implementation uses Yadflow planning, a fresh single-use Ezer admission, and ProPR execution; it
must neither change `ezerExecutionAdmission.ts` nor its daemon admission caller. It must not restart
or modify T04, create T06, add a new verification framework, or substitute prose/no-op success for
real worker behavior.

## Acceptance evidence

Focused tests in the existing listed test files must exercise the real-worker success and named-refusal
paths. Full existing tests and hosted CI remain delivery gates. A passing static mount map, a worker
that permanently refuses all work, or an unobserved child-process assertion is insufficient.

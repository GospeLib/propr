---
feature-id: EP-agent-orchestration-bootstrap-S16
speckit: not-installed
---

# Plan — S16 ProPR runtime half

1. Establish one named reusable container-resource policy in the existing agent runtime layer. Apply
   it to the common Docker argument path and all five agent implementations so the runtime is
   unprivileged, mounts are explicit, and the capsule is read-only except for the assigned disposable
   worktree and necessary existing execution resources.
2. Carry the existing assigned `branchName` from every agent into the builders and the shared
   `repoSetupWrapper`; enforce git custody independently for the feature, sibling-unit, and shared
   branch cases while keeping the assigned unit branch usable.
3. Bind Docker execution ownership to the worker process group and make termination observe a left-behind
   child die. Preserve the existing Ezer admission boundary unchanged.
4. Add focused cases only to the existing S16 test files for real-worker named refusals, usable assigned
   work, custody, and process-group cleanup. Run focused and full existing tests before requesting
   independent exact-head review and hosted CI.

The implementation is intentionally limited to the source-reconciled file set in `tasks.md`. It may
make the smallest correction required by that source set, but any additional runtime scope needs a
new source-proven admission rather than ad-hoc expansion.

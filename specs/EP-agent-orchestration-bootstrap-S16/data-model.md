---
feature-id: EP-agent-orchestration-bootstrap-S16
speckit: not-installed
---

# Data model — S16 runtime inputs

S16 adds no cross-repository persistence model and no new product contract entity. It consumes the
existing ProPR task identity, `AgentTaskOptions.branchName`, and the already-issued Ezer admission as
execution inputs.

| Runtime value | Existing owner | S16 use |
| --- | --- | --- |
| Assigned worktree | ProPR task/runtime | The sole writable repository mount; remains usable. |
| Assigned unit branch | `AgentTaskOptions.branchName` | Propagated to every agent/builder and enforced as the only usable branch. |
| Container resource policy | ProPR runtime | Names unprivileged execution, explicit read-only/read-write mounts, capsule, and prohibited resource classes. |
| Execution ownership | ProPR Docker execution path | Associates the spawned process group with the admitted worker so termination can kill and observe children. |
| Ezer admission | Main control plane | Existing single-use authorization prerequisite; not redefined or persisted by this task. |

The resource policy must distinguish path capability from branch capability. It may represent explicit
existing runtime configuration, but it must not introduce a generic credential broker, a second
admission record, a network allowlist absent from the locked inputs, or a protected-state import path.

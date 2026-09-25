# EP-ezer-follow-ups-S03 tasks

- [ ] T02 — Implement all EP-ezer-follow-ups-S03 acceptance criteria and mapped tests in the GospeLib/propr lane of the approved story. This task is derived from the owner-approved story, not a claim of execution or completion.

---
id: EP-ezer-follow-ups-S03
dependencies: ["EP-ezer-follow-ups-S02"]
---
# S03: Steering, pause, and cancellation control propagation — REQ-EF17

Implement `pause`, `resume`, `steer`, `cancel` per `contract.md`, propagated to the underlying ProPR job/container via existing ownership fencing (`dockerExecutionOwnership.ts`, `dockerAbortController.ts`), keeping `control-ack` distinct from later confirmation of actual cessation, and versioning steer as accepted-vs-applied.
## Acceptance criteria
- [ ] AC-S03-1 — Pause/resume/cancel target the exact active attempt and acknowledge within proposed2s; real supported cessation is confirmed within proposed10s or explicitly reports still-running/reason/recovery. Exercise pause refusal/safe checkpoint, one-only resume, cancellation races, actual marker/child/container cessation and refusal of all late publication, never a false stopped or orphan claim.
- [ ] AC-S03-2 — Steering produces an ordered versioned input with distinct accepted/applied states, preserves prior evidence and changes subsequent activity; duplicate commandId+payload dedups and conflicting payload rejects without redirecting a replacement attempt.
## Prior art
[Native analysis](https://github.com/GospeLib/propr/blob/f730c101ec/packages/api/routes/nativeAnalysis.ts), [executor](https://github.com/GospeLib/propr/blob/f730c101ec/packages/core/src/claude/docker/dockerExecutor.ts), [Ezer execution binding](https://github.com/GospeLib/main/blob/7b42fdf190/services/ezer/src/conversation/planning-execution.ts). Exact stop mechanisms already exist; extend their real observable controls.
## Governing decisions
Recorded owner scope includes main/Ezer plus ProPR integration. Reuse the reviewed native cancellation/attempt fence. Historical Q2 remains an OPEN registry record; do not forge its resolution or turn it into a new scope approval request.
## Out of scope
Unrelated container-hardening work, invented cross-epic blockers, and protected master/production/UI/Corpus/incident changes.
## Definition of done
All ACs and mapped tests must pass: [required evidence](../contract.md#completion-evidence). Final PR approval required.

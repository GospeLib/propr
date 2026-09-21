# EP-ezer-follow-ups-S02 tasks

- [ ] T02 — Implement all EP-ezer-follow-ups-S02 acceptance criteria and mapped tests in the GospeLib/propr lane of the approved story. This task is derived from the owner-approved story, not a claim of execution or completion.

---
id: EP-ezer-follow-ups-S02
dependencies: ["EP-ezer-follow-ups-S01"]
---
# S02: Real incremental progress streaming — REQ-EF17

Emit `progress` and `heartbeat` events per `contract.md` as real state changes occur, reusing ProPR's existing Socket.IO channel as transport with the Ezer journal as replay authority. A completed answer must never be replayed as incremental output.
## Acceptance criteria
- [ ] AC-S02-1 — A controlled long-silent-provider run acknowledges within proposed2s and emits pending heartbeats within10s; intermediate progress, delay, retry (reason/next attempt) and blocker (cause/next action) events reach the client within proposed2s of real state changes, with no fake completed-answer streaming.
- [ ] AC-S02-2 — Real CLI→Ezer→ProPR progress carries request/session/operation/execution/attempt and monotonic cursor; reconnect resumes the acknowledged cursor, fences stale attempts and introduces no duplicate side effects or hidden reasoning.
## Prior art
[Ezer journal](https://github.com/GospeLib/main/blob/7b42fdf190/services/ezer/src/journal/index.ts), [ProPR server transport](https://github.com/GospeLib/propr/blob/f730c101ec/packages/api/server.ts). Journal exists; full incremental UX remains owed.
## Governing decisions
Journal is canonical replay/delivery authority; Socket.IO is transport/projection only, not a second source of truth (owner direction, batchCutoff 2026-09-17T05:36:45Z).
## Out of scope
Any new transport or database beyond the existing journal/Socket.IO reuse; UI changes.
## Definition of done
All ACs and mapped tests must pass: [required evidence](../contract.md#completion-evidence). Final PR approval required.

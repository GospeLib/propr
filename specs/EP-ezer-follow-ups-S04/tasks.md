# EP-ezer-follow-ups-S04 tasks

- [ ] T02 — Implement all EP-ezer-follow-ups-S04 acceptance criteria and mapped tests in the GospeLib/propr lane of the approved story. This task is derived from the owner-approved story, not a claim of execution or completion.

---
id: EP-ezer-follow-ups-S04
dependencies: ["EP-ezer-follow-ups-S03"]
---
# S04: Actionable errors and reconnect/retry idempotency — REQ-EF17

Replace generic errors with the contract's structured error object; add idempotency-key (commandId+payloadFingerprint) handling and cursor-based reconnect replay; record crash/timeout as a technical partial failure with bounded, explicit recovery, distinguishing credential errors from quota errors.
## Acceptance criteria
- [ ] AC-S04-1 — Provider failures, long silence, real credential401 versus quota403/429 and timeout surface code/diagnosticId, known cause or unknown, saved state, remaining activity and a bounded recovery path with actual reset/Retry-After metadata.
- [ ] AC-S04-2 — Disconnect/reconnect and same-session retry resume the journal cursor with no duplicate accepted action; same command key/different payload rejects. Timeout→owned abort marker→exact child/container cessation→terminal record fences late output; valid checkpoint recovery adds no unnecessary author call and never invents approval or completion.
## Prior art
[Provider boundary](https://github.com/GospeLib/main/blob/7b42fdf190/services/ezer/src/conversation/providers.ts), [checkpoint](https://github.com/GospeLib/main/blob/7b42fdf190/services/ezer/src/planning/draft-checkpoint.ts), [native analysis](https://github.com/GospeLib/propr/blob/f730c101ec/packages/api/routes/nativeAnalysis.ts). Existing cancellation/receipts are prerequisites, not absent methods.
## Governing decisions
Owner direction (batchCutoff 2026-09-17T05:36:45Z): timeout and cancel must fence all late-accepted publication; checkpoint recovery must be truthful and bounded, never a silent retry-counter reset.
## Out of scope
Any change to credential storage or extraction; no fallback to a non-authenticated Anthropic API path.
## Definition of done
All ACs and mapped tests must pass: [required evidence](../contract.md#completion-evidence). Final PR approval required. The S01–S04 urgent unit must receive final PR approval and merge to stage before S05–S20 implementation.

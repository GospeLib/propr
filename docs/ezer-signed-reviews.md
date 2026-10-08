# Ezer signed story-review intake

Set `EZER_REVIEW_TRIGGER_AUTHOR_USER_ID=322838413` for GospeLib's
`gospelib-ezer[bot]` in every ProPR API, daemon and worker environment.
`213159723` identifies `propr-dev[bot]` and does not authorize Ezer's triggers.
There is no default: unset or malformed configuration refuses the bot exception,
even when `EZER_PROPR_REVIEW_AUTHOR_USER_ID` is set. Preserve that existing
typed-source setting (GospeLib: `213159723`); the two authorities are independent.
Deploy the intake fix and recreate the affected services with the corrected environment.
A valid `EZER_ADMISSION_HMAC_SECRET` and matching pending signed admission remain required.
This change does not deploy services or change their live configuration.

## Review-only authorization

Only an exact `/ezer review <admission-uuid>` request followed by
`Model: <model>` and instructions, on a PR issue comment, can use this exception.
The configured numeric author ID is checked at shared intake classification and
again against the live GitHub comment before signed admission, including replay.
Other `/ezer` commands retain owner-only authorization. Inline review comments
and ordinary issues cannot use the bot exception. Polling routes these requests
through signed admission and excludes every `/ezer` address from generic batching.

The admission binds the comment ID, body SHA-256, PR head and branch, repository,
PR number and target base branch. An edit that changes the body cannot reuse the
admission. Identical edit deliveries retain the existing review; changed edits
cancel the old queued work and must pass admission again.

## Deployment configuration locations

`.env.example` documents the identity without enabling it. Development/preview
`docker-compose.yml` loads its selected env file. `docker-compose.prod.yml`
explicitly passes both author variables to API, daemon and worker with empty fallbacks.
For other deployment mechanisms, pass the variable explicitly to each process;
changing a host `.env` alone does not change already-running containers.

## Existing typed-source review authority

`admittedSource.ts` continues to read only `EZER_PROPR_REVIEW_AUTHOR_USER_ID`
for the `ezer-review` typed-source authority: it validates an unchanged review
comment used as the source of a correction. Its existing identity policy is unchanged.
Setting, changing, or unsetting `EZER_REVIEW_TRIGGER_AUTHOR_USER_ID` cannot change
which author the typed-source path accepts. Conversely, the typed-source setting
cannot authorize a signed review trigger. Keep the existing typed-source value
when deploying this fix; configure the new trigger value separately.

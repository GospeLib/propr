/* eslint-disable max-lines -- classification, the failure/recovery ledger and
   the timeout fence are one subject: an error is only actionable if the same
   module that names its cause also owns the bounded recovery it points at.
   Splitting them would let the two drift into contradicting each other. */
/**
 * EP-ezer-follow-ups-S04 — actionable errors and reconnect/retry idempotency
 * (REQ-EF17), ProPR lane.
 *
 * Replaces the generic failure report with the `contract.md` structured error
 * object, and gives every one of them a bounded recovery that the API itself
 * enforces. Three rules shape the module:
 *
 * 1. A cause is named or admitted unknown — never guessed. A 401 is a
 *    credential fault and no amount of waiting clears it; a 429 or a 403 with
 *    rate-limit evidence is a quota fault and carries the provider's actual
 *    reset/Retry-After time; a 403 with neither is reported as `unknown`
 *    rather than filed under whichever of the two reads better.
 * 2. Recovery is bounded and explicit. The attempt counter only ever grows: a
 *    granted recovery never decrements it and no path resets it, so a crash or
 *    timeout stays a recorded technical partial failure. A retry before a known
 *    reset time is refused, and an exhausted budget escalates instead of
 *    quietly starting again.
 * 3. A timeout fences before it propagates. The exact attempt is fenced out of
 *    the projection first, then the owned abort marker is written, then real
 *    child/container cessation is observed and a terminal record is written —
 *    so late output from the timed-out attempt can never publish, whether or
 *    not the stop itself could be confirmed.
 *
 * Recovery here means resuming a journal cursor and admitting at most one
 * continuation. It never records an approval and never claims a completion;
 * both are reported as explicitly not granted on every response.
 */

import type { Response } from 'express';
import type { RedisClientType } from 'redis';
import type { FlatRequest } from '../requestTypes.js';
import type {
  EzerActiveAttempt,
  EzerErrorDetail,
  EzerEventEnvelope,
  EzerStreamingService,
} from '../ep-ezer-follow-ups-s02.js';
import {
  createEzerCessationObserver,
  ezerPayloadFingerprint,
  type EzerCessationEvidence,
  type EzerCessationObserver,
} from './ep-ezer-follow-ups-s03.js';
import { normalizeTaskId, stopTaskExecution, type StopTaskExecutionResult } from './dockerRoutes.js';
import { validateTaskId } from './validation.js';

/**
 * How many recoveries one operation may be granted. The bound is the point of
 * the counter: a technical partial failure that keeps recovering forever is
 * indistinguishable from one that silently reset its retry count.
 */
const RECOVERY_ATTEMPT_BUDGET = 3;

/**
 * Silence longer than this stops being a liveness question and becomes a
 * reportable condition. Three heartbeat intervals: long enough that an ordinary
 * slow provider call does not raise it, short enough to beat the 540s lease.
 */
const SILENCE_ESCALATION_MS = 30_000;

/** Applied only when a failure carries no provider-declared reset time. */
const BOUNDED_LOCAL_BACKOFF_SECONDS = 60;

/** A reset further out than this is treated as malformed rather than honoured. */
const MAX_RESET_SECONDS = 24 * 60 * 60;

/** Above this, a numeric reset header is an absolute epoch, not a delta. */
const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 512;

const FAILURE_KINDS = new Set(['provider', 'timeout', 'silence']);
const RECOVERY_ACTIONS = new Set(['retry', 'resume-from-checkpoint']);

/**
 * The only response headers this route reads or stores. An allowlist rather
 * than a filter: an echoed `authorization` or `set-cookie` would put a
 * credential into the journal, and quota diagnosis needs none of them.
 */
const RATE_LIMIT_HEADERS = [
  'retry-after',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
  'x-ratelimit-used', 'x-ratelimit-resource',
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
  'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
] as const;

/** Reset headers consulted, in order, when `retry-after` is absent. */
const RESET_HEADERS = [
  'x-ratelimit-reset', 'ratelimit-reset',
  'anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset',
] as const;

/** Remaining-quota headers; a zero on any of them is quota evidence. */
const REMAINING_HEADERS = [
  'x-ratelimit-remaining', 'ratelimit-remaining', 'anthropic-ratelimit-requests-remaining',
] as const;

type EzerFailureKind = 'provider' | 'timeout' | 'silence';
type EzerRecoveryAction = 'retry' | 'resume-from-checkpoint';
type EzerFailureClass = 'credential' | 'quota' | 'timeout' | 'silence' | 'provider';
type ResetSource = 'retry-after-header' | 'ratelimit-reset-header' | 'bounded-local-backoff' | 'none';

interface AttemptTarget { executionId: string; attemptId: string }

/** What was observed about a failure, as reported by the caller that saw it. */
interface ObservedFailure {
  kind: EzerFailureKind;
  status: number | null;
  message: string | null;
  /** Provider/GitHub identity, used only in human-readable text. */
  source: string;
  headers: Record<string, string>;
  timeoutMs: number | null;
  silentForMs: number | null;
}

/** Reset metadata as the provider declared it, or as locally bounded. */
interface ResetMetadata {
  retryAfterSeconds: number | null;
  retryNotBefore: string | null;
  source: ResetSource;
}

/** What the observed failure is, before it is joined to operation state. */
interface FailureClassification {
  code: string;
  failureClass: EzerFailureClass;
  /** The contract's `knownCause`, which is the literal string `unknown` when it is. */
  knownCause: string;
  message: string;
  credentialFault: boolean;
  quotaFault: boolean;
  reset: ResetMetadata;
  /** The attempt cannot continue; any recovery starts from the saved cursor. */
  endsAttempt: boolean;
}

/**
 * The `contract.md` error object. The seven contract fields are what travels on
 * the event envelope; `recovery` is the same bounded path in machine-readable
 * form for a client that would otherwise have to parse `retryPath`.
 */
interface EzerStructuredError {
  code: string;
  message: string;
  diagnosticId: string;
  knownCause: string;
  persistedState: string;
  remainingActivity: string;
  retryPath: string;
  recovery: {
    failureClass: EzerFailureClass;
    credentialFault: boolean;
    quotaFault: boolean;
    retryable: boolean;
    retryAfterSeconds: number | null;
    retryNotBefore: string | null;
    resetSource: ResetSource;
    attemptsUsed: number;
    attemptsRemaining: number;
    budget: number;
  };
}

interface FailureRequest {
  operationId: string;
  sessionId: string;
  commandId: string;
  requestId?: string;
  taskId?: string;
  target: AttemptTarget | null;
  failure: ObservedFailure;
  payloadFingerprint: string;
}

interface RecoveryRequest {
  operationId: string;
  sessionId: string;
  commandId: string;
  requestId?: string;
  action: EzerRecoveryAction;
  /** The caller asserts the credential was repaired; only it unblocks a 401. */
  credentialRepaired: boolean;
  payloadFingerprint: string;
}

/** The terminal record written for an attempt this node timed out. */
interface TerminalRecord {
  recordedAt: string;
  state: 'failed';
  classification: 'technical-partial-failure';
  /** The fence predates this record, so late output is refused either way. */
  fencesLateOutput: true;
  cessationConfirmed: boolean;
  abortMarker: {
    /** An abort marker owned by this task was written. */
    written: boolean;
    /** Still outstanding: the worker has not observed the marker yet. */
    pending: boolean;
    /** Observed gone — consumed by the worker, or cleared after a direct stop. */
    consumed: boolean;
    taskId: string | null;
  };
  cancellationRecorded: boolean;
}

interface FailureRecord {
  failureId: string;
  recordedAt: string;
  /** A real fault counts against the budget; an observation does not. */
  classification: 'technical-partial-failure' | 'observation';
  kind: EzerFailureKind;
  target: AttemptTarget | null;
  cursor: string | null;
  error: EzerStructuredError;
  fenced: boolean;
  cessation?: EzerCessationEvidence;
  terminalRecord?: TerminalRecord;
}

/** The saved state a recovery may resume from without a new author call. */
interface RecoveryCheckpoint {
  cursor: string;
  recordedAt: string;
  target: AttemptTarget | null;
  failureId: string;
}

interface RecoveryGrant {
  action: EzerRecoveryAction;
  grantedAt: string;
  resumeCursor: string | null;
  authorCallRequired: boolean;
  authorCallReason: string;
  continuationId: string;
}

interface LedgerEntry {
  idempotencyKey: string;
  commandId: string;
  surface: 'failure' | 'recovery';
  payloadFingerprint: string;
  acceptedAt: string;
  duplicateDeliveries: number;
  /** The accepted action's outcome; null only while it is still being applied. */
  outcome: Record<string, unknown> | null;
}

interface OperationRecoveryState {
  operationId: string;
  taskId: string | null;
  ledger: Map<string, LedgerEntry>;
  failures: FailureRecord[];
  /** Monotonic: incremented by every technical partial failure, never reset. */
  technicalFailures: number;
  /** Monotonic: incremented by every granted recovery, never reset. */
  recoveriesGranted: number;
  grants: RecoveryGrant[];
  checkpoint: RecoveryCheckpoint | null;
  /**
   * A credential the provider rejected is still in place. Set by a credential
   * fault and cleared only when a caller asserts the repair — not by a later
   * unrelated failure, which would otherwise hide the standing one.
   */
  credentialRepairRequired: boolean;
  fenced: AttemptTarget[];
  /** The cursor a silence escalation was already published at, if any. */
  silenceEscalatedAtCursor: string | null;
  failureSeq: number;
}

interface RouteResult { httpStatus: number; body: Record<string, unknown> }

/** What propagating a timeout abort to the real ProPR job actually achieved. */
interface AbortOutcome {
  evidence: EzerCessationEvidence;
  abortMarkerWritten: boolean;
  abortMarkerPending: boolean;
  cancellationRecorded: boolean;
}

export interface EzerRecoveryRoutesDeps {
  redisClient: RedisClientType;
  /** Resolved lazily: the projection lives on the socket service. */
  getStreaming: () => EzerStreamingService | null;
  stopTaskExecution?: typeof stopTaskExecution;
  /** Container observation seam; defaults to the real `docker ps` lookup. */
  observeContainerStatus?: (containerId: string) => string;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------

function readIdentifier(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IDENTIFIER_LENGTH ? trimmed : null;
}

function readHeaders(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toLowerCase();
    if (!(RATE_LIMIT_HEADERS as readonly string[]).includes(name)) continue;
    if (typeof value === 'string' && value.length <= MAX_IDENTIFIER_LENGTH) headers[name] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) headers[name] = String(value);
  }
  return headers;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function parseObservedFailure(raw: unknown): { failure: ObservedFailure } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'A "failure" object describing what was observed is required.' };
  }
  const source = raw as Record<string, unknown>;
  const kind = readIdentifier(source, 'kind');
  if (!kind || !FAILURE_KINDS.has(kind)) {
    return { error: `"failure.kind" must be one of ${[...FAILURE_KINDS].join(', ')}.` };
  }
  const status = typeof source.status === 'number' && Number.isInteger(source.status)
    && source.status >= 100 && source.status <= 599 ? source.status : null;
  if (source.status !== undefined && status === null) {
    return { error: '"failure.status" must be an HTTP status code between 100 and 599.' };
  }
  const message = typeof source.message === 'string' && source.message.trim().length > 0
    ? source.message.trim().slice(0, MAX_MESSAGE_LENGTH) : null;
  return {
    failure: {
      kind: kind as EzerFailureKind,
      status, message,
      source: readIdentifier(source, 'source') ?? 'the provider',
      headers: readHeaders(source.headers),
      timeoutMs: readNonNegativeInteger(source.timeoutMs),
      silentForMs: readNonNegativeInteger(source.silentForMs),
    },
  };
}

/** Validates the attempt target and task binding carried by a request body. */
function parseBinding(
  source: Record<string, unknown>,
): { target: AttemptTarget | null; taskId: string | null } | { error: string } {
  const executionId = readIdentifier(source, 'executionId');
  const attemptId = readIdentifier(source, 'attemptId');
  if (Boolean(executionId) !== Boolean(attemptId)) {
    return { error: '"executionId" and "attemptId" must be supplied together to target an exact attempt.' };
  }
  const taskId = readIdentifier(source, 'taskId');
  if (taskId) {
    const validation = validateTaskId(taskId);
    if (!validation.valid) return { error: validation.error ?? 'Invalid task ID.' };
  }
  return {
    target: executionId && attemptId ? { executionId, attemptId } : null,
    taskId: taskId ? normalizeTaskId(taskId) : null,
  };
}

function readCommandIdentity(
  source: Record<string, unknown>,
): { sessionId: string; commandId: string; requestId: string | null } | { error: string } {
  const commandId = readIdentifier(source, 'commandId');
  if (!commandId) return { error: '"commandId" is required and carries the idempotency identity of this request.' };
  const sessionId = readIdentifier(source, 'sessionId');
  if (!sessionId) return { error: '"sessionId" is required and forms part of the idempotency key.' };
  return { sessionId, commandId, requestId: readIdentifier(source, 'requestId') };
}

function parseFailureRequest(raw: unknown, operationId: string): { request: FailureRequest } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'A JSON failure report body is required.' };
  const source = raw as Record<string, unknown>;
  const identity = readCommandIdentity(source);
  if ('error' in identity) return identity;
  const binding = parseBinding(source);
  if ('error' in binding) return binding;
  const observed = parseObservedFailure(source.failure);
  if ('error' in observed) return observed;
  const payloadFingerprint = ezerPayloadFingerprint({ failure: observed.failure, target: binding.target });
  const declared = readIdentifier(source, 'payloadFingerprint');
  if (declared && declared !== payloadFingerprint) {
    return { error: 'The supplied "payloadFingerprint" does not match the supplied failure report.' };
  }
  return {
    request: {
      operationId, sessionId: identity.sessionId, commandId: identity.commandId,
      ...(identity.requestId ? { requestId: identity.requestId } : {}),
      ...(binding.taskId ? { taskId: binding.taskId } : {}),
      target: binding.target, failure: observed.failure, payloadFingerprint,
    },
  };
}

function parseRecoveryRequest(raw: unknown, operationId: string): { request: RecoveryRequest } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'A JSON recovery request body is required.' };
  const source = raw as Record<string, unknown>;
  const identity = readCommandIdentity(source);
  if ('error' in identity) return identity;
  const action = readIdentifier(source, 'action');
  if (!action || !RECOVERY_ACTIONS.has(action)) {
    return { error: `"action" must be one of ${[...RECOVERY_ACTIONS].join(', ')}.` };
  }
  if (source.credentialRepaired !== undefined && typeof source.credentialRepaired !== 'boolean') {
    return { error: '"credentialRepaired" must be a boolean assertion that the credential was replaced.' };
  }
  const credentialRepaired = source.credentialRepaired === true;
  const payloadFingerprint = ezerPayloadFingerprint({ action, credentialRepaired });
  const declared = readIdentifier(source, 'payloadFingerprint');
  if (declared && declared !== payloadFingerprint) {
    return { error: 'The supplied "payloadFingerprint" does not match the supplied recovery request.' };
  }
  return {
    request: {
      operationId, sessionId: identity.sessionId, commandId: identity.commandId,
      ...(identity.requestId ? { requestId: identity.requestId } : {}),
      action: action as EzerRecoveryAction, credentialRepaired, payloadFingerprint,
    },
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

function headerValue(headers: Record<string, string>, name: string): string | null {
  const value = headers[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resetFromSeconds(seconds: number, now: number, source: ResetSource): ResetMetadata {
  const bounded = Math.max(0, Math.min(Math.ceil(seconds), MAX_RESET_SECONDS));
  return {
    retryAfterSeconds: bounded,
    retryNotBefore: new Date(now + bounded * 1_000).toISOString(),
    source,
  };
}

function boundedLocalBackoff(now: number): ResetMetadata {
  return resetFromSeconds(BOUNDED_LOCAL_BACKOFF_SECONDS, now, 'bounded-local-backoff');
}

const NO_RESET: ResetMetadata = { retryAfterSeconds: null, retryNotBefore: null, source: 'none' };

function parseRetryAfter(raw: string, now: number): ResetMetadata | null {
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return resetFromSeconds(seconds, now, 'retry-after-header');
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : resetFromSeconds((at - now) / 1_000, now, 'retry-after-header');
}

function parseRateLimitReset(raw: string, now: number): ResetMetadata | null {
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) {
    // GitHub sends an absolute epoch; RFC 9239-style headers send a delta.
    const atMs = numeric > EPOCH_SECONDS_THRESHOLD ? numeric * 1_000 : now + numeric * 1_000;
    return resetFromSeconds((atMs - now) / 1_000, now, 'ratelimit-reset-header');
  }
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : resetFromSeconds((at - now) / 1_000, now, 'ratelimit-reset-header');
}

/** The provider's declared reset time, or `none` — never a guessed one. */
function readResetMetadata(headers: Record<string, string>, now: number): ResetMetadata {
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter) {
    const parsed = parseRetryAfter(retryAfter, now);
    if (parsed) return parsed;
  }
  for (const name of RESET_HEADERS) {
    const raw = headerValue(headers, name);
    if (!raw) continue;
    const parsed = parseRateLimitReset(raw, now);
    if (parsed) return parsed;
  }
  return NO_RESET;
}

/**
 * Whether a 403 is quota exhaustion rather than an authorization refusal.
 * Evidence only: an exhausted remaining counter, a Retry-After the provider
 * only sends for throttling, or the provider saying so in the message.
 */
function hasQuotaEvidence(failure: ObservedFailure): boolean {
  for (const name of REMAINING_HEADERS) {
    const raw = headerValue(failure.headers, name);
    if (raw !== null && Number(raw) === 0) return true;
  }
  if (headerValue(failure.headers, 'retry-after') !== null) return true;
  return /rate limit|ratelimit|quota|too many requests/i.test(failure.message ?? '');
}

function classifyProviderFailure(failure: ObservedFailure, now: number): FailureClassification {
  const declaredReset = readResetMetadata(failure.headers, now);
  const detail = failure.message ? ` (${failure.message})` : '';
  if (failure.status === 401) {
    return {
      code: 'PROVIDER_CREDENTIAL_REJECTED', failureClass: 'credential',
      knownCause: 'the provider rejected the request credential (HTTP 401)',
      message: `${failure.source} rejected the request credential with HTTP 401${detail}.`
        + ' This is an authentication failure, not quota exhaustion: no reset time will clear it.',
      // A credential fault has no reset. Reporting one would tell an operator
      // to wait for a deadline that cannot repair anything.
      credentialFault: true, quotaFault: false, reset: NO_RESET, endsAttempt: true,
    };
  }
  if (failure.status === 429 || (failure.status === 403 && hasQuotaEvidence(failure))) {
    return {
      code: failure.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_QUOTA_EXHAUSTED',
      failureClass: 'quota',
      knownCause: `the provider refused the request for exhausted quota (HTTP ${failure.status})`,
      message: `${failure.source} refused the request with HTTP ${failure.status} for exhausted quota${detail}.`
        + ' The credential itself was accepted, so this is not a credential failure.',
      credentialFault: false, quotaFault: true,
      reset: declaredReset.source === 'none' ? boundedLocalBackoff(now) : declaredReset,
      endsAttempt: true,
    };
  }
  if (failure.status === 403) {
    return {
      code: 'PROVIDER_FORBIDDEN', failureClass: 'provider',
      // Neither quota evidence nor a credential rejection was observed, and a
      // 403 is produced by both. Filing it under either would be a guess.
      knownCause: 'unknown',
      message: `${failure.source} refused the request with HTTP 403${detail}, carrying no rate-limit metadata.`
        + ' It is neither a confirmed credential failure nor a confirmed quota failure on the evidence available.',
      credentialFault: false, quotaFault: false, reset: boundedLocalBackoff(now), endsAttempt: true,
    };
  }
  if (failure.status !== null && failure.status >= 500) {
    return {
      code: 'PROVIDER_UNAVAILABLE', failureClass: 'provider',
      knownCause: `the provider returned HTTP ${failure.status}`,
      message: `${failure.source} returned HTTP ${failure.status}${detail}.`,
      credentialFault: false, quotaFault: false,
      reset: declaredReset.source === 'none' ? boundedLocalBackoff(now) : declaredReset,
      endsAttempt: true,
    };
  }
  return {
    code: failure.status === null ? 'PROVIDER_FAILED' : 'PROVIDER_REQUEST_REJECTED',
    failureClass: 'provider',
    knownCause: 'unknown',
    message: failure.status === null
      ? `${failure.source} failed without a status code${detail}; the cause is not determinable from what was observed.`
      : `${failure.source} rejected the request with HTTP ${failure.status}${detail}; the cause is not determinable from what was observed.`,
    credentialFault: false, quotaFault: false, reset: boundedLocalBackoff(now), endsAttempt: true,
  };
}

function classifyObservedFailure(failure: ObservedFailure, now: number): FailureClassification {
  if (failure.kind === 'timeout') {
    const bound = failure.timeoutMs === null ? 'its execution lease' : `its ${failure.timeoutMs}ms execution lease`;
    return {
      code: 'EXECUTION_TIMEOUT', failureClass: 'timeout',
      knownCause: `the attempt exceeded ${bound} and was aborted`,
      message: `The attempt exceeded ${bound}; it was fenced and aborted, and the outcome is a technical partial failure.`,
      credentialFault: false, quotaFault: false, reset: NO_RESET, endsAttempt: true,
    };
  }
  if (failure.kind === 'silence') {
    const silence = failure.silentForMs === null ? 'longer than the heartbeat interval' : `${failure.silentForMs}ms`;
    return {
      code: 'PROVIDER_SILENT', failureClass: 'silence',
      // Silence is a symptom. Naming a cause here is exactly the guess the
      // story forbids: the request may be slow, stalled, or already dead.
      knownCause: 'unknown',
      message: `No observable activity has been published for ${silence}; the attempt has neither progressed nor failed.`,
      credentialFault: false, quotaFault: false, reset: NO_RESET, endsAttempt: false,
    };
  }
  return classifyProviderFailure(failure, now);
}

// ---------------------------------------------------------------------------
// Structured error assembly
// ---------------------------------------------------------------------------

function describeReset(reset: ResetMetadata): string {
  if (reset.retryNotBefore === null) return '';
  const origin = reset.source === 'bounded-local-backoff'
    ? 'the provider supplied no reset time, so a bounded local backoff applies'
    : `from the provider's ${reset.source === 'retry-after-header' ? 'Retry-After' : 'rate-limit reset'} header`;
  return ` Do not retry before ${reset.retryNotBefore} (${reset.retryAfterSeconds}s; ${origin});`
    + ' the recovery endpoint refuses an earlier retry.';
}

function describeBudget(attemptsRemaining: number, budget: number): string {
  return attemptsRemaining <= 0
    ? ` All ${budget} bounded recovery attempts are used; the recovery endpoint refuses another and the`
      + ' operation must be escalated. The recorded failure count is not reset by this refusal.'
    : ` ${attemptsRemaining} of ${budget} bounded recovery attempts remain.`;
}

function recoveryPathFor(
  classification: FailureClassification,
  operationId: string,
  attemptsRemaining: number,
): string {
  const endpoint = `POST /api/ezer/operations/${operationId}/recovery`;
  const budget = describeBudget(attemptsRemaining, RECOVERY_ATTEMPT_BUDGET);
  if (classification.failureClass === 'credential') {
    return `Replace the provider credential, then send ${endpoint} with a new commandId and`
      + ' {"action":"retry","credentialRepaired":true}. Waiting changes nothing — this is a credential'
      + ` failure, not a quota failure — and a retry that does not assert the repair is refused.${budget}`;
  }
  if (classification.failureClass === 'silence') {
    return 'Nothing was retried and nothing was stopped: the attempt is still running. Wait for the next'
      + ` heartbeat or progress event, or cancel it with POST /api/ezer/operations/${operationId}/control`
      + ' before recovering. No retry is issued automatically while an attempt is active.';
  }
  if (classification.failureClass === 'timeout') {
    return `Send ${endpoint} with a new commandId and {"action":"resume-from-checkpoint"} to continue from the`
      + ' saved journal cursor without a new author call, or {"action":"retry"} to start exactly one new'
      + ` attempt. The timed-out attempt stays fenced and cannot publish either way.${budget}`;
  }
  return `Send ${endpoint} with a new commandId and {"action":"retry"} to start exactly one new attempt,`
    + ` or {"action":"resume-from-checkpoint"} when the saved cursor is still valid.${describeReset(classification.reset)}${budget}`;
}

interface ErrorContext {
  operationId: string;
  diagnosticId: string;
  persistedState: string;
  remainingActivity: string;
  attemptsUsed: number;
}

function buildStructuredError(classification: FailureClassification, context: ErrorContext): EzerStructuredError {
  const attemptsRemaining = Math.max(0, RECOVERY_ATTEMPT_BUDGET - context.attemptsUsed);
  return {
    code: classification.code,
    message: classification.message,
    diagnosticId: context.diagnosticId,
    knownCause: classification.knownCause,
    persistedState: context.persistedState,
    remainingActivity: context.remainingActivity,
    retryPath: recoveryPathFor(classification, context.operationId, attemptsRemaining),
    recovery: {
      failureClass: classification.failureClass,
      credentialFault: classification.credentialFault,
      quotaFault: classification.quotaFault,
      // A credential fault is not retryable until the credential changes, and
      // a silent attempt has nothing to retry because it never stopped.
      retryable: !classification.credentialFault && classification.failureClass !== 'silence'
        && attemptsRemaining > 0,
      retryAfterSeconds: classification.reset.retryAfterSeconds,
      retryNotBefore: classification.reset.retryNotBefore,
      resetSource: classification.reset.source,
      attemptsUsed: context.attemptsUsed,
      attemptsRemaining,
      budget: RECOVERY_ATTEMPT_BUDGET,
    },
  };
}

/** The seven contract fields, which are what travels on the event envelope. */
function envelopeError(error: EzerStructuredError): EzerErrorDetail {
  return {
    code: error.code, message: error.message, diagnosticId: error.diagnosticId,
    knownCause: error.knownCause, persistedState: error.persistedState,
    remainingActivity: error.remainingActivity, retryPath: error.retryPath,
  };
}

/** A refusal by this route itself, in the same contract shape as a failure. */
function refusal(
  code: string,
  message: string,
  fields: { knownCause: string; persistedState: string; remainingActivity: string; retryPath: string },
): Record<string, unknown> {
  return { code, message, diagnosticId: `ezer-recovery-${code.toLowerCase()}`, ...fields };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Holds, per operation, the failures this node recorded, the bounded recovery
 * budget they consumed and the checkpoint a recovery may resume from. The Ezer
 * journal stays the delivery/replay authority: the only cursor recorded here is
 * the one the journal already made durable, and a recovery hands that cursor
 * back rather than replaying anything from this memory.
 */
class EzerRecoveryService {
  private readonly states = new Map<string, OperationRecoveryState>();
  private readonly now: () => number;
  private readonly stopTask: typeof stopTaskExecution;
  private readonly cessation: EzerCessationObserver;
  private detachHeartbeatListener: (() => void) | null = null;
  private listenerStreaming: EzerStreamingService | null = null;

  constructor(private readonly deps: EzerRecoveryRoutesDeps) {
    this.now = deps.now ?? Date.now;
    this.stopTask = deps.stopTaskExecution ?? stopTaskExecution;
    this.cessation = createEzerCessationObserver(deps);
  }

  /**
   * Resolve the projection and, once it exists, watch its heartbeats so a
   * silence that outlasts its bounded budget is escalated from a liveness ping
   * to a structured error without anyone having to ask.
   */
  private streaming(): EzerStreamingService | null {
    const streaming = this.deps.getStreaming();
    if (streaming && streaming !== this.listenerStreaming) {
      this.detachHeartbeatListener?.();
      this.listenerStreaming = streaming;
      this.detachHeartbeatListener = streaming.onHeartbeat(
        (envelope, silentForMs) => this.escalateSilence(envelope, silentForMs),
      );
    }
    return streaming;
  }

  /** Attach the silence watch at startup rather than on the first request. */
  watchSilence(): boolean {
    return this.streaming() !== null;
  }

  private ensureState(operationId: string): OperationRecoveryState {
    let state = this.states.get(operationId);
    if (!state) {
      state = {
        operationId, taskId: null, ledger: new Map(), failures: [],
        technicalFailures: 0, recoveriesGranted: 0, grants: [], checkpoint: null,
        credentialRepairRequired: false, fenced: [], silenceEscalatedAtCursor: null, failureSeq: 0,
      };
      this.states.set(operationId, state);
    }
    return state;
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

  private activeAttempt(operationId: string): EzerActiveAttempt | null {
    return this.streaming()?.getActiveAttempt(operationId) ?? null;
  }

  /** What the journal has made durable for this operation, in words. */
  private describePersistedState(cursor: string | null, checkpointed: boolean): string {
    if (cursor === null) {
      return 'No journal cursor is durable for this operation yet, so nothing has been saved to resume from.';
    }
    return `Journal cursor ${cursor} is durable for this operation`
      + `${checkpointed ? ' and a recovery checkpoint was recorded at it' : ''}.`
      + ' Every event up to it is replayable from the Ezer journal.';
  }

  /** What is still running, stated from the observed attempt rather than assumed. */
  private describeRemainingActivity(active: EzerActiveAttempt | null, stoppedTarget: AttemptTarget | null): string {
    if (stoppedTarget) {
      return `Attempt ${stoppedTarget.attemptId} of execution ${stoppedTarget.executionId} was fenced and aborted;`
        + ' see the cessation evidence for whether its container was confirmed stopped.';
    }
    if (active && !active.completed && !active.fenced) {
      return `Attempt ${active.attemptId} of execution ${active.executionId} is still running;`
        + ' recording this failure did not stop it.';
    }
    if (active) {
      return `Attempt ${active.attemptId} of execution ${active.executionId} is`
        + ` ${active.fenced ? 'fenced and cannot publish' : 'finished'}; nothing else is known to be running.`;
    }
    return 'No attempt is publishing for this operation on this node.';
  }

  // -- silence escalation ---------------------------------------------------

  /**
   * One escalation per silence episode: the cursor cannot advance while the
   * provider is silent, so keying on it gives exactly one structured error
   * until real activity resumes — and a fresh one if silence returns.
   */
  private escalateSilence(envelope: EzerEventEnvelope, silentForMs: number): void {
    if (silentForMs < SILENCE_ESCALATION_MS) return;
    const state = this.ensureState(envelope.operationId);
    if (state.silenceEscalatedAtCursor === envelope.cursor) return;
    state.silenceEscalatedAtCursor = envelope.cursor;
    const target = { executionId: envelope.executionId, attemptId: envelope.attemptId };
    const classification = classifyObservedFailure(
      { kind: 'silence', status: null, message: null, source: 'the provider', headers: {}, timeoutMs: null, silentForMs },
      this.now(),
    );
    const error = this.recordClassifiedFailure(state, {
      classification, kind: 'silence', target,
      cursor: this.streaming()?.getOperationCursor(envelope.operationId) ?? null,
      stoppedTarget: null, fenced: false,
    });
    this.publishError(envelope.operationId, target, error, {
      requestId: envelope.requestId, sessionId: envelope.sessionId,
    });
  }

  /** Append a classified failure and return its structured error. */
  private recordClassifiedFailure(
    state: OperationRecoveryState,
    input: {
      classification: FailureClassification;
      kind: EzerFailureKind;
      target: AttemptTarget | null;
      cursor: string | null;
      stoppedTarget: AttemptTarget | null;
      fenced: boolean;
      cessation?: EzerCessationEvidence;
      terminalRecord?: TerminalRecord;
    },
  ): EzerStructuredError {
    state.failureSeq += 1;
    const failureId = `${state.operationId}:failure:${state.failureSeq}`;
    // Silence is an observation, not a fault: nothing failed and nothing was
    // spent, so it must not consume the bounded recovery budget.
    const technical = input.classification.failureClass !== 'silence';
    if (technical) state.technicalFailures += 1;
    if (input.classification.credentialFault) state.credentialRepairRequired = true;
    const checkpointed = technical && input.cursor !== null;
    if (checkpointed) {
      state.checkpoint = {
        cursor: input.cursor as string, recordedAt: this.iso(), target: input.target, failureId,
      };
    }
    const error = buildStructuredError(input.classification, {
      operationId: state.operationId,
      diagnosticId: failureId,
      persistedState: this.describePersistedState(input.cursor, checkpointed),
      remainingActivity: this.describeRemainingActivity(this.activeAttempt(state.operationId), input.stoppedTarget),
      attemptsUsed: state.recoveriesGranted,
    });
    state.failures.push({
      failureId, recordedAt: this.iso(),
      classification: technical ? 'technical-partial-failure' : 'observation',
      kind: input.kind, target: input.target, cursor: input.cursor, error, fenced: input.fenced,
      ...(input.cessation ? { cessation: input.cessation } : {}),
      ...(input.terminalRecord ? { terminalRecord: input.terminalRecord } : {}),
    });
    return error;
  }

  private publishError(
    operationId: string,
    target: AttemptTarget | null,
    error: EzerStructuredError,
    correlation: { requestId?: string; sessionId?: string },
  ): void {
    this.streaming()?.publishControlEvent({
      operationId, type: 'error', diagnosticId: error.diagnosticId,
      ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
      ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
      ...(target ? { executionId: target.executionId, attemptId: target.attemptId } : {}),
      summary: error.message,
      error: envelopeError(error),
    });
  }

  // -- idempotency ----------------------------------------------------------

  /**
   * Same key + same payload dedups to the original outcome without repeating
   * the action; same key + different payload is rejected outright, so a
   * reconnecting client's replay can never apply a second, different effect.
   */
  private resolveIdempotency(
    state: OperationRecoveryState,
    idempotencyKey: string,
    request: { commandId: string; payloadFingerprint: string },
    surface: 'failure' | 'recovery',
  ): RouteResult | null {
    const existing = state.ledger.get(idempotencyKey);
    if (!existing) return null;
    if (existing.payloadFingerprint === request.payloadFingerprint && existing.surface === surface) {
      existing.duplicateDeliveries += 1;
      return {
        httpStatus: 200,
        body: {
          deduplicated: true, duplicateDeliveries: existing.duplicateDeliveries,
          acceptedAt: existing.acceptedAt, ...(existing.outcome ?? {}),
        },
      };
    }
    return {
      httpStatus: 409,
      body: {
        deduplicated: false, accepted: false, granted: false,
        error: refusal(
          'IDEMPOTENCY_CONFLICT',
          `commandId "${request.commandId}" was already accepted for this session with a different payload.`,
          {
            knownCause: 'idempotency key reused with a conflicting payload fingerprint',
            persistedState: `The original ${existing.surface} request and its outcome are unchanged.`,
            remainingActivity: 'No failure was recorded and no recovery was granted by this request.',
            retryPath: 'Resend the conflicting payload under a new commandId.',
          },
        ),
        conflictsWith: {
          surface: existing.surface, payloadFingerprint: existing.payloadFingerprint,
          acceptedAt: existing.acceptedAt,
        },
      },
    };
  }

  private reserve(
    state: OperationRecoveryState,
    idempotencyKey: string,
    request: { commandId: string; payloadFingerprint: string },
    surface: 'failure' | 'recovery',
  ): LedgerEntry {
    const entry: LedgerEntry = {
      idempotencyKey, commandId: request.commandId, surface,
      payloadFingerprint: request.payloadFingerprint, acceptedAt: this.iso(),
      duplicateDeliveries: 0, outcome: null,
    };
    state.ledger.set(idempotencyKey, entry);
    return entry;
  }

  // -- failure reporting ----------------------------------------------------

  async recordFailure(raw: unknown, operationId: string, requestedBy: string): Promise<RouteResult> {
    const receivedAt = this.now();
    const parsed = parseFailureRequest(raw, operationId);
    if ('error' in parsed) {
      return {
        httpStatus: 400,
        body: {
          error: refusal('INVALID_FAILURE_REPORT', parsed.error, {
            knownCause: 'malformed failure report',
            persistedState: 'Nothing was recorded; no failure was accepted.',
            remainingActivity: 'Any existing attempt continues unchanged.',
            retryPath: 'Correct the report body and resend it with the same commandId.',
          }),
        },
      };
    }
    const request = parsed.request;
    const state = this.ensureState(operationId);
    if (request.taskId) state.taskId = request.taskId;

    const idempotencyKey = `${request.sessionId}|${operationId}|${request.commandId}`;
    const replay = this.resolveIdempotency(state, idempotencyKey, request, 'failure');
    if (replay) return replay;

    const targeting = this.resolveTarget(state, request.target, request.failure.kind);
    if ('error' in targeting) return targeting.error;

    const entry = this.reserve(state, idempotencyKey, request, 'failure');
    const outcome = request.failure.kind === 'timeout'
      ? await this.recordTimeout(state, request, targeting.target as AttemptTarget, { requestedBy, receivedAt })
      : this.recordProviderFailure(state, request, targeting.target);
    entry.outcome = outcome;
    return { httpStatus: 201, body: { deduplicated: false, acceptedAt: entry.acceptedAt, ...outcome } };
  }

  /** Failures act on the exact active attempt, or explicitly refuse. */
  private resolveTarget(
    state: OperationRecoveryState,
    requested: AttemptTarget | null,
    kind: EzerFailureKind,
  ): { target: AttemptTarget | null } | { error: RouteResult } {
    const active = this.activeAttempt(state.operationId);
    if (requested && active
      && (active.executionId !== requested.executionId || active.attemptId !== requested.attemptId)) {
      return {
        error: {
          httpStatus: 409,
          body: {
            accepted: false,
            error: refusal('ATTEMPT_MISMATCH', 'The targeted attempt is not the attempt this operation is currently running.', {
              knownCause: 'the targeted attempt was superseded or never active',
              persistedState: 'No failure was recorded; prior evidence is untouched.',
              remainingActivity: `Attempt ${active.attemptId} of execution ${active.executionId} continues unchanged.`,
              retryPath: 'Re-read the active attempt and resend the report against it under a new commandId.',
            }),
            activeAttempt: active,
          },
        },
      };
    }
    const target = active ? { executionId: active.executionId, attemptId: active.attemptId } : requested;
    if (!target && kind === 'timeout') {
      return {
        error: {
          httpStatus: 409,
          body: {
            accepted: false,
            error: refusal('NO_ACTIVE_ATTEMPT', 'A timeout must name the attempt it fences, and none is active for this operation.', {
              knownCause: 'no attempt has published to the journal stream for this operation',
              persistedState: `No failure was recorded for operation ${state.operationId}.`,
              remainingActivity: 'Nothing is known to be running for this operation on this node.',
              retryPath: 'Supply executionId and attemptId explicitly, or resend once the attempt has started publishing.',
            }),
          },
        },
      };
    }
    return { target };
  }

  private recordProviderFailure(
    state: OperationRecoveryState,
    request: FailureRequest,
    target: AttemptTarget | null,
  ): Record<string, unknown> {
    const classification = classifyObservedFailure(request.failure, this.now());
    const error = this.recordClassifiedFailure(state, {
      classification, kind: request.failure.kind, target,
      cursor: this.streaming()?.getOperationCursor(state.operationId) ?? null,
      stoppedTarget: null, fenced: false,
    });
    this.publishError(state.operationId, target, error, {
      ...(request.requestId ? { requestId: request.requestId } : {}), sessionId: request.sessionId,
    });
    return { failureId: error.diagnosticId, error, state: this.summarize(state) };
  }

  /**
   * Fence, propagate, observe, record — in that order. Fencing before the stop
   * means the timed-out attempt cannot publish even if the abort never lands,
   * and the terminal record is written from observed evidence rather than from
   * the fact that a stop was requested.
   */
  private async recordTimeout(
    state: OperationRecoveryState,
    request: FailureRequest,
    target: AttemptTarget,
    context: { requestedBy: string; receivedAt: number },
  ): Promise<Record<string, unknown>> {
    const streaming = this.streaming();
    streaming?.fenceAttempt(state.operationId, target.executionId, target.attemptId);
    if (!state.fenced.some(entry => entry.executionId === target.executionId && entry.attemptId === target.attemptId)) {
      state.fenced.push(target);
    }
    const taskId = request.taskId ?? state.taskId;
    const cessation = await this.abortTimedOutAttempt(taskId, request, context);
    const classification = classifyObservedFailure(request.failure, this.now());
    const terminalRecord: TerminalRecord = {
      recordedAt: this.iso(), state: 'failed', classification: 'technical-partial-failure',
      fencesLateOutput: true,
      cessationConfirmed: cessation.evidence.stopped,
      abortMarker: {
        written: cessation.abortMarkerWritten,
        pending: cessation.abortMarkerPending,
        consumed: cessation.evidence.abortMarkerCleared === true,
        taskId: taskId ?? null,
      },
      cancellationRecorded: cessation.cancellationRecorded,
    };
    const error = this.recordClassifiedFailure(state, {
      classification, kind: 'timeout', target,
      cursor: this.streaming()?.getOperationCursor(state.operationId) ?? null,
      stoppedTarget: target, fenced: true, cessation: cessation.evidence, terminalRecord,
    });
    this.publishError(state.operationId, target, error, {
      ...(request.requestId ? { requestId: request.requestId } : {}), sessionId: request.sessionId,
    });
    return {
      failureId: error.diagnosticId, error, fenced: true, target,
      cessation: cessation.evidence, terminalRecord, state: this.summarize(state),
    };
  }

  /** Propagates the abort to the real ProPR job and observes what followed. */
  private async abortTimedOutAttempt(
    taskId: string | null,
    request: FailureRequest,
    context: { requestedBy: string; receivedAt: number },
  ): Promise<AbortOutcome> {
    if (!taskId) {
      return {
        evidence: {
          stopped: false,
          reason: 'No ProPR task binding is known for this operation, so the abort could not be propagated or observed.',
        },
        abortMarkerWritten: false, abortMarkerPending: false, cancellationRecorded: false,
      };
    }
    let stop: StopTaskExecutionResult;
    try {
      stop = await this.stopTask(taskId, {
        redisClient: this.deps.redisClient,
        requestedBy: context.requestedBy,
        reason: `Timed out; aborted by Ezer failure report ${request.commandId}.`,
        cancellationReason: 'ezer_execution_timeout',
        ensureCancelled: true,
      });
    } catch (error) {
      return {
        evidence: { stopped: false, reason: `The abort could not be propagated: ${(error as Error).message}` },
        abortMarkerWritten: false, abortMarkerPending: false, cancellationRecorded: false,
      };
    }
    const cancellationRecorded = stop.cancellationRecorded ?? false;
    // `abortSignalled` means the marker is still outstanding for the worker to
    // observe — it is not the question of whether one was written at all.
    const abortMarkerPending = stop.abortSignalled === true;
    const abortMarkerWritten = abortMarkerPending || !(stop.notFound || stop.notRunning);
    if (stop.notFound || stop.notRunning) {
      return {
        evidence: {
          stopped: true,
          jobPresence: stop.notFound ? 'absent' : 'inactive',
          workerState: stop.currentState ?? null,
          abortMarkerRequired: false,
        },
        abortMarkerWritten, abortMarkerPending, cancellationRecorded,
      };
    }
    const evidence = await this.cessation.observe(taskId, abortMarkerPending, context.receivedAt);
    return { evidence, abortMarkerWritten, abortMarkerPending, cancellationRecorded };
  }

  // -- recovery -------------------------------------------------------------

  requestRecovery(raw: unknown, operationId: string): RouteResult {
    const parsed = parseRecoveryRequest(raw, operationId);
    if ('error' in parsed) {
      return {
        httpStatus: 400,
        body: {
          error: refusal('INVALID_RECOVERY_REQUEST', parsed.error, {
            knownCause: 'malformed recovery request',
            persistedState: 'Nothing was recorded; no recovery was granted.',
            remainingActivity: 'Any existing attempt continues unchanged.',
            retryPath: 'Correct the request body and resend it with the same commandId.',
          }),
        },
      };
    }
    const request = parsed.request;
    const state = this.ensureState(operationId);
    const idempotencyKey = `${request.sessionId}|${operationId}|${request.commandId}`;
    const replay = this.resolveIdempotency(state, idempotencyKey, request, 'recovery');
    if (replay) return replay;

    const blocked = this.blockRecovery(state, request);
    if (blocked) return blocked;

    const entry = this.reserve(state, idempotencyKey, request, 'recovery');
    const outcome = this.grantRecovery(state, request);
    entry.outcome = outcome;
    return { httpStatus: 202, body: { deduplicated: false, acceptedAt: entry.acceptedAt, ...outcome } };
  }

  /**
   * Every reason a recovery must NOT be granted, checked before the ledger
   * reserves the key — a refusal is not an accepted action and must stay
   * resendable under the same commandId once its cause is cleared.
   */
  private blockRecovery(state: OperationRecoveryState, request: RecoveryRequest): RouteResult | null {
    const summary = this.summarize(state);
    if (state.recoveriesGranted >= RECOVERY_ATTEMPT_BUDGET) {
      return this.refuseRecovery('RECOVERY_BUDGET_EXHAUSTED',
        `All ${RECOVERY_ATTEMPT_BUDGET} bounded recovery attempts for this operation are used.`, {
          knownCause: 'the bounded recovery budget for this operation is exhausted',
          persistedState: `${state.technicalFailures} technical partial failure(s) are recorded and the count is unchanged by this refusal.`,
          remainingActivity: 'Nothing was started; the recorded failures stand.',
          retryPath: 'Escalate this operation for review. The recovery count is deliberately not reset by a further request.',
        }, summary);
    }
    const active = this.activeAttempt(state.operationId);
    if (active && !active.completed && !active.fenced) {
      return this.refuseRecovery('ATTEMPT_STILL_ACTIVE',
        `Attempt ${active.attemptId} is still running; recovering now would duplicate it.`, {
          knownCause: 'an attempt for this operation is still publishing to the journal',
          persistedState: 'No recovery was granted and no continuation was created.',
          remainingActivity: `Attempt ${active.attemptId} of execution ${active.executionId} continues unchanged.`,
          retryPath: 'Wait for the attempt to reach a result, or cancel it through the control endpoint, then resend.',
        }, summary);
    }
    // Only a retry makes a new author call, so only a retry is gated by the
    // credential repair and by the provider's reset time. A valid checkpoint
    // resume calls nobody and must not be blocked by a deadline it never hits.
    if (request.action !== 'retry') return null;
    return this.blockRetry(state, request, summary);
  }

  private blockRetry(
    state: OperationRecoveryState,
    request: RecoveryRequest,
    summary: Record<string, unknown>,
  ): RouteResult | null {
    if (state.credentialRepairRequired && !request.credentialRepaired) {
      const rejected = this.latestFailure(state, record => record.error.recovery.credentialFault);
      return this.refuseRecovery('RECOVERY_REQUIRES_CREDENTIAL_REPAIR',
        'A credential the provider rejected is still in place, and no retry or wait can clear it.', {
          knownCause: rejected?.error.knownCause ?? 'the provider rejected the request credential',
          persistedState: rejected?.error.persistedState ?? 'Nothing further was saved by this refusal.',
          remainingActivity: 'No retry was started; the credential is still the one the provider rejected.',
          retryPath: 'Replace the provider credential, then resend this action with "credentialRepaired": true'
            + ' under a new commandId. This is a credential failure, not a quota failure.',
        }, summary);
    }
    // The barrier is the furthest still-future reset across EVERY recorded
    // failure, not the newest one's: a later unrelated fault must not retire a
    // quota reset that has not actually elapsed.
    const barrier = this.retryBarrier(state);
    if (!barrier) return null;
    return this.refuseRecovery('RETRY_BEFORE_RESET',
      `A retry is not permitted before ${barrier.notBefore}.`, {
        knownCause: barrier.failure.error.knownCause,
        persistedState: barrier.failure.error.persistedState,
        remainingActivity: 'No retry was started; no request was sent to the provider.',
        retryPath: `Retry at or after ${barrier.notBefore} (${barrier.failure.error.recovery.resetSource}).`
          + ' Retrying earlier would spend quota that has not reset.',
      }, summary);
  }

  /** The furthest still-future reset time any recorded failure declared. */
  private retryBarrier(state: OperationRecoveryState): { notBefore: string; failure: FailureRecord } | null {
    let furthest: { notBefore: string; at: number; failure: FailureRecord } | null = null;
    for (const failure of state.failures) {
      const notBefore = failure.error.recovery.retryNotBefore;
      if (notBefore === null) continue;
      const at = Date.parse(notBefore);
      if (Number.isNaN(at) || at <= this.now()) continue;
      if (!furthest || at > furthest.at) furthest = { notBefore, at, failure };
    }
    return furthest ? { notBefore: furthest.notBefore, failure: furthest.failure } : null;
  }

  private refuseRecovery(
    code: string,
    message: string,
    fields: { knownCause: string; persistedState: string; remainingActivity: string; retryPath: string },
    summary: Record<string, unknown>,
  ): RouteResult {
    return {
      httpStatus: 409,
      body: {
        deduplicated: false, granted: false,
        // A refusal is neither an approval nor a completion, and neither is a grant.
        approvalGranted: false, completionClaimed: false,
        error: refusal(code, message, fields), state: summary,
      },
    };
  }

  private latestFailure(
    state: OperationRecoveryState,
    matches: (record: FailureRecord) => boolean,
  ): FailureRecord | null {
    for (let index = state.failures.length - 1; index >= 0; index -= 1) {
      if (matches(state.failures[index])) return state.failures[index];
    }
    return null;
  }

  /**
   * Whether the saved checkpoint still describes the world: the journal has not
   * moved past it, and the attempt it was taken from is no longer publishing.
   */
  private checkpointValidity(state: OperationRecoveryState): { valid: boolean; reason: string } {
    const checkpoint = state.checkpoint;
    if (!checkpoint) {
      return { valid: false, reason: 'No checkpoint was recorded for this operation.' };
    }
    const cursor = this.streaming()?.getOperationCursor(state.operationId) ?? null;
    if (cursor !== checkpoint.cursor) {
      return {
        valid: false,
        reason: `The journal has advanced to cursor ${cursor ?? 'none'} past the checkpoint at ${checkpoint.cursor},`
          + ' so the saved state is no longer the operation\'s latest durable state.',
      };
    }
    const active = this.activeAttempt(state.operationId);
    if (active && !active.completed && !active.fenced) {
      return { valid: false, reason: `Attempt ${active.attemptId} is still publishing, so there is nothing to resume.` };
    }
    return { valid: true, reason: `Checkpoint at cursor ${checkpoint.cursor} matches the last durable journal cursor.` };
  }

  private grantRecovery(state: OperationRecoveryState, request: RecoveryRequest): Record<string, unknown> {
    const validity = this.checkpointValidity(state);
    if (request.action === 'resume-from-checkpoint' && !validity.valid) {
      return {
        granted: false, action: request.action,
        approvalGranted: false, completionClaimed: false,
        error: refusal('CHECKPOINT_INVALID', 'The saved checkpoint cannot be resumed.', {
          knownCause: validity.reason,
          persistedState: this.describePersistedState(
            this.streaming()?.getOperationCursor(state.operationId) ?? null, state.checkpoint !== null),
          remainingActivity: this.describeRemainingActivity(this.activeAttempt(state.operationId), null),
          retryPath: 'Resend with {"action":"retry"} under a new commandId to start exactly one new attempt;'
            + ' that does require a new author call.',
        }),
        state: this.summarize(state),
      };
    }
    state.recoveriesGranted += 1;
    // The caller asserted the rejected credential was replaced and the retry was
    // admitted on that assertion, so the standing repair requirement is cleared.
    if (request.credentialRepaired) state.credentialRepairRequired = false;
    // A valid checkpoint carries the work already done, so continuing from it
    // needs no new author call. Nothing here marks the operation approved or
    // complete: a recovery resumes a cursor and admits one continuation.
    const authorCallRequired = request.action === 'retry' || !validity.valid;
    const grant: RecoveryGrant = {
      action: request.action, grantedAt: this.iso(),
      resumeCursor: state.checkpoint?.cursor ?? this.streaming()?.getOperationCursor(state.operationId) ?? null,
      authorCallRequired,
      authorCallReason: authorCallRequired
        ? 'A retry starts a new attempt, which requires a new author call.'
        : validity.reason + ' Resuming it continues the saved work, so no new author call is made.',
      continuationId: `${state.operationId}:continuation:${state.recoveriesGranted}`,
    };
    state.grants.push(grant);
    return {
      granted: true, action: request.action,
      recovery: {
        ...grant,
        /** Reconnect with this cursor; the journal replays only what follows it. */
        replayFrom: grant.resumeCursor,
        bounded: true,
        attemptsUsed: state.recoveriesGranted,
        attemptsRemaining: Math.max(0, RECOVERY_ATTEMPT_BUDGET - state.recoveriesGranted),
        budget: RECOVERY_ATTEMPT_BUDGET,
        /** Unchanged by this grant: a recovery never resets the failure count. */
        technicalFailures: state.technicalFailures,
      },
      approvalGranted: false, completionClaimed: false,
      summary: `Recovery ${grant.continuationId} admitted from cursor ${grant.resumeCursor ?? 'the start of the operation'}.`
        + ' It grants no approval and claims no completion.',
      state: this.summarize(state),
    };
  }

  // -- reads ----------------------------------------------------------------

  private summarize(state: OperationRecoveryState): Record<string, unknown> {
    return {
      technicalFailures: state.technicalFailures,
      recoveriesGranted: state.recoveriesGranted,
      recoveryBudget: RECOVERY_ATTEMPT_BUDGET,
      attemptsRemaining: Math.max(0, RECOVERY_ATTEMPT_BUDGET - state.recoveriesGranted),
      // The gate a retry will actually meet, not the newest failure's copy of it.
      retryNotBefore: this.retryBarrier(state)?.notBefore ?? null,
      credentialRepairRequired: state.credentialRepairRequired,
      checkpoint: state.checkpoint,
      fencedAttempts: state.fenced,
    };
  }

  describe(operationId: string): Record<string, unknown> {
    const state = this.states.get(operationId);
    const active = this.activeAttempt(operationId);
    if (!state) {
      return {
        operationId, activeAttempt: active, taskId: null,
        technicalFailures: 0, recoveriesGranted: 0, recoveryBudget: RECOVERY_ATTEMPT_BUDGET,
        attemptsRemaining: RECOVERY_ATTEMPT_BUDGET, retryNotBefore: null,
        credentialRepairRequired: false, checkpoint: null, checkpointValid: false,
        fencedAttempts: [], failures: [], grants: [], commands: [],
        approvalGranted: false, completionClaimed: false,
      };
    }
    const validity = this.checkpointValidity(state);
    return {
      operationId, activeAttempt: active, taskId: state.taskId,
      ...this.summarize(state),
      checkpointValid: validity.valid,
      checkpointStatus: validity.reason,
      failures: state.failures,
      grants: state.grants,
      commands: [...state.ledger.values()].map(entry => ({
        commandId: entry.commandId, surface: entry.surface,
        payloadFingerprint: entry.payloadFingerprint, acceptedAt: entry.acceptedAt,
        duplicateDeliveries: entry.duplicateDeliveries,
      })),
      // Stated on every read so no consumer can infer either from a recovery.
      approvalGranted: false, completionClaimed: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Failure/recovery routes for an Ezer operation. They sit behind the
 * authenticated `/api` guard and additionally require the same access the
 * operation's progress stream requires, so recording a failure or claiming a
 * recovery is never broader than read access to the operation.
 */
export function createEzerRecoveryRoutes(deps: EzerRecoveryRoutesDeps) {
  const service = new EzerRecoveryService(deps);

  async function authorize(req: FlatRequest, res: Response, operationId: string): Promise<boolean> {
    const streaming = deps.getStreaming();
    const userId = req.user?.id;
    if (!streaming || !userId) {
      res.status(503).json({
        error: refusal('RECOVERY_PLANE_UNAVAILABLE', 'The Ezer stream projection is not available on this node.', {
          knownCause: 'socket projection not initialised',
          persistedState: 'No failure was recorded and no recovery was granted.',
          remainingActivity: 'Any running attempt continues unchanged.',
          retryPath: 'Retry once the API node has finished starting up.',
        }),
      });
      return false;
    }
    const allowed = await streaming.authorizeSubscription(operationId, {
      user: { id: userId },
      authorization: { permissions: req.authorization?.permissions ?? [] },
    });
    if (!allowed) {
      res.status(404).json({
        error: refusal('OPERATION_NOT_FOUND', 'No accessible Ezer operation matches that ID.', {
          knownCause: 'unknown operation or insufficient access',
          persistedState: 'No failure was recorded and no recovery was granted.',
          remainingActivity: 'unknown',
          retryPath: 'Verify the operation ID and your access to it.',
        }),
      });
      return false;
    }
    return true;
  }

  function readOperationId(req: FlatRequest, res: Response): string | null {
    const operationId = typeof req.params.operationId === 'string' ? req.params.operationId.trim() : '';
    if (!operationId || operationId.length > MAX_IDENTIFIER_LENGTH) {
      res.status(400).json({
        error: refusal('INVALID_OPERATION_ID', 'A non-empty operation ID is required.', {
          knownCause: 'malformed operation ID',
          persistedState: 'No failure was recorded and no recovery was granted.',
          remainingActivity: 'unknown',
          retryPath: 'Resend the request with a valid operation ID.',
        }),
      });
      return null;
    }
    return operationId;
  }

  function failed(res: Response, code: string, error: unknown, activity: string): void {
    res.status(500).json({
      error: refusal(code, 'The request could not be processed.', {
        knownCause: (error as Error).message,
        persistedState: 'See GET /api/ezer/operations/:operationId/recovery for what was recorded.',
        remainingActivity: activity,
        retryPath: 'Re-read the recovery state, then resend under a new commandId if the request did not take effect.',
      }),
    });
  }

  async function postFailure(req: FlatRequest, res: Response): Promise<void> {
    const operationId = readOperationId(req, res);
    if (!operationId) return;
    try {
      if (!await authorize(req, res, operationId)) return;
      const result = await service.recordFailure(req.body, operationId, req.user?.username || 'user');
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      console.error('[ezer-recovery] Failed to record a failure for %s:', operationId, error);
      failed(res, 'FAILURE_REPORT_FAILED', error, 'unknown — the reported attempt may still be running.');
    }
  }

  async function postRecovery(req: FlatRequest, res: Response): Promise<void> {
    const operationId = readOperationId(req, res);
    if (!operationId) return;
    try {
      if (!await authorize(req, res, operationId)) return;
      const result = service.requestRecovery(req.body, operationId);
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      console.error('[ezer-recovery] Failed to process a recovery request for %s:', operationId, error);
      failed(res, 'RECOVERY_REQUEST_FAILED', error, 'unknown — no continuation is known to have started.');
    }
  }

  async function getRecovery(req: FlatRequest, res: Response): Promise<void> {
    const operationId = readOperationId(req, res);
    if (!operationId) return;
    try {
      if (!await authorize(req, res, operationId)) return;
      res.json(service.describe(operationId));
    } catch (error) {
      console.error('[ezer-recovery] Failed to read the recovery state for %s:', operationId, error);
      failed(res, 'RECOVERY_STATE_UNREADABLE', error, 'unknown — no attempt was altered by this request.');
    }
  }

  /**
   * Start watching the projection for silence. Called once the socket service
   * exists so a long silence is escalated even when no client has yet touched
   * these routes; it is idempotent and safe to call again.
   */
  function watchSilence(): boolean {
    return service.watchSilence();
  }

  return { postFailure, postRecovery, getRecovery, watchSilence };
}

/* eslint-disable max-lines -- one projection owns the operation/attempt state,
   so S03's control-event publication and attempt lookups belong on it rather
   than in a second module that would become a competing source of truth. */
/**
 * EP-ezer-follow-ups-S02 — Real incremental progress streaming (REQ-EF17).
 *
 * ProPR lane of the approved story: project Ezer journal events over the
 * existing Socket.IO channel. The Ezer journal is the only replay/delivery
 * authority; this module is transport/projection only and keeps no second
 * source of truth. It enforces the contract.md envelope, monotonic cursors,
 * stale-attempt fencing, and the rule that a completed answer is never
 * replayed as incremental output (AC-S02-1, AC-S02-2).
 */

/** Redis pub/sub channel that carries journal-authored Ezer envelopes. */
export const EZER_REDIS_CHANNEL = 'propr:events:ezer';

/** Socket.IO event name for projected Ezer stream envelopes. */
export const EZER_STREAM_EVENT = 'ezer:stream:event';

/** Socket.IO event acknowledging a stream subscription/resume request. */
export const EZER_STREAM_SUBSCRIBED = 'ezer:stream:subscribed';

/**
 * Design targets from contract.md (proposed, tuned during implementation):
 * heartbeat while work is pending within 10s, observable event delivery and
 * request/control acks within 2s of the real state change.
 */
export const EZER_HEARTBEAT_INTERVAL_MS = 10_000;
export const EZER_DELIVERY_TARGET_MS = 2_000;

export type EzerEventType = 'progress' | 'heartbeat' | 'control-ack' | 'result' | 'error';

export type EzerProgressKind = 'start' | 'intermediate' | 'delay' | 'retry' | 'blocker' | 'stop';

const EVENT_TYPES: ReadonlySet<string> = new Set(['progress', 'heartbeat', 'control-ack', 'result', 'error']);
const PROGRESS_KINDS: ReadonlySet<string> = new Set(['start', 'intermediate', 'delay', 'retry', 'blocker', 'stop']);
const REQUIRED_STRING_FIELDS = [
  'requestId', 'sessionId', 'operationId', 'executionId', 'attemptId', 'cursor', 'summary',
] as const;
const DETAIL_STRING_FIELDS = ['reason', 'nextAttemptAt', 'cause', 'nextAction'] as const;
const ERROR_STRING_FIELDS = [
  'code', 'message', 'diagnosticId', 'knownCause', 'persistedState', 'remainingActivity', 'retryPath',
] as const;
const UNASSIGNED = 'unassigned';

/**
 * Structured progress detail: delay/retry carry `reason` (retry also
 * `nextAttemptAt`), blocker carries `cause`/`nextAction`.
 */
export type EzerProgressDetail = Partial<Record<(typeof DETAIL_STRING_FIELDS)[number], string>> & {
  kind?: EzerProgressKind;
  percentComplete?: number;
};

/** Error fields required by the contract (fully enforced by S04). */
export type EzerErrorDetail = Partial<Record<(typeof ERROR_STRING_FIELDS)[number], string>>;

/**
 * contract.md event envelope: observable activity only, never hidden
 * reasoning. `cursor` is the journal-issued monotonic cursor; heartbeats
 * reuse the last durable cursor. `diagnosticId` is required for
 * heartbeat/error envelopes.
 */
export interface EzerEventEnvelope extends Record<(typeof REQUIRED_STRING_FIELDS)[number], string> {
  type: EzerEventType;
  ts: string;
  diagnosticId?: string;
  detail?: EzerProgressDetail;
  error?: EzerErrorDetail;
}

/**
 * Read-through interface to the canonical Ezer journal. Reconnect replay MUST
 * go through this reader; the projection never serves history from its own
 * memory, so it cannot drift into a second source of truth.
 */
export interface EzerJournalReader {
  /** Journal events for an operation strictly after the cursor, in cursor order. */
  readAfter(operationId: string, afterCursor: string | null): Promise<unknown[]>;
  /** Whether the journal knows the operation (used to authorize subscriptions). */
  hasOperation?(operationId: string): Promise<boolean>;
}

export type EzerDropReason =
  | 'malformed' | 'unsupported-type' | 'missing-field' | 'invalid-timestamp'
  | 'stale-cursor' | 'fenced-attempt' | 'duplicate-result' | 'completed-answer-replay'
  | 'after-terminal' | 'stale-replay' | 'wrong-operation';

export type EzerIngestResult =
  | { accepted: true; envelope: EzerEventEnvelope }
  | { accepted: false; reason: EzerDropReason };

export interface EzerDropRecord { reason: EzerDropReason; operationId?: string; cursor?: string; at: string }

/** Minimal principal shape needed to authorize a stream subscription. */
export interface EzerSubscriptionPrincipal { user: { id: string }; authorization: { permissions: string[] } }

export interface EzerStreamSubscriber { id: string; send: (event: string, payload: unknown) => void }

/**
 * The attempt an operation is currently publishing under, as observed on the
 * live journal stream. S03 control commands target exactly this attempt.
 */
export interface EzerActiveAttempt {
  executionId: string;
  attemptId: string;
  /** The attempt already delivered its final result. */
  completed: boolean;
  /** The attempt was fenced (cancel/timeout) and can no longer publish. */
  fenced: boolean;
}

/** A control event authored locally by ProPR rather than by the Ezer journal. */
interface EzerControlEventInput {
  operationId: string;
  type: Exclude<EzerEventType, 'heartbeat'>;
  summary: string;
  requestId?: string;
  sessionId?: string;
  executionId?: string;
  attemptId?: string;
  diagnosticId?: string;
  detail?: EzerProgressDetail;
  error?: EzerErrorDetail;
}

export interface EzerStreamingMetrics { delivered: number; dropped: number; maxProjectionDelayMs: number }

export interface EzerStreamingOptions {
  heartbeatIntervalMs?: number;
  journal?: EzerJournalReader;
  now?: () => number;
  scheduleTimer?: (fn: () => void, ms: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
  onDrop?: (drop: EzerDropRecord) => void;
}

/**
 * Order two journal cursors. Cursors are journal-issued monotonic strings:
 * pure decimal cursors compare numerically (padded or not); anything else
 * compares by length then lexicographically, which preserves order for
 * fixed-width and length-prefixed encodings.
 */
export function compareEzerCursors(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function sanitizeDetail(raw: unknown): EzerProgressDetail | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const detail: EzerProgressDetail = {};
  if (typeof source.kind === 'string' && PROGRESS_KINDS.has(source.kind)) detail.kind = source.kind as EzerProgressKind;
  for (const field of DETAIL_STRING_FIELDS) {
    const value = readString(source, field);
    if (value) detail[field] = value;
  }
  const percent = source.percentComplete;
  if (typeof percent === 'number' && Number.isFinite(percent)) detail.percentComplete = percent;
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function sanitizeError(raw: unknown): EzerErrorDetail | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const error: EzerErrorDetail = {};
  for (const field of ERROR_STRING_FIELDS) {
    const value = readString(source, field);
    if (value) error[field] = value;
  }
  return Object.keys(error).length > 0 ? error : undefined;
}

/**
 * Validate an incoming journal event and rebuild it from an explicit field
 * whitelist. Undeclared fields are dropped so hidden reasoning or other
 * non-contract payloads can never transit the projection.
 */
export function sanitizeEzerEnvelope(raw: unknown): { envelope?: EzerEventEnvelope; reason?: EzerDropReason } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { reason: 'malformed' };
  const source = raw as Record<string, unknown>;
  if (typeof source.type !== 'string' || !EVENT_TYPES.has(source.type)) return { reason: 'unsupported-type' };
  const envelope: Partial<EzerEventEnvelope> = { type: source.type as EzerEventType };
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = readString(source, field);
    if (!value) return { reason: 'missing-field' };
    envelope[field] = value;
  }
  const ts = readString(source, 'ts');
  if (!ts || Number.isNaN(Date.parse(ts))) return { reason: 'invalid-timestamp' };
  envelope.ts = ts;
  const diagnosticId = readString(source, 'diagnosticId');
  if (diagnosticId) envelope.diagnosticId = diagnosticId;
  if ((envelope.type === 'heartbeat' || envelope.type === 'error') && !diagnosticId) return { reason: 'missing-field' };
  const detail = sanitizeDetail(source.detail);
  if (detail) envelope.detail = detail;
  const error = sanitizeError(source.error);
  if (error) envelope.error = error;
  return { envelope: envelope as EzerEventEnvelope };
}

interface SubscriberState {
  id: string;
  send: (event: string, payload: unknown) => void;
  /** Highest journal cursor delivered to this subscriber; the dedup fence. */
  deliveredUpTo: string | null;
  /** Live events arriving during journal replay are held to preserve order. */
  replaying: boolean;
  backlog: EzerEventEnvelope[];
}

interface ExecutionState { admittedAttemptId: string; completed: boolean }

interface OperationState {
  operationId: string;
  requestId: string | null;
  sessionId: string | null;
  ownerUserId: string | null;
  /** Work accepted but no final result yet — heartbeats fire while true. */
  pending: boolean;
  lastCursor: string | null;
  lastEnvelope: EzerEventEnvelope | null;
  lastActivityAt: number;
  heartbeatSeq: number;
  heartbeatTimer: unknown;
  executions: Map<string, ExecutionState>;
  fencedAttempts: Set<string>;
  subscribers: Map<string, SubscriberState>;
}

function attemptKey(executionId: string, attemptId: string): string {
  return `${executionId} ${attemptId}`;
}

/**
 * Journal-to-Socket.IO projection for Ezer operation streams.
 *
 * Responsibilities per contract.md:
 * - project journal envelopes to subscribers as real state changes occur;
 * - synthesize heartbeats (with diagnosticId) whenever no progress has been
 *   observed within the target interval, so silence is distinguishable from work;
 * - enforce monotonic cursors, exactly-once per-subscriber delivery, and
 *   attempt fencing (a superseded or explicitly fenced attempt cannot publish);
 * - resume reconnects from the acknowledged cursor via the journal reader only.
 */
export class EzerStreamingService {
  private readonly operations = new Map<string, OperationState>();
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => number;
  private readonly scheduleTimer: (fn: () => void, ms: number) => unknown;
  private readonly cancelTimer: (handle: unknown) => void;
  private readonly onDrop: ((drop: EzerDropRecord) => void) | null;
  private journal: EzerJournalReader | null;
  private readonly envelopeListeners = new Set<(envelope: EzerEventEnvelope) => void>();
  private closed = false;
  private readonly metrics: EzerStreamingMetrics = { delivered: 0, dropped: 0, maxProjectionDelayMs: 0 };

  constructor(options: EzerStreamingOptions = {}) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? EZER_HEARTBEAT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.scheduleTimer = options.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancelTimer = options.cancelTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout));
    this.journal = options.journal ?? null;
    this.onDrop = options.onDrop ?? null;
  }

  /** Install the canonical journal reader used for reconnect replay. */
  setJournalReader(reader: EzerJournalReader | null): void { this.journal = reader; }

  getMetrics(): EzerStreamingMetrics { return { ...this.metrics }; }

  /**
   * Register an accepted operation so heartbeats fire from acknowledgement
   * onward — a long-silent provider is observable before its first event.
   */
  registerOperation(input: { operationId: string; requestId?: string; sessionId?: string; ownerUserId?: string }): void {
    const operation = this.ensureOperation(input.operationId);
    if (input.requestId) operation.requestId = input.requestId;
    if (input.sessionId) operation.sessionId = input.sessionId;
    if (input.ownerUserId) operation.ownerUserId = input.ownerUserId;
    operation.pending = true;
    operation.lastActivityAt = this.now();
    this.armHeartbeat(operation);
  }

  /**
   * Fence an attempt (cancel/timeout path): later publications from it are
   * refused even before a replacement attempt exists.
   */
  fenceAttempt(operationId: string, executionId: string, attemptId: string): void {
    const operation = this.ensureOperation(operationId);
    operation.fencedAttempts.add(attemptKey(executionId, attemptId));
    const execution = operation.executions.get(executionId);
    if (execution && execution.admittedAttemptId === attemptId) execution.completed = true;
  }

  /** The last durable journal cursor projected for an operation, if any. */
  getOperationCursor(operationId: string): string | null {
    return this.operations.get(operationId)?.lastCursor ?? null;
  }

  /** Whether this exact attempt has been fenced out of publishing. */
  isAttemptFenced(operationId: string, executionId: string, attemptId: string): boolean {
    return this.operations.get(operationId)?.fencedAttempts.has(attemptKey(executionId, attemptId)) ?? false;
  }

  /**
   * The attempt the operation is currently publishing under. Control commands
   * resolve their target through this so they act on the exact active attempt
   * rather than on a stale or replacement one.
   */
  getActiveAttempt(operationId: string): EzerActiveAttempt | null {
    const operation = this.operations.get(operationId);
    const last = operation?.lastEnvelope;
    if (!operation || !last) return null;
    const execution = operation.executions.get(last.executionId);
    if (!execution) return null;
    return {
      executionId: last.executionId,
      attemptId: execution.admittedAttemptId,
      completed: execution.completed,
      fenced: operation.fencedAttempts.has(attemptKey(last.executionId, execution.admittedAttemptId)),
    };
  }

  /**
   * Observe every envelope this projection accepts. The S03 control plane uses
   * it to flip an accepted steering revision to applied when real subsequent
   * activity appears, instead of assuming acceptance took effect.
   */
  onEnvelope(listener: (envelope: EzerEventEnvelope) => void): () => void {
    this.envelopeListeners.add(listener);
    return () => { this.envelopeListeners.delete(listener); };
  }

  /**
   * Publish a control event that ProPR authored locally (an acknowledgement or
   * the later confirmation of real downstream state). Like a heartbeat, it is a
   * projection-level signal rather than a journal event: it reuses the last
   * durable cursor, never advances it, and is never part of replay — so the
   * journal stays the only delivery/replay authority.
   */
  publishControlEvent(input: EzerControlEventInput): EzerEventEnvelope {
    const operation = this.ensureOperation(input.operationId);
    const envelope = this.buildControlEnvelope(operation, input);
    for (const subscriber of operation.subscribers.values()) {
      if (!subscriber.replaying) this.send(subscriber, EZER_STREAM_EVENT, envelope);
    }
    operation.lastActivityAt = this.now();
    this.armHeartbeat(operation);
    return envelope;
  }

  async operationExists(operationId: string): Promise<boolean> {
    if (this.operations.has(operationId)) return true;
    if (!this.journal?.hasOperation) return false;
    try {
      return await this.journal.hasOperation(operationId);
    } catch (error) {
      console.error('[EzerStreaming] Journal lookup failed for %s:', operationId, error);
      return false;
    }
  }

  /**
   * A subscription is allowed when the operation is known (registry or
   * journal) and either has no recorded owner, is owned by the principal, or
   * the principal can manage the instance — mirroring task-room semantics.
   */
  async authorizeSubscription(operationId: string, principal: EzerSubscriptionPrincipal): Promise<boolean> {
    if (!await this.operationExists(operationId)) return false;
    const operation = this.operations.get(operationId);
    if (!operation?.ownerUserId) return true;
    return operation.ownerUserId === principal.user.id
      || principal.authorization.permissions.includes('instance.manage_settings');
  }

  /** Parse and ingest a serialized journal envelope from the Redis channel. */
  ingestSerialized(message: string): EzerIngestResult {
    try {
      return this.ingest(JSON.parse(message));
    } catch {
      return this.drop('malformed');
    }
  }

  /**
   * Project one journal-authored envelope. The journal has already ordered the
   * stream; this validates the envelope, applies cursor/fencing/terminal rules
   * and delivers to subscribers within the same tick (2s design target).
   */
  ingest(raw: unknown): EzerIngestResult {
    const { envelope, reason } = sanitizeEzerEnvelope(raw);
    if (!envelope) return this.drop(reason ?? 'malformed');
    const operation = this.ensureOperation(envelope.operationId);
    if (operation.requestId === null) operation.requestId = envelope.requestId;
    if (operation.sessionId === null) operation.sessionId = envelope.sessionId;
    if (operation.lastCursor !== null && compareEzerCursors(envelope.cursor, operation.lastCursor) <= 0) {
      return this.drop('stale-cursor', envelope.operationId, envelope.cursor);
    }
    if (operation.fencedAttempts.has(attemptKey(envelope.executionId, envelope.attemptId))) {
      return this.drop('fenced-attempt', envelope.operationId, envelope.cursor);
    }
    const execution = operation.executions.get(envelope.executionId);
    if (!execution) {
      operation.executions.set(envelope.executionId, { admittedAttemptId: envelope.attemptId, completed: false });
    } else if (execution.admittedAttemptId !== envelope.attemptId) {
      // Journal order is authoritative: a new attempt supersedes the admitted
      // one, which is fenced so it can never publish into its replacement.
      operation.fencedAttempts.add(attemptKey(envelope.executionId, execution.admittedAttemptId));
      execution.admittedAttemptId = envelope.attemptId;
      execution.completed = false;
    } else if (execution.completed && envelope.type !== 'control-ack') {
      // The attempt already delivered its final answer. A later `result` is a
      // duplicate; a later `progress` would replay the completed answer as
      // incremental output, which the story explicitly forbids.
      const terminalReason: EzerDropReason = envelope.type === 'result'
        ? 'duplicate-result'
        : envelope.type === 'progress' ? 'completed-answer-replay' : 'after-terminal';
      return this.drop(terminalReason, envelope.operationId, envelope.cursor);
    }
    if (envelope.type === 'result') {
      operation.executions.get(envelope.executionId)!.completed = true;
      operation.pending = false;
    } else if (envelope.type !== 'control-ack') {
      // Acks are neutral: they confirm command receipt without implying that
      // a completed operation has pending work again.
      operation.pending = true;
    }
    operation.lastCursor = envelope.cursor;
    operation.lastEnvelope = envelope;
    operation.lastActivityAt = this.now();
    this.armHeartbeat(operation);
    for (const subscriber of operation.subscribers.values()) this.deliver(subscriber, envelope);
    this.notifyEnvelopeListeners(envelope);
    return { accepted: true, envelope };
  }

  private buildControlEnvelope(operation: OperationState, input: EzerControlEventInput): EzerEventEnvelope {
    const last = operation.lastEnvelope;
    return {
      type: input.type,
      requestId: input.requestId ?? last?.requestId ?? operation.requestId ?? UNASSIGNED,
      sessionId: input.sessionId ?? last?.sessionId ?? operation.sessionId ?? UNASSIGNED,
      operationId: input.operationId,
      executionId: input.executionId ?? last?.executionId ?? UNASSIGNED,
      attemptId: input.attemptId ?? last?.attemptId ?? UNASSIGNED,
      cursor: operation.lastCursor ?? '0',
      ts: this.iso(),
      summary: input.summary,
      ...(input.diagnosticId ? { diagnosticId: input.diagnosticId } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
  }

  private notifyEnvelopeListeners(envelope: EzerEventEnvelope): void {
    for (const listener of this.envelopeListeners) {
      try {
        listener(envelope);
      } catch (error) {
        console.error('[EzerStreaming] Envelope listener failed for %s:', envelope.operationId, error);
      }
    }
  }

  /**
   * Attach a subscriber, acknowledging immediately, then resume from the
   * acknowledged cursor by replaying the canonical journal. Events at or
   * before `afterCursor` are never redelivered; live events arriving during
   * replay are held and flushed in order afterwards, deduplicated by cursor.
   */
  async resume(operationId: string, subscriber: EzerStreamSubscriber, afterCursor?: string): Promise<void> {
    const operation = this.ensureOperation(operationId);
    const state: SubscriberState = {
      id: subscriber.id, send: subscriber.send,
      deliveredUpTo: afterCursor ?? null, replaying: true, backlog: [],
    };
    operation.subscribers.set(state.id, state);
    // Immediate acknowledgement (2s design target): the subscriber can tell a
    // silent provider from a dead transport before any journal event arrives.
    this.send(state, EZER_STREAM_SUBSCRIBED, {
      operationId, resumedFrom: afterCursor ?? null,
      cursor: operation.lastCursor, pending: operation.pending, ts: this.iso(),
    });
    try {
      if (this.journal) {
        await this.replayJournal(operation, state, afterCursor ?? null);
      } else if (afterCursor !== undefined) {
        // No reader on this node: refuse the replay honestly instead of
        // serving history from projection memory or pretending to resume.
        this.send(state, EZER_STREAM_EVENT, this.replayUnavailableEnvelope(operation, afterCursor));
      }
    } catch (error) {
      console.error('[EzerStreaming] Journal replay failed for %s:', operationId, error);
      this.send(state, EZER_STREAM_EVENT, this.replayUnavailableEnvelope(operation, afterCursor ?? null));
    } finally {
      state.replaying = false;
      const backlog = state.backlog;
      state.backlog = [];
      for (const envelope of backlog) this.deliver(state, envelope);
    }
  }

  /** Detach one subscriber from one operation stream. */
  detach(operationId: string, subscriberId: string): void {
    this.operations.get(operationId)?.subscribers.delete(subscriberId);
  }

  /** Detach a subscriber (e.g. a disconnected socket) from every stream. */
  detachSubscriber(subscriberId: string): void {
    for (const operation of this.operations.values()) operation.subscribers.delete(subscriberId);
  }

  close(): void {
    this.closed = true;
    this.envelopeListeners.clear();
    for (const operation of this.operations.values()) {
      if (operation.heartbeatTimer !== null) this.cancelTimer(operation.heartbeatTimer);
      operation.heartbeatTimer = null;
      operation.subscribers.clear();
    }
    this.operations.clear();
  }

  private async replayJournal(
    operation: OperationState,
    state: SubscriberState,
    afterCursor: string | null,
  ): Promise<void> {
    const entries = await this.journal!.readAfter(operation.operationId, afterCursor);
    let replayCursor = afterCursor;
    for (const raw of entries) {
      if (!operation.subscribers.has(state.id)) return;
      const { envelope } = sanitizeEzerEnvelope(raw);
      if (!envelope) {
        this.drop('malformed', operation.operationId);
        continue;
      }
      if (envelope.operationId !== operation.operationId) {
        this.drop('wrong-operation', operation.operationId, envelope.cursor);
        continue;
      }
      if (replayCursor !== null && compareEzerCursors(envelope.cursor, replayCursor) <= 0) {
        this.drop('stale-replay', operation.operationId, envelope.cursor);
        continue;
      }
      replayCursor = envelope.cursor;
      state.deliveredUpTo = envelope.cursor;
      this.send(state, EZER_STREAM_EVENT, envelope);
    }
  }

  private ensureOperation(operationId: string): OperationState {
    let operation = this.operations.get(operationId);
    if (!operation) {
      operation = {
        operationId, requestId: null, sessionId: null, ownerUserId: null,
        pending: false, lastCursor: null, lastEnvelope: null, lastActivityAt: this.now(),
        heartbeatSeq: 0, heartbeatTimer: null,
        executions: new Map(), fencedAttempts: new Set(), subscribers: new Map(),
      };
      this.operations.set(operationId, operation);
    }
    return operation;
  }

  private armHeartbeat(operation: OperationState): void {
    if (operation.heartbeatTimer !== null) this.cancelTimer(operation.heartbeatTimer);
    operation.heartbeatTimer = null;
    if (this.closed || !operation.pending) return;
    operation.heartbeatTimer = this.scheduleTimer(() => {
      operation.heartbeatTimer = null;
      this.fireHeartbeat(operation);
    }, this.heartbeatIntervalMs);
  }

  private fireHeartbeat(operation: OperationState): void {
    if (this.closed || !operation.pending) return;
    const elapsedMs = this.now() - operation.lastActivityAt;
    operation.heartbeatSeq += 1;
    const last = operation.lastEnvelope;
    // A heartbeat is a projection-level liveness signal, not a journal event:
    // it reuses the last durable cursor and is never part of replay.
    const heartbeat: EzerEventEnvelope = {
      type: 'heartbeat',
      requestId: last?.requestId ?? operation.requestId ?? UNASSIGNED,
      sessionId: last?.sessionId ?? operation.sessionId ?? UNASSIGNED,
      operationId: operation.operationId,
      executionId: last?.executionId ?? UNASSIGNED,
      attemptId: last?.attemptId ?? UNASSIGNED,
      cursor: operation.lastCursor ?? '0',
      ts: this.iso(),
      summary: `No progress observed for ${elapsedMs}ms; the operation is still pending.`,
      diagnosticId: `hb-${operation.operationId}-${operation.heartbeatSeq}`,
    };
    for (const subscriber of operation.subscribers.values()) {
      if (!subscriber.replaying) this.send(subscriber, EZER_STREAM_EVENT, heartbeat);
    }
    operation.lastActivityAt = this.now();
    this.armHeartbeat(operation);
  }

  private deliver(subscriber: SubscriberState, envelope: EzerEventEnvelope): void {
    if (subscriber.replaying) { subscriber.backlog.push(envelope); return; }
    if (subscriber.deliveredUpTo !== null
      && compareEzerCursors(envelope.cursor, subscriber.deliveredUpTo) <= 0) return;
    subscriber.deliveredUpTo = envelope.cursor;
    this.send(subscriber, EZER_STREAM_EVENT, envelope);
    const delayMs = Math.max(0, this.now() - Date.parse(envelope.ts));
    if (Number.isFinite(delayMs) && delayMs > this.metrics.maxProjectionDelayMs) {
      this.metrics.maxProjectionDelayMs = delayMs;
    }
  }

  private send(subscriber: SubscriberState, event: string, payload: unknown): void {
    try {
      subscriber.send(event, payload);
      if (event === EZER_STREAM_EVENT) this.metrics.delivered += 1;
    } catch (error) {
      console.error('[EzerStreaming] Failed to deliver to subscriber %s:', subscriber.id, error);
    }
  }

  private replayUnavailableEnvelope(operation: OperationState, afterCursor: string | null): EzerEventEnvelope {
    const diagnosticId = `replay-unavailable-${operation.operationId}`;
    return {
      type: 'error',
      requestId: operation.requestId ?? UNASSIGNED,
      sessionId: operation.sessionId ?? UNASSIGNED,
      operationId: operation.operationId,
      executionId: UNASSIGNED, attemptId: UNASSIGNED,
      cursor: operation.lastCursor ?? afterCursor ?? '0',
      ts: this.iso(),
      summary: 'Reconnect replay is unavailable on this transport node; live projection continues.',
      diagnosticId,
      error: {
        code: 'REPLAY_UNAVAILABLE', diagnosticId,
        message: 'The journal reader is not reachable from this transport node, so history cannot be replayed.',
        knownCause: 'journal reader not configured or unreachable',
        persistedState: 'The Ezer journal remains the canonical record; no events were lost.',
        remainingActivity: 'Live events continue to stream from the current cursor.',
        retryPath: 'Reconnect after the journal reader is restored, or read missed history from the journal directly.',
      },
    };
  }

  private drop(reason: EzerDropReason, operationId?: string, cursor?: string): { accepted: false; reason: EzerDropReason } {
    this.metrics.dropped += 1;
    console.warn(
      `[EzerStreaming] Dropped envelope (${reason})`
      + `${operationId ? ` for operation ${operationId}` : ''}${cursor ? ` at cursor ${cursor}` : ''}`,
    );
    this.onDrop?.({ reason, operationId, cursor, at: this.iso() });
    return { accepted: false, reason };
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}

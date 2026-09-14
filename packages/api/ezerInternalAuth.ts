import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { InstanceAuthorization } from './authorization.js';

/**
 * Env var carrying the shared secret Ezer presents on the narrow set of
 * durable projections it polls plus the existing read-only agent analysis route. Machine-to-machine
 * only: this is not a user session credential and must never be reachable
 * from the browser. Consumed directly by `ensureAuthenticated` in auth.ts —
 * this file holds no route or middleware of its own.
 */
export const EZER_INTERNAL_SECRET_ENV = 'EZER_INTERNAL_API_SECRET';
export const EZER_INTERNAL_SECRET_HEADER = 'x-ezer-internal-secret';
const MINIMUM_SECRET_BYTES = 32;

const EZER_INTERNAL_ELIGIBLE_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/status$/ },
  { method: 'GET', pattern: /^\/tasks$/ },
  { method: 'GET', pattern: /^\/task\/[^/]+\/history$/ },
  // `agent.analyze` runs in an isolated scratch workspace with tools disabled. This route cannot
  // enqueue or execute a ProPR product task; admitted work continues through the task APIs.
  { method: 'POST', pattern: /^\/agents\/chat$/ },
  // Owner-approved StopUnit capability; handler independently validates signed exact execution.
  { method: 'POST', pattern: /^\/task\/[^/]+\/stop$/ },
  // Handler requires an existing exact GitHub comment and a fresh signed Ezer admission.
  { method: 'POST', pattern: /^\/tasks\/[^/]+\/followup$/ },
];

/** `path` is the request path relative to the `/api` mount (e.g. `/tasks`), as seen inside `ensureAuthenticated`. */
export function isEzerInternalEligibleRoute(method: string, path: string): boolean {
  return EZER_INTERNAL_ELIGIBLE_ROUTES.some(route => route.method === method && route.pattern.test(path));
}

function readSecretHeader(req: Request): string | null {
  const value = req.headers[EZER_INTERNAL_SECRET_HEADER];
  if (Array.isArray(value) || typeof value !== 'string' || value.length === 0) return null;
  return value;
}

/** Constant-time secret comparison. Length differences short-circuit safely (no timing leak beyond length, which is not secret). */
function secretsMatch(presented: string, expected: string): boolean {
  const presentedBuffer = Buffer.from(presented, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (presentedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(presentedBuffer, expectedBuffer);
}

/**
 * Verifies the Ezer internal secret header on an already-eligible request.
 * Fails closed: an unconfigured or too-weak configured secret always rejects,
 * regardless of what the caller presents.
 */
export function verifyEzerInternalRequest(req: Request): boolean {
  const expected = process.env[EZER_INTERNAL_SECRET_ENV];
  if (!expected || Buffer.byteLength(expected, 'utf8') < MINIMUM_SECRET_BYTES) return false;
  const presented = readSecretHeader(req);
  if (!presented) return false;
  return secretsMatch(presented, expected);
}

/**
 * Authorization granted to a verified Ezer internal request. There is no GitHub
 * identity behind this credential, so it carries no permissions beyond the
 * narrowly eligible routes — role/permissions must never be widened
 * without also widening `EZER_INTERNAL_ELIGIBLE_ROUTES`.
 */
export function getEzerInternalAuthorization(): InstanceAuthorization {
  return { role: 'member', permissions: [], source: 'implicit' };
}

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, afterEach, test } from 'node:test';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { closeConnection } from '@propr/core';
import { ensureAuthenticated } from '../auth.js';
import { resolveAuthorization } from '../authorization.js';
import { EZER_INTERNAL_SECRET_ENV, EZER_INTERNAL_SECRET_HEADER } from '../ezerInternalAuth.js';
import { configureDemoMode, resetConfiguredDemoMode } from '../demoMode.js';

const originalSecret = process.env[EZER_INTERNAL_SECRET_ENV];
const originalBearerAuth = process.env.ENABLE_BEARER_AUTH;
const VALID_SECRET = randomBytes(32).toString('hex');

function restoreEnv(): void {
  if (originalSecret === undefined) delete process.env[EZER_INTERNAL_SECRET_ENV];
  else process.env[EZER_INTERNAL_SECRET_ENV] = originalSecret;
  if (originalBearerAuth === undefined) delete process.env.ENABLE_BEARER_AUTH;
  else process.env.ENABLE_BEARER_AUTH = originalBearerAuth;
}

afterEach(() => {
  restoreEnv();
  resetConfiguredDemoMode();
});

after(async () => {
  await closeConnection();
});

function createRequest(method: string, path: string, headers: Record<string, string> = {}): Request {
  return {
    method,
    path,
    headers,
    isAuthenticated: () => false,
  } as unknown as Request;
}

function createJsonResponse(): { response: ExpressResponse; status: () => number; body: () => unknown } {
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return response;
    },
    json(body: unknown) {
      payload = body;
      return response;
    },
  } as unknown as ExpressResponse;
  return { response, status: () => statusCode, body: () => payload };
}

async function runEnsureAuthenticated(req: Request): Promise<{ nextCalled: boolean; status: () => number; body: () => unknown }> {
  const { response, status, body } = createJsonResponse();
  let nextCalled = false;
  await ensureAuthenticated(req, response, (() => { nextCalled = true; }) as NextFunction);
  return { nextCalled, status, body };
}

const ELIGIBLE_REQUESTS: Array<[string, string]> = [
  ['GET', '/status'],
  ['GET', '/tasks'],
  ['GET', '/task/abc-123/history'],
  ['POST', '/agents/chat'],
  ['POST', '/tasks/abc-123/followup'],
];

test('accepts a valid internal secret on every narrow Ezer service route without setting req.user', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = VALID_SECRET;
  process.env.ENABLE_BEARER_AUTH = 'false';

  for (const [method, path] of ELIGIBLE_REQUESTS) {
    const req = createRequest(method, path, { [EZER_INTERNAL_SECRET_HEADER]: VALID_SECRET });
    const { nextCalled, status } = await runEnsureAuthenticated(req);
    assert.equal(nextCalled, true, `${method} ${path} should call next()`);
    assert.equal(status(), 200, `${method} ${path} should not write an error response`);
    assert.equal('user' in req, false, `${method} ${path} must not attach req.user`);
  }
});

test('rejects a wrong internal secret on eligible routes', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = VALID_SECRET;
  process.env.ENABLE_BEARER_AUTH = 'false';

  const req = createRequest('GET', '/tasks', { [EZER_INTERNAL_SECRET_HEADER]: 'wrong-secret-value-that-is-also-long-enough' });
  const { nextCalled, status, body } = await runEnsureAuthenticated(req);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
  assert.equal((body() as { error: string }).error, 'Invalid or missing Ezer internal secret');
});

test('rejects a configured secret that is too weak, regardless of what is presented', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = 'too-short';
  process.env.ENABLE_BEARER_AUTH = 'false';

  const req = createRequest('GET', '/tasks', { [EZER_INTERNAL_SECRET_HEADER]: 'too-short' });
  const { nextCalled, status } = await runEnsureAuthenticated(req);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
});

test('rejects when the internal secret is unconfigured', async () => {
  configureDemoMode(false);
  delete process.env[EZER_INTERNAL_SECRET_ENV];
  process.env.ENABLE_BEARER_AUTH = 'false';

  const req = createRequest('GET', '/tasks', { [EZER_INTERNAL_SECRET_HEADER]: VALID_SECRET });
  const { nextCalled, status } = await runEnsureAuthenticated(req);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
});

test('the header cannot authenticate a mutation route even with a valid secret', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = VALID_SECRET;
  process.env.ENABLE_BEARER_AUTH = 'false';

  const req = createRequest('POST', '/tasks/revert', { [EZER_INTERNAL_SECRET_HEADER]: VALID_SECRET });
  const { nextCalled, status, body } = await runEnsureAuthenticated(req);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
  // Falls through to the generic session/bearer failure, not the Ezer-specific message.
  assert.equal((body() as { error: string }).error, 'Unauthorized');
});

test('the agent-chat exception is exact and cannot authenticate adjacent agent mutations', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = VALID_SECRET;
  process.env.ENABLE_BEARER_AUTH = 'false';

  const req = createRequest('POST', '/agents/runtime/refresh', {
    [EZER_INTERNAL_SECRET_HEADER]: VALID_SECRET,
  });
  const { nextCalled, status } = await runEnsureAuthenticated(req);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
});

test('the header cannot authenticate an unrelated read route even with a valid secret', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = VALID_SECRET;
  process.env.ENABLE_BEARER_AUTH = 'false';

  const req = createRequest('GET', '/catalog', { [EZER_INTERNAL_SECRET_HEADER]: VALID_SECRET });
  const { nextCalled, status, body } = await runEnsureAuthenticated(req);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
  assert.equal((body() as { error: string }).error, 'Unauthorized');
});

test('resolveAuthorization grants a verified eligible Ezer request a permissionless member authorization', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = VALID_SECRET;

  const req = createRequest('GET', '/tasks', { [EZER_INTERNAL_SECRET_HEADER]: VALID_SECRET });
  const { response } = createJsonResponse();
  let nextCalled = false;
  await resolveAuthorization(req, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(req.authorization, { role: 'member', permissions: [], source: 'implicit' });
});

test('resolveAuthorization requires a GitHub identity for a non-eligible or unverified request', async () => {
  configureDemoMode(false);
  process.env[EZER_INTERNAL_SECRET_ENV] = VALID_SECRET;

  const req = createRequest('GET', '/catalog', { [EZER_INTERNAL_SECRET_HEADER]: VALID_SECRET });
  const { response, status, body } = createJsonResponse();
  let nextCalled = false;
  await resolveAuthorization(req, response, (() => { nextCalled = true; }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(status(), 401);
  assert.equal((body() as { error: string }).error, 'Authentication required');
});

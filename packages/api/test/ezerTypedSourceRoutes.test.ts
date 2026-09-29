import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { parseSourceReference } from '../../core/src/admission/admittedSource.js';

const typed = mock.fn(async () => ({ mode: 'fix', jobId: 'pr-comments-batch-ezer-a' }));
const legacy = mock.fn(async () => ({ jobId: 'pr-comments-batch-ezer-a', commentId: 9 }));
const cancel = mock.fn(async () => ({ state: 'not-started' }));
await mock.module('ioredis', { namedExports: { Redis: class { disconnect() {} } } });
await mock.module('@propr/core', { namedExports: {
    enqueueAdmittedSource: typed, parseSourceReference, cancelExecutionAdmission: cancel, getStateManager: mock.fn(), TaskStates: { CANCELLED: 'cancelled' },
    issueQueue: { add: mock.fn() }, COMMENT_BATCH_DELAY_MS: 1, getAuthenticatedOctokit: mock.fn(),
    generateCorrelationId: () => 'correlation', logger: { info: mock.fn(), error: mock.fn() },
} });
await mock.module('../routes/ezerCommentFollowup.js', { namedExports: { enqueueAdmittedComment: legacy } });
await mock.module('../routes/revertHelpers.js', { namedExports: Object.fromEntries(['validateRevertRequestBody', 'formatCommit', 'validateRevertPreviewParams',
    'checkRevertAuthorization', 'checkRevertPreviewAuthorization', 'lookupPr', 'buildRevertJobData', 'verifyCommitBelongsToPr', 'resolveRepoAndCheckAccess'].map(key => [key, mock.fn()])) });
const { createTaskRoutes } = await import('../routes/taskRoutes.js');
const { postEzerAdmissionCancel } = await import('../routes/ezerAdmissionCancel.js');
const { isEzerInternalEligibleRoute } = await import('../ezerInternalAuth.js');
process.env.EZER_INTERNAL_API_SECRET = 'internal-secret-at-least-32-bytes-long';
const db = () => ({ where: () => ({ first: async () => ({ task_id: 'task', repository: 'owner/repo', issue_number: 1, pr_number: 7 }) }) });
const routes = createTaskRoutes({ db } as never);
function request(body: unknown, internal = true) { return { params: { taskId: 'task', admissionId: 'a' }, body,
    headers: internal ? { 'x-ezer-internal-secret': process.env.EZER_INTERNAL_API_SECRET } : {} }; }
function response() { const value = { code: 200, body: undefined as unknown }; return { value, status(code: number) { value.code = code; return this; }, json(body: unknown) { value.body = body; return this; } }; }
test('internal contract 2 has no body and returns exactly mode and jobId', async () => {
    const res = response(); await routes.postFollowup(request({ contract: 2, admissionId: 'a', source: { kind: 'review', id: 9 } }) as never, res as never);
    assert.deepEqual(res.value, { code: 200, body: { mode: 'fix', jobId: 'pr-comments-batch-ezer-a' } });
    assert.deepEqual(typed.mock.calls.at(-1)?.arguments[0], { repository: 'owner/repo', prNumber: 7, admissionId: 'a', source: { kind: 'review', id: 9 } });
});
test('legacy exact body/comment/admission form remains unchanged', async () => {
    const res = response(); await routes.postFollowup(request({ body: '/ezer fix', existingCommentId: 9, admissionId: 'a' }) as never, res as never);
    assert.equal(res.value.code, 200); assert.deepEqual(legacy.mock.calls.at(-1)?.arguments[0], { repository: 'owner/repo', prNumber: 7, commentId: 9, body: '/ezer fix', admissionId: 'a' });
});
for (const body of [{ body: 'fix' }, { contract: 2, admissionId: 'a', source: { kind: 'issue_comment', id: 9 } }]) test(`non-internal followup is 403 ${JSON.stringify(body)}`, async () => {
    const res = response(); const before = typed.mock.callCount() + legacy.mock.callCount();
    await routes.postFollowup(request(body, false) as never, res as never);
    assert.equal(res.value.code, 403); assert.equal(typed.mock.callCount() + legacy.mock.callCount(), before);
});
for (const extra of [{ body: 'override' }, { model: 'forged' }, { mode: 'merge' }, { existingCommentId: 9 }]) test(`typed request refuses unsigned overrides ${JSON.stringify(extra)}`, async () => {
    const res = response(); await routes.postFollowup(request({ contract: 2, admissionId: 'a', source: { kind: 'issue_comment', id: 9 }, ...extra }) as never, res as never);
    assert.equal(res.value.code, 403);
});
test('cancel is on the secret allowlist and independently refuses user sessions', async () => {
    assert.equal(isEzerInternalEligibleRoute('POST', '/ezer/admissions/a/cancel'), true);
    assert.equal(isEzerInternalEligibleRoute('GET', '/ezer/admissions/a/cancel'), false);
    const res = response(); await postEzerAdmissionCancel(request({ operationId: 'op', reason: 'edited' }, false) as never, res as never);
    assert.equal(res.value.code, 403); assert.equal(cancel.mock.callCount(), 0);
});
test('cancel validates input and returns its state', async () => {
    let res = response(); await postEzerAdmissionCancel(request({ reason: 'edited' }) as never, res as never); assert.equal(res.value.code, 400);
    res = response(); await postEzerAdmissionCancel(request({ operationId: 'op', reason: 'edited' }) as never, res as never);
    assert.deepEqual(res.value, { code: 200, body: { state: 'not-started' } });
});

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  readMilestoneCorrectionRequest,
  signMilestoneCorrectionRequest,
  milestoneCorrectionRequestId,
  MILESTONE_CORRECTION_JOB,
  MILESTONE_CORRECTION_CONTRACT,
} from "../../core/src/admission/milestoneCorrection.js";
const jobs = new Map<
  string,
  { data: unknown; getState: () => Promise<string>; returnvalue?: unknown }
>();
const add = mock.fn(
  async (
    name: string,
    data: unknown,
    options: {
      attempts: number;
      removeOnComplete: boolean;
      removeOnFail: boolean;
      jobId: string;
    },
  ) => {
    assert.equal(name, MILESTONE_CORRECTION_JOB);
    assert.equal(options.attempts, 1);
    assert.equal(options.removeOnComplete, false);
    assert.equal(options.removeOnFail, false);
    jobs.set(options.jobId, { data, getState: async () => "failed" });
  },
);
await mock.module("@propr/core", {
  namedExports: {
    issueQueue: { getJob: async (id: string) => jobs.get(id), add },
    readMilestoneCorrectionRequest,
    MILESTONE_CORRECTION_JOB,
  },
});
const { postMilestoneCorrection, getMilestoneCorrection } =
  await import("../routes/ezerMilestoneCorrection.js");
const { isEzerInternalEligibleRoute } = await import("../ezerInternalAuth.js");
const SECRET = "s".repeat(32);
process.env.EZER_INTERNAL_API_SECRET = SECRET;
process.env.EZER_ADMISSION_HMAC_SECRET = SECRET;
const p = {
  contract: MILESTONE_CORRECTION_CONTRACT,
  epicId: "EP-x",
  milestoneId: "m1",
  repository: "o/r",
  branch: "epic/EP-x/m1",
  fromHead: "a".repeat(40),
  activationEventId: "a",
  scope: ["src"],
  prNumber: 1,
  reviewId: 2,
  instructions: "Fix the file",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  attempt: 0,
  requestId: milestoneCorrectionRequestId("EP-x", "m1", "o/r", 1, 2),
};
const token = signMilestoneCorrectionRequest(p, SECRET);
const request = (body: unknown, internal = true) => ({
  body,
  params: { requestId: p.requestId },
  headers: internal ? { "x-ezer-internal-secret": SECRET } : {},
});
function response() {
  return {
    code: 200,
    body: undefined as unknown,
    status(code: number) {
      this.code = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}
test("only exact machine routes are eligible, and user sessions cannot enqueue milestones", async () => {
  assert.equal(
    isEzerInternalEligibleRoute("POST", "/tasks/milestone-correction"),
    true,
  );
  assert.equal(
    isEzerInternalEligibleRoute(
      "GET",
      `/tasks/milestone-correction/${p.requestId}`,
    ),
    true,
  );
  assert.equal(
    isEzerInternalEligibleRoute(
      "DELETE",
      `/tasks/milestone-correction/${p.requestId}`,
    ),
    false,
  );
  const res = response();
  await postMilestoneCorrection(
    request({ token }, false) as never,
    res as never,
  );
  assert.equal(res.code, 403);
  assert.equal(add.mock.callCount(), 0);
});
test("a signed request has one retained attempt and a failed status survives replay", async () => {
  const before = add.mock.callCount();
  for (let i = 0; i < 2; i++) {
    const res = response();
    await postMilestoneCorrection(request({ token }) as never, res as never);
    assert.equal(res.code, 202);
  }
  assert.equal(add.mock.callCount(), before + 1);
  const res = response();
  await getMilestoneCorrection(request({}) as never, res as never);
  assert.deepEqual(res.body, {
    requestId: p.requestId,
    state: "failed",
    result: undefined,
  });
});
test("tampering and unsigned overrides are rejected before queue admission", async () => {
  const before = add.mock.callCount();
  for (const body of [
    { token: token + "x" },
    { token, scope: ["/"] },
    { token: signMilestoneCorrectionRequest({ ...p, scope: ["other"] }, SECRET) },
  ]) {
    const res = response();
    await postMilestoneCorrection(request(body) as never, res as never);
    assert.equal(res.code, 409);
  }
  assert.equal(add.mock.callCount(), before);
});
test('expired new requests cannot enqueue and status fails closed', async () => {
  const before = add.mock.callCount();
  jobs.clear();
  const expired = response();
  await postMilestoneCorrection(request({ token: signMilestoneCorrectionRequest({ ...p, expiresAt: new Date(0).toISOString() }, SECRET) }) as never, expired as never);
  assert.equal(expired.code, 409);
  assert.equal(add.mock.callCount(), before);
  const absent = response();
  await getMilestoneCorrection(request({}) as never, absent as never);
  assert.equal(absent.code, 404);
  const unauthenticated = response();
  await getMilestoneCorrection(request({}, false) as never, unauthenticated as never);
  assert.equal(unauthenticated.code, 403);
  const invalid = response();
  await getMilestoneCorrection({ ...request({}), params: { requestId: 'invalid' } } as never, invalid as never);
  assert.equal(invalid.code, 400);
});

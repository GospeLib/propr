import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  readMilestoneRequest,
  signMilestoneRequest,
  milestoneRequestId,
  MILESTONE_JOB,
  MILESTONE_MAINTENANCE_CONTRACT,
} from "../../core/src/admission/milestoneMaintenance.js";
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
    assert.equal(name, MILESTONE_JOB);
    assert.equal(options.attempts, 1);
    assert.equal(options.removeOnComplete, false);
    assert.equal(options.removeOnFail, false);
    jobs.set(options.jobId, { data, getState: async () => "failed" });
  },
);
await mock.module("@propr/core", {
  namedExports: {
    issueQueue: { getJob: async (id: string) => jobs.get(id), add },
    readMilestoneRequest,
    MILESTONE_JOB,
  },
});
const { postMilestoneMaintenance, getMilestoneMaintenance } =
  await import("../routes/ezerMilestoneMaintenance.js");
const { isEzerInternalEligibleRoute } = await import("../ezerInternalAuth.js");
const SECRET = "s".repeat(32);
process.env.EZER_INTERNAL_API_SECRET = SECRET;
process.env.EZER_ADMISSION_HMAC_SECRET = SECRET;
const p = {
  contract: MILESTONE_MAINTENANCE_CONTRACT,
  epicId: "EP-x",
  milestoneId: "m1",
  repository: "o/r",
  branch: "epic/EP-x/m1",
  fromHead: "a".repeat(40),
  sourceBranch: "stage",
  sourceSha: "b".repeat(40),
  activationEventId: "a",
  scope: ["src"],
  issueNumber: 1,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  attempt: 0,
  requestId: milestoneRequestId("EP-x", "m1", "o/r", "a".repeat(40), "b".repeat(40), 0),
};
const token = signMilestoneRequest(p, SECRET);
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
    isEzerInternalEligibleRoute("POST", "/tasks/milestone-maintenance"),
    true,
  );
  assert.equal(
    isEzerInternalEligibleRoute(
      "GET",
      `/tasks/milestone-maintenance/${p.requestId}`,
    ),
    true,
  );
  assert.equal(
    isEzerInternalEligibleRoute(
      "DELETE",
      `/tasks/milestone-maintenance/${p.requestId}`,
    ),
    false,
  );
  const res = response();
  await postMilestoneMaintenance(
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
    await postMilestoneMaintenance(request({ token }) as never, res as never);
    assert.equal(res.code, 202);
  }
  assert.equal(add.mock.callCount(), before + 1);
  const res = response();
  await getMilestoneMaintenance(request({}) as never, res as never);
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
    { token: signMilestoneRequest({ ...p, scope: ["other"] }, SECRET) },
  ]) {
    const res = response();
    await postMilestoneMaintenance(request(body) as never, res as never);
    assert.equal(res.code, 409);
  }
  assert.equal(add.mock.callCount(), before);
});

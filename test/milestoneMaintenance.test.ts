import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { executeMilestoneMaintenance } from "../src/jobs/milestoneMaintenanceMerge.js";
import {
  milestoneRequestId,
  milestoneCommitMessage,
  signMilestoneRequest,
  readMilestoneRequest,
  MILESTONE_MAINTENANCE_CONTRACT,
  type MilestoneMaintenanceRequest,
} from "../packages/core/src/admission/milestoneMaintenance.js";
import {
  signedMaintenanceApi,
  SIGNED_MERGE_SHA,
} from "./helpers/signedMaintenanceApi.js";
const SECRET = "s".repeat(32);
async function fixture(conflict = false) {
  const root = await mkdtemp(join(tmpdir(), "milestone-test-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git(["init", "-b", "feature"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  await writeFile(join(root, "file"), "initial\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "stage"]);
  await writeFile(join(root, "file"), "source\n");
  git(["add", "."]);
  git(["commit", "-m", "source"]);
  const sourceSha = git(["rev-parse", "HEAD"]);
  git(["checkout", "feature"]);
  await writeFile(join(root, conflict ? "file" : "other"), "feature\n");
  git(["add", "."]);
  git(["commit", "-m", "feature"]);
  const fromHead = git(["rev-parse", "HEAD"]);
  const p: MilestoneMaintenanceRequest = {
    contract: MILESTONE_MAINTENANCE_CONTRACT,
    epicId: "EP-x",
    milestoneId: "m1",
    repository: "owner/repo",
    branch: "epic/EP-x/m1",
    fromHead,
    sourceSha,
    sourceBranch: "stage",
    activationEventId: "activation",
    requestId: milestoneRequestId("EP-x", "m1", "owner/repo", fromHead, sourceSha),
    scope: ["file"],
    issueNumber: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    root,
    git,
    p,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("real clean merge publishes exact parents with beforeOid CAS and no agent", async () => {
  const f = await fixture();
  try {
    const api = signedMaintenanceApi(f.root, f.p.fromHead);
    const result = await executeMilestoneMaintenance(f.p, {
      repositoryPath: f.root,
      api,
      fence: async () => {},
      resolve: async () => {
        assert.fail("clean merge ran agent");
      },
    });
    assert.equal(result, SIGNED_MERGE_SHA);
    const created = api.calls.find((c) => c.endpoint.endsWith("/git/commits"))!;
    assert.deepEqual(created.options.parents, [f.p.fromHead, f.p.sourceSha]);
    const update = api.calls.find((c) => c.endpoint === "POST /graphql")!;
    assert.equal(
      (update.options.variables as any).input.refUpdates[0].beforeOid,
      f.p.fromHead,
    );
    assert.equal(
      (update.options.variables as any).input.refUpdates[0].force,
      false,
    );
  } finally {
    await f.cleanup();
  }
});
for (const race of ["foreign", "second-parent"])
  test(`foreign push between read and publish is refused: ${race}`, async () => {
    const f = await fixture();
    try {
      const moved = race === "second-parent" ? f.p.sourceSha : "e".repeat(40);
      const api = signedMaintenanceApi(f.root, f.p.fromHead, {
        raceAtUpdate: moved,
      });
      await assert.rejects(
        executeMilestoneMaintenance(f.p, {
          repositoryPath: f.root,
          api,
          fence: async () => {},
          resolve: async () => {},
        }),
        /ref-update-failed/,
      );
      assert.equal(api.ref(), moved);
    } finally {
      await f.cleanup();
    }
  });
test("real conflict runs scoped resolution then publishes the same exact parent pair", async () => {
  const f = await fixture(true);
  let attempts = 0;
  try {
    const api = signedMaintenanceApi(f.root, f.p.fromHead);
    await executeMilestoneMaintenance(f.p, {
      repositoryPath: f.root,
      api,
      fence: async () => {},
      resolve: async (path, conflicts, request) => {
        attempts++;
        assert.deepEqual(conflicts, ["file"]);
        assert.equal(
          execFileSync("git", ["remote"], {
            cwd: path,
            encoding: "utf8",
          }).trim(),
          "",
        );
        assert.ok(
          !execFileSync("git", ["rev-parse", "--git-common-dir"], {
            cwd: path,
            encoding: "utf8",
          }).includes(f.root),
        );
        assert.deepEqual(request.scope, ["file"]);
        await writeFile(join(path, "file"), "resolved\n");
      },
    });
    assert.equal(attempts, 1);
    assert.equal(api.ref(), SIGNED_MERGE_SHA);
  } finally {
    await f.cleanup();
  }
});
for (const failure of ["scope", "agent", "pause", "markers"])
  test(`refuses conflict publication after ${failure}`, async () => {
    const f = await fixture(true);
    let ran = false;
    try {
      const api = signedMaintenanceApi(f.root, f.p.fromHead);
      await assert.rejects(
        executeMilestoneMaintenance(f.p, {
          repositoryPath: f.root,
          api,
          fence: async () => {
            if (ran && failure === "pause") throw Error("paused");
          },
          resolve: async (path) => {
            ran = true;
            if (failure === "agent") throw Error("agent failed");
            if (failure !== "markers")
              await writeFile(join(path, "file"), "resolved\n");
            if (failure === "scope")
              await writeFile(join(path, "other"), "out of scope\n");
          },
        }),
      );
      assert.equal(api.ref(), f.p.fromHead);
    } finally {
      await f.cleanup();
    }
  });
test("signed milestone authority rejects tampering, reserved destinations and story-shaped tokens", async () => {
  const f = await fixture();
  try {
    const token = signMilestoneRequest(f.p, SECRET);
    assert.deepEqual(readMilestoneRequest(token, SECRET), f.p);
    assert.throws(() => readMilestoneRequest(`${token}x`, SECRET));
    assert.throws(() =>
      readMilestoneRequest(
        signMilestoneRequest({ ...f.p, branch: "stage" }, SECRET),
        SECRET,
      ),
    );
    assert.throws(() =>
      readMilestoneRequest(
        signMilestoneRequest(
          { ...f.p, contract: "ezer-pr-maintenance-v1" } as never,
          SECRET,
        ),
        SECRET,
      ),
    );
  } finally {
    await f.cleanup();
  }
});

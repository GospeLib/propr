import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { milestoneCorrectionRequestId, MILESTONE_CORRECTION_CONTRACT, type MilestoneCorrectionRequest } from "../../packages/core/src/admission/milestoneCorrection.js";
export const SECRET = "s".repeat(32);
export async function correctionFixture() {
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
  git(["checkout", "feature"]);
  await writeFile(join(root, "other"), "feature\n");
  git(["add", "."]);
  git(["commit", "-m", "feature"]);
  const fromHead = git(["rev-parse", "HEAD"]);
  const p: MilestoneCorrectionRequest = {
    contract: MILESTONE_CORRECTION_CONTRACT,
    epicId: "EP-x",
    milestoneId: "m1",
    repository: "owner/repo",
    branch: "epic/EP-x/m1",
    fromHead,
    activationEventId: "activation",
    attempt: 0,
    requestId: milestoneCorrectionRequestId("EP-x", "m1", "owner/repo", 1, 2),
    scope: ["file"],
    prNumber: 1,
    reviewId: 2,
    instructions: "Fix the file",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return {
    root,
    git,
    p,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

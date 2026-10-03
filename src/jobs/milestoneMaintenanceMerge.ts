import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  milestoneCommitMessage,
  type MilestoneMaintenanceRequest,
} from "../../packages/core/src/admission/milestoneMaintenance.js";
import { publishSignedMaintenanceCommit } from "./signedMaintenancePublication.js";
import {
  snapshotWorktree,
  changedSinceSnapshot,
} from "./maintenanceWrittenPaths.js";
import { isWithinMergeScope } from "./mergeScope.js";
const MAX_BUFFER = 100 * 1024 * 1024;
const PREFIX = "milestone-";
export interface MilestoneWorkerPorts {
  repositoryPath: string;
  api: Parameters<typeof publishSignedMaintenanceCommit>[0]["octokit"];
  fence(): Promise<void>;
  resolve(
    worktreePath: string,
    conflicts: string[],
    request: MilestoneMaintenanceRequest,
  ): Promise<void>;
}
/** The testable worker path uses real Git; ports supply only external authority/API/agent effects. */
export async function executeMilestoneMaintenance(
  p: MilestoneMaintenanceRequest,
  ports: MilestoneWorkerPorts,
): Promise<string> {
  await ports.fence();
  const scratch = mkdtempSync(join(tmpdir(), PREFIX));
  const privateRepository = join(scratch, "repository");
  const dir = join(scratch, "worktree");
  mkdirSync(privateRepository);
  const git = (args: string[], cwd = dir) =>
    execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
  const [owner, repo] = p.repository.split("/");
  try {
    // A private object store and config keep the agent away from the shared clone's
    // authenticated remote. Only the worker holds the publication credential.
    git(["init", "--quiet"], privateRepository);
    git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        ports.repositoryPath,
        p.fromHead,
        p.sourceSha,
      ],
      privateRepository,
    );
    git(
      ["worktree", "add", "--quiet", "--detach", dir, p.fromHead],
      privateRepository,
    );
    let conflicts: string[] = [];
    try {
      git([
        "-c",
        "user.name=ProPR",
        "-c",
        "user.email=propr@users.noreply.github.com",
        "merge",
        "--no-commit",
        "--no-ff",
        p.sourceSha,
      ]);
    } catch (error) {
      conflicts = git(["diff", "--name-only", "--diff-filter=U", "-z"])
        .split("\0")
        .filter(Boolean);
      if (!conflicts.length) throw error;
    }
    const snapshot = snapshotWorktree(dir);
    if (conflicts.length) {
      if (conflicts.some((path) => !isWithinMergeScope(path, p.scope)))
        throw Error("milestone-conflict-outside-scope");
      await ports.fence();
      await ports.resolve(dir, conflicts, p);
    }
    const verify = async () => {
      await ports.fence();
      if (git(["rev-parse", "HEAD"]).trim() !== p.fromHead)
        throw Error("milestone-local-head-changed");
      if (
        changedSinceSnapshot(dir, snapshot).some(
          (path) => !isWithinMergeScope(path, p.scope),
        )
      )
        throw Error("milestone-scope-changed");
      // Staging resolves the index; unresolved marker text must also be rejected.
      git(["add", "-A"]);
      git(["diff", "--cached", "--check"]);
    };
    await verify();
    return await publishSignedMaintenanceCommit({
      octokit: ports.api,
      owner,
      repo,
      worktreePath: dir,
      branch: p.branch,
      headSha: p.fromHead,
      baseSha: p.sourceSha,
      mergedBaseSha: p.sourceSha,
      commitMessage: milestoneCommitMessage(p.requestId),
      beforePublish: verify,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

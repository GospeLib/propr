/** Milestone worker: exact SHA merge, bounded conflict resolution, signed atomic publication. */
import { execFileSync } from "node:child_process";
import {
  getAuthenticatedOctokit,
  ensureRepoCloned,
  getRepoUrl,
  logger,
  issueQueue,
  readMilestoneRequest,
  milestoneSignature,
  exactSha,
  MILESTONE_AUTHORITY_PATH,
  MILESTONE_SIGNATURE_HEADER,
} from "@propr/core";
import type { Job } from "bullmq";
import { executeMilestoneMaintenance } from "./milestoneMaintenanceMerge.js";
import { runMilestoneConflictAgent } from "./mergeConflictAgentRunner.js";
const CALLBACK_TIMEOUT_MS = 30_000;
export async function processMilestoneMaintenance(job: Job<{ token: string }>) {
  const p = readMilestoneRequest(
    job.data.token,
    process.env.EZER_ADMISSION_HMAC_SECRET ?? "",
  );
  const fence = async () => {
    if (Date.parse(p.expiresAt) <= Date.now() || (await issueQueue.isPaused()))
      throw Error("milestone-authority-expired-or-paused");
    const body = JSON.stringify({ requestId: p.requestId });
    const response = await fetch(
      new URL(MILESTONE_AUTHORITY_PATH, process.env.EZER_API_BASE_URL),
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
        body,
        headers: {
          "content-type": "application/json",
          [MILESTONE_SIGNATURE_HEADER]: milestoneSignature(
            body,
            process.env.EZER_INTERNAL_API_SECRET ?? "",
          ),
        },
      },
    );
    if (!response.ok) throw Error("milestone-authority-withdrawn");
    const data = (await response.json()) as {
      valid: boolean;
      requestId: string;
    };
    if (data.valid !== true || data.requestId !== p.requestId)
      throw Error("milestone-authority-changed");
  };
  await fence();
  const api = await getAuthenticatedOctokit();
  const [owner, repo] = p.repository.split("/");
  const token = (await api.auth({ type: "installation" })) as { token: string };
  const repositoryPath = await ensureRepoCloned({
    repoUrl: getRepoUrl({ repoOwner: owner, repoName: repo }),
    owner,
    repoName: repo,
    authToken: token.token,
    baseBranch: p.sourceBranch,
  });
  execFileSync(
    "git",
    ["fetch", "--", "origin", exactSha(p.fromHead), exactSha(p.sourceSha)],
    {
      cwd: repositoryPath,
    },
  );
  // BullMQ retries/stalls never spend another agent attempt. Reconciliation belongs to Ezer.
  const redis = (await issueQueue.client) as unknown as import("ioredis").Redis;
  const spent = await redis.set(
    `ezer:milestone:attempt:${p.requestId}`,
    job.data.token,
    "NX",
  );
  if (spent !== "OK") throw Error("milestone-attempt-already-spent");
  const result = await executeMilestoneMaintenance(p, {
    repositoryPath,
    api,
    fence,
    resolve: (worktreePath, conflicts, request) =>
      runMilestoneConflictAgent({
        worktreePath,
        conflicts,
        request,
        logger: logger.withCorrelation(p.requestId),
        fence,
      }),
  });
  return { status: "complete", requestId: p.requestId, commit: result };
}

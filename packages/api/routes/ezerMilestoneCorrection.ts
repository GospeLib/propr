/** Signed, idempotent milestone intake. No story, prior task or PR is manufactured. */
import type { Request, Response } from "express";
import { issueQueue, readMilestoneCorrectionRequest, MILESTONE_CORRECTION_JOB } from "@propr/core";
import { verifyEzerInternalRequest } from "../ezerInternalAuth.js";
const PREFIX = "milestone-correction-";
const ID = /^[a-f0-9]{64}$/;
export async function postMilestoneCorrection(req: Request, res: Response) {
  if (!verifyEzerInternalRequest(req)) {
    res.status(403).json({ error: "MILESTONE_INTERNAL_AUTH_REQUIRED" });
    return;
  }
  try {
    if (
      typeof req.body?.token !== "string" ||
      Object.keys(req.body).length !== 1
    )
      throw Error("MILESTONE_TOKEN_REQUIRED");
    const p = readMilestoneCorrectionRequest(
      req.body.token,
      process.env.EZER_ADMISSION_HMAC_SECRET ?? "",
    );
    const jobId = `${PREFIX}${p.requestId}`;
    const prior = await issueQueue.getJob(jobId);
    if (prior) {
      if ((prior.data as { token?: string }).token !== req.body.token)
        throw Error("MILESTONE_REPLAY_CHANGED");
    } else {
      if (Date.parse(p.expiresAt) <= Date.now())
        throw Error("MILESTONE_AUTHORITY_EXPIRED");
      await issueQueue.add(
        MILESTONE_CORRECTION_JOB,
        { token: req.body.token },
        { jobId, attempts: 1, removeOnComplete: false, removeOnFail: false },
      );
    }
    res.status(202).json({ requestId: p.requestId });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  }
}
export async function getMilestoneCorrection(req: Request, res: Response) {
  if (!verifyEzerInternalRequest(req)) {
    res.status(403).json({ error: "MILESTONE_INTERNAL_AUTH_REQUIRED" });
    return;
  }
  const requestId = String(req.params.requestId);
  if (!ID.test(requestId)) {
    res.status(400).json({ error: "MILESTONE_REQUEST_INVALID" });
    return;
  }
  const job = await issueQueue.getJob(`${PREFIX}${requestId}`);
  if (!job) {
    res.status(404).json({ error: "MILESTONE_ABSENT" });
    return;
  }
  res.json({ requestId, state: await job.getState(), result: job.returnvalue });
}

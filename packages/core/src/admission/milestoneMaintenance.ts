/** Versioned Ezer/ProPR wire contract. Keep in sync with ProPR admission/milestoneMaintenance.ts. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export const MILESTONE_MAINTENANCE_CONTRACT = "ezer-milestone-maintenance-v1";
export const MILESTONE_MAINTENANCE_PATH = "/api/tasks/milestone-maintenance";
export const MILESTONE_AUTHORITY_PATH =
  "/internal/milestone-maintenance-authority";
export const MILESTONE_SIGNATURE_HEADER = "x-ezer-milestone-signature";
export const MILESTONE_JOB = "processMilestoneMaintenance";
export const MILESTONE_DEADLINE_MS = 30 * 60 * 1000;
const SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const SECRET_BYTES = 32;
export interface MilestoneMaintenanceRequest {
  contract: typeof MILESTONE_MAINTENANCE_CONTRACT;
  requestId: string;
  epicId: string;
  milestoneId: string;
  repository: string;
  branch: string;
  fromHead: string;
  sourceBranch: string;
  sourceSha: string;
  activationEventId: string;
  scope: string[];
  issueNumber: number;
  expiresAt: string;
  /** How many earlier requests for these exact heads Ezer closed as invalidated. */
  attempt: number;
}
export interface MilestoneMaintenanceJob {
  token: string;
}
/**
 * One request per (recorded head, source, attempt), mirroring Ezer: a superseded or invalidated
 * request is asked again under a new id.
 */
export function milestoneRequestId(
  epicId: string,
  milestoneId: string,
  repository: string,
  fromHead: string,
  sourceSha: string,
  attempt: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        epicId,
        milestoneId,
        repository,
        fromHead,
        sourceSha,
        attempt,
      ]),
    )
    .digest("hex");
}
export function milestoneCommitMessage(requestId: string): string {
  return `Ezer milestone maintenance ${requestId}`;
}
export function milestoneSignature(
  body: string | Buffer,
  secret: string,
): string {
  if (Buffer.byteLength(secret) < SECRET_BYTES)
    throw Error("MILESTONE_SECRET_REQUIRED");
  return createHmac("sha256", secret).update(body).digest("hex");
}
export function validMilestoneSignature(
  body: string | Buffer,
  signature: unknown,
  secret: string,
): boolean {
  const expected = milestoneSignature(body, secret);
  return (
    typeof signature === "string" &&
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  );
}
export function signMilestoneRequest(
  request: MilestoneMaintenanceRequest,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(request)).toString("base64url");
  return `${body}.${milestoneSignature(body, secret)}`;
}
export function readMilestoneRequest(
  token: string,
  secret: string,
): MilestoneMaintenanceRequest {
  const [body, signature, extra] = token.split(".");
  if (
    extra !== undefined ||
    !body ||
    !validMilestoneSignature(body, signature, secret)
  )
    throw Error("MILESTONE_SIGNATURE_INVALID");
  const p = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as MilestoneMaintenanceRequest;
  if (
    p.contract !== MILESTONE_MAINTENANCE_CONTRACT ||
    !IDENTIFIER.test(p.epicId) ||
    !IDENTIFIER.test(p.milestoneId) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) ||
    p.branch !== `epic/${p.epicId}/${p.milestoneId}` ||
    !SHA.test(p.fromHead) ||
    !SHA.test(p.sourceSha) ||
    p.sourceBranch === p.branch ||
    typeof p.sourceBranch !== "string" ||
    !/^[A-Za-z0-9_./-]+$/.test(p.sourceBranch) ||
    p.sourceBranch.includes("..") ||
    !p.activationEventId ||
    !Number.isSafeInteger(p.issueNumber) ||
    p.issueNumber < 1 ||
    !Number.isFinite(Date.parse(p.expiresAt)) ||
    !Number.isSafeInteger(p.attempt) ||
    p.attempt < 0 ||
    !Array.isArray(p.scope) ||
    p.scope.length === 0 ||
    p.scope.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.startsWith("/") ||
        path.split("/").includes(".."),
    ) ||
    p.requestId !==
      milestoneRequestId(
        p.epicId,
        p.milestoneId,
        p.repository,
        p.fromHead,
        p.sourceSha,
        p.attempt,
      )
  )
    throw Error("MILESTONE_REQUEST_INVALID");
  return p;
}

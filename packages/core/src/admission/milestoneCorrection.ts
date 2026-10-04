/** Versioned Ezer/ProPR correction contract. Mirror exactly in ProPR admission. */
import { createHash } from 'node:crypto';
import { milestoneSignature, validMilestoneSignature } from './milestoneMaintenance.js';
export const MILESTONE_CORRECTION_CONTRACT = 'ezer-milestone-correction-v1';
export const MILESTONE_CORRECTION_JOB = 'processMilestoneCorrection';
export const MILESTONE_CORRECTION_INSTRUCTION_BYTES = 64 * 1024;
export const MILESTONE_CORRECTION_ATTEMPT = 0;
const SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FIELDS = new Set([
  'contract',
  'requestId',
  'epicId',
  'milestoneId',
  'repository',
  'branch',
  'fromHead',
  'activationEventId',
  'scope',
  'instructions',
  'reviewId',
  'prNumber',
  'expiresAt',
  'attempt',
]);
export interface MilestoneCorrectionRequest {
  contract: typeof MILESTONE_CORRECTION_CONTRACT;
  requestId: string;
  epicId: string;
  milestoneId: string;
  repository: string;
  branch: string;
  fromHead: string;
  activationEventId: string;
  scope: string[];
  /** Empty feedback is recorded and failed by Ezer without dispatching a worker. */
  instructions: string;
  reviewId: number;
  prNumber: number;
  expiresAt: string;
  /** One attempt per owner review; never retry a failed review. */
  attempt: typeof MILESTONE_CORRECTION_ATTEMPT;
}
export function milestoneCorrectionRequestId(
  epicId: string,
  milestoneId: string,
  repository: string,
  prNumber: number,
  reviewId: number,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        MILESTONE_CORRECTION_CONTRACT,
        epicId,
        milestoneId,
        repository,
        prNumber,
        reviewId,
      ]),
    )
    .digest('hex');
}
export function milestoneCorrectionCommitMessage(requestId: string): string {
  return `Ezer milestone correction ${requestId}`;
}
export function signMilestoneCorrectionRequest(
  request: MilestoneCorrectionRequest,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(request)).toString('base64url');
  return `${body}.${milestoneSignature(body, secret)}`;
}
export function readMilestoneCorrectionRequest(
  token: string,
  secret: string,
): MilestoneCorrectionRequest {
  const [body, signature, extra] = token.split('.');
  if (extra !== undefined || !body || !validMilestoneSignature(body, signature, secret))
    throw Error('MILESTONE_CORRECTION_SIGNATURE_INVALID');
  const p = JSON.parse(
    Buffer.from(body, 'base64url').toString('utf8'),
  ) as MilestoneCorrectionRequest;
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  if (
    !p ||
    typeof p !== 'object' ||
    Array.isArray(p) ||
    Object.keys(p).length !== FIELDS.size ||
    Object.keys(p).some((key) => !FIELDS.has(key)) ||
    p.contract !== MILESTONE_CORRECTION_CONTRACT ||
    !text(p.epicId) ||
    !IDENTIFIER.test(p.epicId) ||
    !text(p.milestoneId) ||
    !IDENTIFIER.test(p.milestoneId) ||
    !text(p.repository) ||
    !REPOSITORY.test(p.repository) ||
    p.branch !== `epic/${p.epicId}/${p.milestoneId}` ||
    !text(p.fromHead) ||
    !SHA.test(p.fromHead) ||
    !text(p.activationEventId) ||
    !positive(p.prNumber) ||
    !positive(p.reviewId) ||
    !text(p.expiresAt) ||
    !Number.isFinite(Date.parse(p.expiresAt)) ||
    p.attempt !== MILESTONE_CORRECTION_ATTEMPT ||
    typeof p.instructions !== 'string' ||
    Buffer.byteLength(p.instructions) > MILESTONE_CORRECTION_INSTRUCTION_BYTES ||
    !Array.isArray(p.scope) ||
    !p.scope.length ||
    p.scope.some(
      (path) =>
        !text(path) ||
        path.startsWith('/') ||
        /[\\\x00-\x1f\x7f:]/.test(path) ||
        path.split('/').some((segment) => !segment || segment === '.' || segment === '..'),
    ) ||
    JSON.stringify(p.scope) !== JSON.stringify([...new Set(p.scope)].sort()) ||
    p.requestId !==
      milestoneCorrectionRequestId(p.epicId, p.milestoneId, p.repository, p.prNumber, p.reviewId)
  )
    throw Error('MILESTONE_CORRECTION_REQUEST_INVALID');
  return p;
}

export const MILESTONE_CORRECTION_PATH = '/api/tasks/milestone-correction';
export const MILESTONE_CORRECTION_AUTHORITY_PATH = '/internal/milestone-correction-authority';
export interface MilestoneCorrectionJob { token: string; }

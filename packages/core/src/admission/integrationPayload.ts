import { createHash } from 'node:crypto';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY = 'GospeLib/main';
const RESERVED = new Set(['stage', 'main', 'master']);
export interface IntegrationPayload {
  epicId: string; repository: string; featureBranch: string; baseSha: string;
  children: Array<{ unitId: string; repository: string; prNumber: number; headSha: string }>;
  authorityRevision: string; unitDigest: string; manifestDigest: string; contractDigest: string;
  manifestApprovalEventId: string;
  permittedScope: { mergeEnumeratedChildHeadsOnly: true; additionalFileEdits: false; stageMerge: false; acceptTestResults: false; approveManifest: false };
  capstoneChecks: string[];
}
export interface IntegrationJobData {
  payload: IntegrationPayload; executionDigest: string; operationId: string; admissionId: string;
  expiresAt: string; issuedAt: string; executionAdmissionReceipt: import('./ezerExecutionAdmission.js').WorkerAdmissionReceipt;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function integrationDigest(payload: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
}
export function requireIntegrationPayload(value: unknown, digest: unknown): IntegrationPayload {
  const p = value as IntegrationPayload;
  if (!p || typeof digest !== 'string' || !DIGEST.test(digest) || integrationDigest(p) !== digest ||
      !/^EP-[a-zA-Z0-9-]+$/.test(p.epicId) || p.repository !== REPOSITORY ||
      typeof p.featureBranch !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*$/.test(p.featureBranch) ||
      p.featureBranch.startsWith('refs/') || p.featureBranch.includes('//') || p.featureBranch.endsWith('/') || RESERVED.has(p.featureBranch) ||
      !SHA.test(p.baseSha) || !SHA.test(p.authorityRevision) ||
      ![p.unitDigest,p.manifestDigest,p.contractDigest].every(d => DIGEST.test(d)) ||
      typeof p.manifestApprovalEventId !== 'string' || !p.manifestApprovalEventId ||
      !Array.isArray(p.children) || p.children.length === 0 ||
      p.children.some(c => c.repository !== p.repository || !c.unitId.startsWith(`${p.epicId}-S`) || !Number.isSafeInteger(c.prNumber) ||
        c.prNumber < 1 || [2319,2320].includes(c.prNumber) || !SHA.test(c.headSha)) ||
      new Set(p.children.map(c => c.prNumber)).size !== p.children.length || new Set(p.children.map(c => c.unitId)).size !== p.children.length ||
      canonical(p.permittedScope) !== canonical({mergeEnumeratedChildHeadsOnly:true,additionalFileEdits:false,stageMerge:false,acceptTestResults:false,approveManifest:false}) ||
      !Array.isArray(p.capstoneChecks) || !p.capstoneChecks.length || p.capstoneChecks.some(c => typeof c !== 'string' || !c))
    throw Error('INTEGRATION_PAYLOAD_INVALID');
  return p;
}

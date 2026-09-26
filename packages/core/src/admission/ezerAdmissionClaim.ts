/**
 * Ezer admission v2 callback contract (Phase 4 implements the server).
 *
 * POST EZER_ADMISSION_CLAIM_URL (full URL, no implicit path), JSON AdmissionClaimRequest.
 * x-ezer-admission-signature = sha256=<hex HMAC-SHA256 of the exact UTF-8 body>, using
 * EZER_INTERNAL_API_SECRET (at least 32 bytes). No redirects; 10s timeout; non-200,
 * malformed/mismatched responses, absent configuration and network errors all refuse.
 *
 * `claim`: verify the signed admissionToken and ALL identity fields; atomically append
 * admission.consume-claimed via appendIfCurrent, serialized against cancel/start/retry.
 * Only the current unit generation, uncancelled unit and active grant may be claimed.
 * Key idempotency by admissionId and tokenDigest: the same admission returns its original
 * immutable claimId; changing any binding is refused. Retries never create another claim.
 * `check`: read-only, require that exact claimId and token binding still exist. Never create
 * a claim. Return a fresh linearizable currentGeneration/cancelled projection, including
 * on retried claims: the immutable claim is idempotent, current unit authority is NOT cached.
 *
 * 200 body: AdmissionClaimResponse. `claimed` must be true, identities/digest/generation
 * must match, currentGeneration must equal generation, cancelled must be false. Other
 * outcomes (including revocation/staleness) refuse. Generation is a positive safe integer
 * scoped to (repository, epicId, unitId), incremented by Ezer on cancel and every owner
 * start/retry, never reset or inferred from an incoming admission. expiresAt remains finite.
 *
 * Intake claims before Redis single-use consumption. The trusted Redis receipt preserves
 * the claim for a fresh `check` before receipt consumption/worker execution. Failed callbacks
 * do not burn either local credential. The v1 path NEVER calls this client.
 *
 * A cancel ordered after a claim is running work under D6. Ezer's durable cancel reconciler
 * MUST keep stopping the exact admissionId/operationId until cessation is confirmed, even
 * if no worker exists yet or a response is delayed. A check narrows that startup race; it
 * does not replace reconciliation after the last check or claim correctness in Ezer.
 */
import { createHash, createHmac } from 'node:crypto';
import { refuse } from './admissionBindings.js';

const CLAIM_VERSION = 2;
const CLAIM_TIMEOUT_MS = 10_000;
const MINIMUM_SECRET_BYTES = 32;
const CLAIM_SIGNATURE_HEADER = 'x-ezer-admission-signature';
const HTTP_OK = 200;

export interface AdmissionClaimIdentity {
    admissionId: string;
    operationId: string;
    repository: string;
    epicId: string;
    unitId: string;
    generation: number;
    tokenDigest: string;
}
export interface AdmissionClaimRequest extends AdmissionClaimIdentity {
    version: 2;
    action: 'claim' | 'check';
    admissionToken: string;
    /** Required for check; absent for claim. */
    claimId?: string;
}
export interface AdmissionClaimResponse extends AdmissionClaimIdentity {
    version: 2;
    claimed: boolean;
    claimId: string;
    currentGeneration: number;
    cancelled: boolean;
}
export interface StoredAdmissionClaim {
    identity: AdmissionClaimIdentity;
    admissionToken: string;
    claimId: string;
}
export type AdmissionClaimClient = (request: AdmissionClaimRequest) => Promise<AdmissionClaimResponse>;

export function admissionTokenDigest(token: string): string {
    return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

/** Config is read lazily, so an unconfigured callback has no effect on v1 installations. */
export const requestEzerAdmissionClaim: AdmissionClaimClient = async request => {
    let url: URL;
    try { url = new URL(process.env.EZER_ADMISSION_CLAIM_URL ?? ''); }
    catch { return refuse('claim-url-unconfigured'); }
    if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) refuse('claim-url-invalid');
    const secret = process.env.EZER_INTERNAL_API_SECRET ?? '';
    if (Buffer.byteLength(secret) < MINIMUM_SECRET_BYTES) refuse('claim-secret-unconfigured');
    const body = JSON.stringify(request);
    try {
        const response = await fetch(url, {
            method: 'POST', redirect: 'error', body,
            headers: { 'content-type': 'application/json',
                [CLAIM_SIGNATURE_HEADER]: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
            signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
        });
        if (response.status !== HTTP_OK) refuse('claim-refused');
        return await response.json() as AdmissionClaimResponse;
    } catch { return refuse('claim-unavailable'); }
};

export async function requireEzerAdmissionClaim(
    request: AdmissionClaimRequest, client: AdmissionClaimClient = requestEzerAdmissionClaim,
): Promise<StoredAdmissionClaim> {
    const result = await client(request);
    if (!result || result.version !== CLAIM_VERSION || result.claimed !== true ||
        typeof result.claimId !== 'string' || !result.claimId.trim()) refuse('claim-refused');
    const { admissionId, operationId, repository, epicId, unitId, generation, tokenDigest, admissionToken, claimId } = request;
    const identity: AdmissionClaimIdentity = { admissionId, operationId, repository, epicId, unitId, generation, tokenDigest };
    if (Object.entries(identity).some(([key, value]) => result[key as keyof AdmissionClaimIdentity] !== value) ||
        (claimId !== undefined && result.claimId !== claimId)) refuse('claim-binding-mismatch');
    if (!Number.isSafeInteger(result.currentGeneration) || result.currentGeneration !== request.generation)
        refuse('stale-unit-generation');
    if (result.cancelled !== false) refuse('unit-cancelled');
    return { identity, admissionToken, claimId: result.claimId };
}

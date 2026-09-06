import { createHmac, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';

const TOKEN_PART_COUNT = 2;
const SIGNATURE_ALGORITHM = 'sha256';
const MINIMUM_SECRET_BYTES = 32;
const CLOCK_SKEW_MS = 30_000;
const MILLISECONDS_PER_SECOND = 1_000;
const CONSUMED_KEY_PREFIX = 'ezer:execution-admission:consumed:';
const RECEIPT_KEY_PREFIX = 'ezer:execution-admission:receipt:';
const PENDING_KEY_PREFIX = 'ezer:execution-admission:pending:';
const REDIS_CONSUME_AND_ISSUE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
`;

export interface ExecutionAdmissionClaims {
    version: 1;
    admissionId: string;
    operationId: string;
    storyId: string;
    featureThread: string;
    epicId: string;
    repository: string;
    target: string;
    scope: string[];
    authorityRevision: string;
    authorityDigest: string;
    issueNumber: number;
    issuedAt: string;
    expiresAt: string;
}

export interface WorkerAdmissionReceipt {
    admissionId: string;
    operationId: string;
    receiptKey: string;
}

export function pendingExecutionAdmissionKey(repository: string, issueNumber: number): string {
    return `${PENDING_KEY_PREFIX}${repository}:${issueNumber}`;
}

export function createRedisAdmissionStore(redis: Redis): AdmissionStore {
    return {
        async consumeAndIssue(consumedKey, receiptKey, value, ttlSeconds) {
            const result = await redis.eval(REDIS_CONSUME_AND_ISSUE_SCRIPT, 2, consumedKey, receiptKey, value, String(ttlSeconds));
            return result === 1;
        },
        async get(key) {
            return redis.get(key);
        },
    };
}

export interface AdmissionStore {
    consumeAndIssue(consumedKey: string, receiptKey: string, value: string, ttlSeconds: number): Promise<boolean>;
    get(key: string): Promise<string | null>;
}

interface ExpectedExecution {
    repository: string;
    issueNumber: number;
}

function refuse(reason: string): never {
    throw new Error(`ezer-execution-admission-refused:${reason}`);
}

function requiredString(value: unknown, reason: string): string {
    if (typeof value !== 'string' || value.trim() === '') refuse(reason);
    return value;
}

function parseClaims(encodedPayload: string): ExecutionAdmissionClaims {
    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    } catch {
        refuse('malformed-admission');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('malformed-admission');
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== 1) refuse('unsupported-version');
    const scope = candidate.scope;
    if (!Array.isArray(scope) || scope.length === 0 || scope.some(item => typeof item !== 'string' || item.trim() === '')) {
        refuse('ambiguous-scope');
    }
    if (!Number.isSafeInteger(candidate.issueNumber) || Number(candidate.issueNumber) < 1) refuse('invalid-issue');
    return {
        version: 1,
        admissionId: requiredString(candidate.admissionId, 'missing-admission-id'),
        operationId: requiredString(candidate.operationId, 'missing-operation-id'),
        storyId: requiredString(candidate.storyId, 'missing-story-id'),
        featureThread: requiredString(candidate.featureThread, 'missing-feature-thread'),
        epicId: requiredString(candidate.epicId, 'missing-epic-id'),
        repository: requiredString(candidate.repository, 'missing-repository'),
        target: requiredString(candidate.target, 'missing-target'),
        scope: [...scope] as string[],
        authorityRevision: requiredString(candidate.authorityRevision, 'missing-authority-revision'),
        authorityDigest: requiredString(candidate.authorityDigest, 'missing-authority-digest'),
        issueNumber: Number(candidate.issueNumber),
        issuedAt: requiredString(candidate.issuedAt, 'missing-issued-at'),
        expiresAt: requiredString(candidate.expiresAt, 'missing-expires-at'),
    };
}

function verifySignature(encodedPayload: string, presentedSignature: string, signingSecret: string): void {
    if (Buffer.byteLength(signingSecret) < MINIMUM_SECRET_BYTES) refuse('weak-signing-secret');
    const expected = createHmac(SIGNATURE_ALGORITHM, signingSecret).update(encodedPayload).digest();
    let presented: Buffer;
    try {
        presented = Buffer.from(presentedSignature, 'base64url');
    } catch {
        refuse('bad-signature');
    }
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) refuse('bad-signature');
}

function validateClaims(claims: ExecutionAdmissionClaims, expected: ExpectedExecution, nowMs: number): number {
    if (claims.repository !== expected.repository) refuse('wrong-repository');
    if (claims.issueNumber !== expected.issueNumber) refuse('wrong-issue');
    const issuedAtMs = Date.parse(claims.issuedAt);
    const expiresAtMs = Date.parse(claims.expiresAt);
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) refuse('invalid-expiry');
    if (issuedAtMs > nowMs + CLOCK_SKEW_MS) refuse('not-yet-valid');
    if (expiresAtMs <= nowMs) refuse('expired');
    return Math.max(1, Math.ceil((expiresAtMs - nowMs) / MILLISECONDS_PER_SECOND));
}

export async function consumeExecutionAdmission(input: {
    token: string;
    signingSecret: string;
    expected: ExpectedExecution;
    store: AdmissionStore;
    nowMs?: number;
}): Promise<{ claims: ExecutionAdmissionClaims; receipt: WorkerAdmissionReceipt }> {
    const tokenParts = input.token.split('.');
    if (tokenParts.length !== TOKEN_PART_COUNT) refuse('malformed-admission');
    const [encodedPayload, signature] = tokenParts;
    verifySignature(encodedPayload, signature, input.signingSecret);
    const claims = parseClaims(encodedPayload);
    const ttlSeconds = validateClaims(claims, input.expected, input.nowMs ?? Date.now());
    const consumedKey = `${CONSUMED_KEY_PREFIX}${claims.admissionId}`;
    const receiptKey = `${RECEIPT_KEY_PREFIX}${claims.admissionId}`;
    const receiptValue = JSON.stringify({
        admissionId: claims.admissionId,
        operationId: claims.operationId,
        repository: claims.repository,
        issueNumber: claims.issueNumber,
    });
    if (!await input.store.consumeAndIssue(consumedKey, receiptKey, receiptValue, ttlSeconds)) refuse('replayed-admission');
    return { claims, receipt: { admissionId: claims.admissionId, operationId: claims.operationId, receiptKey } };
}

export async function verifyWorkerAdmissionReceipt(input: {
    receipt: WorkerAdmissionReceipt;
    expected: ExpectedExecution;
    store: Pick<AdmissionStore, 'get'>;
}): Promise<void> {
    const stored = await input.store.get(input.receipt.receiptKey);
    if (!stored) refuse('missing-worker-receipt');
    let value: Record<string, unknown>;
    try {
        value = JSON.parse(stored) as Record<string, unknown>;
    } catch {
        refuse('malformed-worker-receipt');
    }
    if (value.admissionId !== input.receipt.admissionId || value.operationId !== input.receipt.operationId) refuse('mismatched-worker-receipt');
    if (value.repository !== input.expected.repository) refuse('wrong-repository');
    if (value.issueNumber !== input.expected.issueNumber) refuse('wrong-issue');
}

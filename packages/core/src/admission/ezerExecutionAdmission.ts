import { createHmac, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { requireStoryExecutionContract, type StoryExecutionContract } from './storyExecutionContract.js';
import {
    ADMISSION_CLOCK_SKEW_MS, parseCommentBinding, parseStopBinding, refuse, requireExactComment, requireExecutionRoute,
    requireIsoTimestamp, requiredString, requireTypedArtifactCorrection, requireTypedInvestigation,
    type CommentAdmissionBinding, type ExecutionRouteBinding, type StopAdmissionBinding, type TypedArtifactCorrection,
    type TypedInvestigationAdmission,
} from './admissionBindings.js';
import { parseDelegation, requireDelegationWithinAdmission, requirePositiveOrdinal, type ExecutionDelegation } from './executionDelegation.js';
import { admissionUnitId, requireAdmissionUnitId, requireUnitWithinAdmission } from './admissionUnit.js';

export { requireTypedArtifactCorrection, requireTypedInvestigation };
export type { CommentAdmissionBinding, ExecutionRouteBinding, StopAdmissionBinding, TypedArtifactCorrection, TypedInvestigationAdmission };
export type { ExecutionDelegation, ExecutionDelegationScope } from './executionDelegation.js';
export { admissionUnitId } from './admissionUnit.js';

const TOKEN_PART_COUNT = 2;
const SIGNATURE_ALGORITHM = 'sha256';
const MINIMUM_SECRET_BYTES = 32;
const MILLISECONDS_PER_SECOND = 1_000;
const CONSUMED_KEY_PREFIX = 'ezer:execution-admission:consumed:';
const RECEIPT_KEY_PREFIX = 'ezer:execution-admission:receipt:';
const PENDING_KEY_PREFIX = 'ezer:execution-admission:pending:';
const REPOSITORY_LIST_SEPARATOR = ',';
const REDIS_CONSUME_AND_ISSUE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
`;

export interface ExecutionAdmissionClaims {
    delegatedAuthority?: ExecutionDelegation;
    storyExecution?: StoryExecutionContract;
  route?: ExecutionRouteBinding;
    control?: StopAdmissionBinding;
    artifactCorrection?: TypedArtifactCorrection;
    typedWork?: TypedInvestigationAdmission;
    comment?: CommentAdmissionBinding;
    version: 1;
    admissionId: string;
    operationId: string;
    storyId: string;
    /** Present only for a repository lane unit `<storyId>-T<nn>`; absent means the unit is the story. */
    unitId?: string;
    /** The executing attempt Ezer establishes from its own journal, outside any delegation. Required when delegated. */
    attemptOrdinal?: number;
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
    /** Optional: the delegated recovery grant's expiry. expiresAt still carries the full run lease. Absent = unchanged behaviour. */
    startBy?: string;
}

export interface WorkerAdmissionReceipt {
    delegatedAuthority?: ExecutionDelegation;
    route?: ExecutionRouteBinding;
    admissionId: string;
    operationId: string;
    /** Exact signed story identity. Older persisted receipts may omit it and fail closed at publication. */
    storyId?: string;
    receiptKey: string;
}

export function pendingExecutionAdmissionKey(repository: string, issueNumber: number): string {
    return `${PENDING_KEY_PREFIX}${repository}:${issueNumber}`;
}

export function requiresEzerExecutionAdmission(input: {
    repository: string;
    triggeringLabel?: string;
    requiredLabel?: string;
    protectedRepositories?: string;
}): boolean {
    const protectedRepositories = (input.protectedRepositories ?? '')
        .split(REPOSITORY_LIST_SEPARATOR)
        .map(repository => repository.trim())
        .filter(Boolean);
    const requiredLabel = input.requiredLabel?.trim();
    return protectedRepositories.includes(input.repository) || Boolean(requiredLabel && input.triggeringLabel === requiredLabel);
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
        async take(key) {
            return redis.getdel(key);
        },
    };
}

export interface AdmissionStore {
    consumeAndIssue(consumedKey: string, receiptKey: string, value: string, ttlSeconds: number): Promise<boolean>;
    get(key: string): Promise<string | null>;
    take(key: string): Promise<string | null>;
}

/** Metadata-only observation; never returns an admission or worker credential. */
export async function readExecutionAdmissionConsumption(store: Pick<AdmissionStore, 'get'>, admissionId: string) {
    const [consumed, receipt] = await Promise.all([
        store.get(`${CONSUMED_KEY_PREFIX}${admissionId}`),
        store.get(`${RECEIPT_KEY_PREFIX}${admissionId}`),
    ]);
    return { admissionConsumed: consumed !== null, workerReceiptPresent: receipt !== null };
}

interface ExpectedExecution {
    control?: StopAdmissionBinding;
    comment?: CommentAdmissionBinding;
    repository: string;
    issueNumber: number;
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
        ...(candidate.delegatedAuthority === undefined ? {} : { delegatedAuthority: parseDelegation(candidate.delegatedAuthority) }),
        ...(candidate.route === undefined ? {} : {route:requireExecutionRoute(candidate.route)}),
    ...(candidate.control === undefined ? {} : {control:parseStopBinding(candidate.control)}),
        ...(candidate.storyExecution === undefined ? {} : { storyExecution: requireStoryExecutionContract(candidate.storyExecution) }),
        ...(candidate.artifactCorrection === undefined ? {} : { artifactCorrection: requireTypedArtifactCorrection(candidate.artifactCorrection) }),
        ...(candidate.typedWork === undefined ? {} : { typedWork: requireTypedInvestigation(candidate.typedWork) }),
        ...(candidate.comment === undefined ? {} : { comment: parseCommentBinding(candidate.comment) }),
        version: 1,
        admissionId: requiredString(candidate.admissionId, 'missing-admission-id'),
        operationId: requiredString(candidate.operationId, 'missing-operation-id'),
        storyId: requiredString(candidate.storyId, 'missing-story-id'),
        ...(candidate.unitId === undefined ? {} : { unitId: requireAdmissionUnitId(candidate.unitId, String(candidate.storyId)) }),
        ...(candidate.attemptOrdinal === undefined ? {} : { attemptOrdinal: requirePositiveOrdinal(candidate.attemptOrdinal, 'invalid-attempt-ordinal') }),
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
        ...(candidate.startBy === undefined ? {} : { startBy: requireIsoTimestamp(candidate.startBy, 'malformed-admission') }),
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
    if (claims.storyExecution && (claims.control || claims.comment || claims.typedWork || claims.artifactCorrection ||
        claims.target !== claims.storyExecution.targetBranch || JSON.stringify(claims.scope) !== JSON.stringify(claims.storyExecution.allowedPaths)))
        refuse('story-execution-authority-mismatch');
    if(JSON.stringify(claims.control)!==JSON.stringify(expected.control===undefined?undefined:parseStopBinding(expected.control)))refuse('wrong-stop-control');
    if(claims.route&&(claims.control||claims.comment||claims.artifactCorrection))refuse('route-authority-mismatch');
    if(claims.route&&claims.attemptOrdinal!==undefined&&claims.route.attemptOrdinal!==claims.attemptOrdinal)refuse('route-attempt-mismatch');
    if(claims.route&&claims.typedWork&&(claims.typedWork.provider!==claims.route.provider||claims.typedWork.model!==claims.route.model))refuse('route-typed-mismatch');
    if(claims.control && (claims.typedWork || claims.comment || claims.artifactCorrection))refuse('stop-authority-mismatch');
    requireUnitWithinAdmission(claims);
    if (claims.typedWork && (claims.comment || claims.storyId !== `typed-work:${claims.typedWork.itemId}` ||
        claims.scope.length !== 1 || claims.scope[0] !== claims.typedWork.outputPath || Date.parse(claims.expiresAt) > Date.parse(claims.typedWork.deadline))) refuse('typed-authority-mismatch');
    if (claims.repository !== expected.repository) refuse('wrong-repository');
    if (claims.issueNumber !== expected.issueNumber) refuse('wrong-issue');
    if (claims.artifactCorrection && (claims.typedWork || !claims.comment ||
        claims.storyId !== `typed-output:${claims.artifactCorrection.itemId}` ||
        claims.scope.length !== 1 || claims.scope[0] !== claims.artifactCorrection.outputPath ||
        claims.comment.headSha !== claims.artifactCorrection.priorRevision ||
        claims.expiresAt !== claims.artifactCorrection.deadline)) refuse('typed-correction-authority-mismatch');
    requireExactComment(claims.comment, expected.comment);
    const issuedAtMs = Date.parse(claims.issuedAt);
    const expiresAtMs = Date.parse(claims.expiresAt);
    if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= issuedAtMs) refuse('invalid-expiry');
    if (issuedAtMs > nowMs + ADMISSION_CLOCK_SKEW_MS) refuse('not-yet-valid');
    if (expiresAtMs <= nowMs) refuse('expired');
    if (claims.startBy !== undefined && Date.parse(claims.startBy) <= nowMs) refuse('expired');
    requireDelegationWithinAdmission({ ...claims, unit: admissionUnitId(claims) }, nowMs);
    return Math.max(1, Math.ceil((expiresAtMs - nowMs) / MILLISECONDS_PER_SECOND));
}

export async function consumeExecutionAdmission(input: {
    token: string;
    signingSecret: string;
    expected: ExpectedExecution;
    store: AdmissionStore;
    nowMs?: number;
    /** Runs only after signature and claim validation; rejection preserves the single-use admission. */
    preConsumePolicy?: (claims: ExecutionAdmissionClaims) => Promise<void>;
}): Promise<{ claims: ExecutionAdmissionClaims; receipt: WorkerAdmissionReceipt }> {
    const tokenParts = input.token.split('.');
    if (tokenParts.length !== TOKEN_PART_COUNT) refuse('malformed-admission');
    const [encodedPayload, signature] = tokenParts;
    verifySignature(encodedPayload, signature, input.signingSecret);
    const claims = parseClaims(encodedPayload);
    validateClaims(claims, input.expected, input.nowMs ?? Date.now());
    await input.preConsumePolicy?.(claims);
    const ttlSeconds = validateClaims(claims, input.expected, input.nowMs ?? Date.now());
    const consumedKey = `${CONSUMED_KEY_PREFIX}${claims.admissionId}`;
    const receiptKey = `${RECEIPT_KEY_PREFIX}${claims.admissionId}`;
    const receiptValue = JSON.stringify({
        ...(claims.delegatedAuthority === undefined ? {} : { delegatedAuthority: claims.delegatedAuthority }),
        admissionId: claims.admissionId,
        operationId: claims.operationId,
        storyId: claims.storyId,
        ...(claims.unitId === undefined ? {} : { unitId: claims.unitId }),
        ...(claims.attemptOrdinal === undefined ? {} : { attemptOrdinal: claims.attemptOrdinal }),
        repository: claims.repository,
        issueNumber: claims.issueNumber,
        target: claims.target,
        ...(claims.storyExecution === undefined ? {} : { storyExecution: claims.storyExecution, executionDeadline: claims.expiresAt }),
        ...(claims.storyId === `${claims.epicId}:integration:${claims.authorityDigest}` ? {integrationDigest:claims.authorityDigest} : {}),
        ...(claims.route === undefined ? {} : {route:claims.route}),
        ...(claims.control === undefined ? {} : {control:claims.control}),
        ...(claims.artifactCorrection === undefined ? {} : { artifactCorrection: claims.artifactCorrection }),
        ...(claims.typedWork === undefined ? {} : { typedWork: claims.typedWork }),
        ...(claims.comment === undefined ? {} : { comment: claims.comment }),
        ...(claims.startBy === undefined ? {} : { startBy: claims.startBy }),
    });
    if (!await input.store.consumeAndIssue(consumedKey, receiptKey, receiptValue, ttlSeconds)) refuse('replayed-admission');
    return { claims, receipt: { ...(claims.delegatedAuthority ? { delegatedAuthority: claims.delegatedAuthority } : {}), ...(claims.route ? {route:claims.route} : {}), admissionId: claims.admissionId, operationId: claims.operationId, storyId: claims.storyId, receiptKey } };
}

interface WorkerReceiptVerification {
    receipt: WorkerAdmissionReceipt;
    expected: ExpectedExecution & { target: string };
    expectedRoute?: {agentId:string;agentAlias:string;provider:string;model:string};
    expectedIntegrationDigest?: string;
    onArtifactCorrection?: (binding: TypedArtifactCorrection) => void;
    requireStoryExecution?: boolean;
    onStoryExecution?: (binding: StoryExecutionContract) => void;
    onExecutionDeadline?: (deadline: string) => void;
}

/** Authorizes preparation only. Execution must still consume the receipt atomically. */
export async function inspectWorkerAdmissionReceipt(input: WorkerReceiptVerification & {
    store: Pick<AdmissionStore, 'get'>;
}): Promise<TypedInvestigationAdmission | undefined> {
    return validateWorkerAdmissionReceipt(await input.store.get(input.receipt.receiptKey), input);
}

export async function verifyWorkerAdmissionReceipt(input: WorkerReceiptVerification & {
    store: Pick<AdmissionStore, 'take'>;
}): Promise<TypedInvestigationAdmission | undefined> {
    return validateWorkerAdmissionReceipt(await input.store.take(input.receipt.receiptKey), input);
}

function validateWorkerAdmissionReceipt(stored: string | null, input: WorkerReceiptVerification): TypedInvestigationAdmission | undefined {
    if (!stored) refuse('missing-worker-receipt');
    let value: Record<string, unknown>;
    try {
        value = JSON.parse(stored) as Record<string, unknown>;
    } catch {
        refuse('malformed-worker-receipt');
    }
    if(value.control!==undefined)refuse('stop-control-cannot-start-worker');
    const delegated = value.delegatedAuthority === undefined ? undefined : parseDelegation(value.delegatedAuthority);
    if (JSON.stringify(delegated) !== JSON.stringify(input.receipt.delegatedAuthority)) refuse('delegation-receipt-changed');
    if (value.integrationDigest !== input.expectedIntegrationDigest) refuse('integration-worker-binding-changed');
    if (value.admissionId !== input.receipt.admissionId || value.operationId !== input.receipt.operationId ||
        value.storyId !== input.receipt.storyId) refuse('mismatched-worker-receipt');
    if (value.repository !== input.expected.repository) refuse('wrong-repository');
    if (value.issueNumber !== input.expected.issueNumber) refuse('wrong-issue');
    if (value.target !== input.expected.target) refuse('wrong-target');
    requireExactComment(value.comment as CommentAdmissionBinding | undefined, input.expected.comment);
    if(value.route!==undefined){
      const route=requireExecutionRoute(value.route),actual=input.expectedRoute;
      if(!actual||actual.agentId!==route.agentId||actual.agentAlias!==route.agentAlias||actual.provider!==route.provider||actual.model!==route.model)refuse('selected-route-mismatch');
      if(JSON.stringify(input.receipt.route)!==JSON.stringify(route))refuse('selected-route-receipt-changed');
    } else if(input.receipt.route!==undefined)refuse('unsigned-selected-route');
    const typed = value.typedWork === undefined ? undefined : requireTypedInvestigation(value.typedWork);
    if (value.storyExecution !== undefined) {
        const execution = requireStoryExecutionContract(value.storyExecution);
        if (typed || value.comment || value.artifactCorrection || value.integrationDigest ||
            typeof value.storyId !== 'string' || value.storyId.trim() === '' || execution.targetBranch !== value.target)
            refuse('story-execution-authority-mismatch');
        if (typeof value.executionDeadline !== 'string' || !Number.isFinite(Date.parse(value.executionDeadline)))
            refuse('story-execution-deadline-required');
        if (Date.parse(value.executionDeadline) <= Date.now()) refuse('story-execution-deadline-exceeded');
        requireUnitWithinAdmission({ storyId: value.storyId, storyExecution: execution,
            ...(value.unitId === undefined ? {} : { unitId: requireAdmissionUnitId(value.unitId, value.storyId) }) });
        input.onStoryExecution?.(execution);
        input.onExecutionDeadline?.(value.executionDeadline);
    } else if (value.unitId !== undefined) refuse('unit-authority-mismatch');
    else if (input.requireStoryExecution && !typed) refuse('story-execution-contract-required');
    if (typed && Date.parse(typed.deadline) <= Date.now()) refuse('typed-deadline-exceeded');
    if (value.artifactCorrection !== undefined) {
        const correction = requireTypedArtifactCorrection(value.artifactCorrection);
        if (!input.expected.comment || input.expected.comment.headSha !== correction.priorRevision || Date.parse(correction.deadline) <= Date.now()) refuse('typed-correction-expired-or-head-changed');
        input.onArtifactCorrection?.(correction);
    }
    return typed;
}

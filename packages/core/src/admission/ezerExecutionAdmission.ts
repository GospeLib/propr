import { createHmac, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { requireStoryExecutionContract, type StoryExecutionContract } from './storyExecutionContract.js';

const TOKEN_PART_COUNT = 2;
const SIGNATURE_ALGORITHM = 'sha256';
const MINIMUM_SECRET_BYTES = 32;
const CLOCK_SKEW_MS = 30_000;
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

export interface CommentAdmissionBinding {
    commentId: number;
    bodyDigest: string;
    headSha: string;
    headBranch: string;
}

export interface TypedInvestigationAdmission {
  kind: 'research' | 'design' | 'spike';
  provider?: 'claude' | 'codex' | 'ollama';
  model?: string;
  itemId: string;
  deadline: string;
  outputPath: string;
  outputKind: string;
}
export function requireTypedInvestigation(value: unknown): TypedInvestigationAdmission {
  if (!value || typeof value !== 'object') throw new Error('INVALID_TYPED_ADMISSION');
  const v = value as Record<string, unknown>;
  const kinds: Record<string, string> = { research: 'research-report', design: 'design-artifact', spike: 'registry-open-question' };
  if (typeof v.kind !== 'string' || !Object.hasOwn(kinds, v.kind) || v.outputKind !== kinds[v.kind] ||
      typeof v.itemId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.itemId) ||
      typeof v.deadline !== 'string' || !Number.isFinite(Date.parse(v.deadline)) ||
      typeof v.outputPath !== 'string' || !/^docs\/(research|design|spikes)\/ezer-[a-f0-9-]{36}\.md$/.test(v.outputPath))
    throw new Error('INVALID_TYPED_ADMISSION');
  if(v.provider!==undefined&&!['claude','codex','ollama'].includes(String(v.provider)))throw new Error('INVALID_TYPED_PROVIDER');
  if(v.model!==undefined&&(typeof v.model!=='string'||!v.model.trim()||!v.provider))throw new Error('INVALID_TYPED_MODEL');
  return { ...(v.provider===undefined?{}:{provider:v.provider as TypedInvestigationAdmission['provider']}),...(v.model===undefined?{}:{model:v.model as string}),kind: v.kind as TypedInvestigationAdmission['kind'], itemId: v.itemId, deadline: v.deadline, outputPath: v.outputPath, outputKind: v.outputKind as string };
}

/** A separately admitted owner correction to an existing typed artifact, never investigation authority. */
export interface TypedArtifactCorrection {
    itemId: string;
    outputPath: string;
    priorRevision: string;
    priorDigest: string;
    deadline: string;
}
export function requireTypedArtifactCorrection(value: unknown): TypedArtifactCorrection {
    if (!value || typeof value !== 'object') throw new Error('INVALID_TYPED_ARTIFACT_CORRECTION');
    const v = value as Record<string, unknown>;
    if (typeof v.itemId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.itemId) ||
        typeof v.outputPath !== 'string' || !new RegExp(`^docs/(research|design|spikes)/ezer-${v.itemId}\\.md$`).test(v.outputPath) ||
        typeof v.priorRevision !== 'string' || !/^[a-f0-9]{40}$/.test(v.priorRevision) ||
        typeof v.priorDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(v.priorDigest) ||
        typeof v.deadline !== 'string' || !Number.isFinite(Date.parse(v.deadline))) throw new Error('INVALID_TYPED_ARTIFACT_CORRECTION');
    return {itemId:v.itemId,outputPath:v.outputPath,priorRevision:v.priorRevision,priorDigest:v.priorDigest,deadline:v.deadline};
}

/** Stop authority targets one already verified execution and one actual owner comment. */
export interface StopAdmissionBinding {
    kind: 'stop'; taskId: string; executionAdmissionId: string; executionOperationId: string;
    containerId: string; unitId: string; ownerAccountId: string; commentId: number; bodyDigest: string;
}
function parseStopBinding(value: unknown): StopAdmissionBinding {
    if (!value || typeof value !== 'object') refuse('invalid-stop-control');
    const v=value as Record<string,unknown>;
    if(v.kind!=='stop'||!Number.isSafeInteger(v.commentId)||Number(v.commentId)<1)refuse('invalid-stop-control');
    return {kind:'stop',taskId:requiredString(v.taskId,'invalid-stop-task'),executionAdmissionId:requiredString(v.executionAdmissionId,'invalid-stop-execution'),
        executionOperationId:requiredString(v.executionOperationId,'invalid-stop-operation'),containerId:requiredString(v.containerId,'invalid-stop-container'),
        unitId:requiredString(v.unitId,'invalid-stop-unit'),ownerAccountId:requiredString(v.ownerAccountId,'invalid-stop-owner'),
        commentId:Number(v.commentId),bodyDigest:requiredString(v.bodyDigest,'invalid-stop-comment')};
}

export interface ExecutionRouteBinding {selectionId:string;routeId:string;agentId:string;agentAlias:string;provider:string;model:string;attemptOrdinal:number;}
function requireExecutionRoute(value:unknown):ExecutionRouteBinding {
 if(!value||typeof value!=='object')throw new Error('INVALID_EXECUTION_ROUTE');
 const v=value as Record<string,unknown>;
 for(const key of ['selectionId','routeId','agentId','agentAlias','provider','model'])if(typeof v[key]!=='string'||!v[key]||/\s/.test(String(v[key])))throw new Error('INVALID_EXECUTION_ROUTE');
 if(!Number.isSafeInteger(v.attemptOrdinal)||Number(v.attemptOrdinal)<1||v.routeId!==`${v.agentAlias}:${v.model}`)throw new Error('INVALID_EXECUTION_ROUTE');
 return {selectionId:String(v.selectionId),routeId:String(v.routeId),agentId:String(v.agentId),agentAlias:String(v.agentAlias),provider:String(v.provider),model:String(v.model),attemptOrdinal:Number(v.attemptOrdinal)};
}

export interface ExecutionAdmissionClaims {
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
    route?: ExecutionRouteBinding;
    admissionId: string;
    operationId: string;
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

interface ExpectedExecution {
    control?: StopAdmissionBinding;
    comment?: CommentAdmissionBinding;
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

function parseCommentBinding(value: unknown): CommentAdmissionBinding {
    if (!value || typeof value !== 'object') refuse('invalid-comment');
    const candidate = value as Record<string, unknown>;
    if (!Number.isSafeInteger(candidate.commentId) || Number(candidate.commentId) < 1) refuse('invalid-comment');
    return { commentId: Number(candidate.commentId), bodyDigest: requiredString(candidate.bodyDigest, 'invalid-comment'),
        headSha: requiredString(candidate.headSha, 'invalid-comment'), headBranch: requiredString(candidate.headBranch, 'invalid-comment') };
}

function requireExactComment(actual: CommentAdmissionBinding | undefined, expected: CommentAdmissionBinding | undefined): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) refuse('wrong-comment');
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
    if(claims.route&&claims.typedWork&&(claims.typedWork.provider!==claims.route.provider||claims.typedWork.model!==claims.route.model))refuse('route-typed-mismatch');
    if(claims.control && (claims.typedWork || claims.comment || claims.artifactCorrection || claims.storyId!==claims.control.unitId))refuse('stop-authority-mismatch');
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
        target: claims.target,
        ...(claims.storyExecution === undefined ? {} : { storyExecution: claims.storyExecution, executionDeadline: claims.expiresAt }),
        ...(claims.storyId === `${claims.epicId}:integration:${claims.authorityDigest}` ? {integrationDigest:claims.authorityDigest} : {}),
        ...(claims.route === undefined ? {} : {route:claims.route}),
        ...(claims.control === undefined ? {} : {control:claims.control}),
        ...(claims.artifactCorrection === undefined ? {} : { artifactCorrection: claims.artifactCorrection }),
        ...(claims.typedWork === undefined ? {} : { typedWork: claims.typedWork }),
        ...(claims.comment === undefined ? {} : { comment: claims.comment }),
    });
    if (!await input.store.consumeAndIssue(consumedKey, receiptKey, receiptValue, ttlSeconds)) refuse('replayed-admission');
    return { claims, receipt: { ...(claims.route ? {route:claims.route} : {}), admissionId: claims.admissionId, operationId: claims.operationId, receiptKey } };
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
    if (value.integrationDigest !== input.expectedIntegrationDigest) refuse('integration-worker-binding-changed');
    if (value.admissionId !== input.receipt.admissionId || value.operationId !== input.receipt.operationId) refuse('mismatched-worker-receipt');
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
        if (typed || value.comment || value.artifactCorrection || value.integrationDigest || execution.targetBranch !== value.target)
            refuse('story-execution-authority-mismatch');
        if (typeof value.executionDeadline !== 'string' || !Number.isFinite(Date.parse(value.executionDeadline)))
            refuse('story-execution-deadline-required');
        if (Date.parse(value.executionDeadline) <= Date.now()) refuse('story-execution-deadline-exceeded');
        input.onStoryExecution?.(execution);
        input.onExecutionDeadline?.(value.executionDeadline);
    } else if (input.requireStoryExecution && !typed) refuse('story-execution-contract-required');
    if (typed && Date.parse(typed.deadline) <= Date.now()) refuse('typed-deadline-exceeded');
    if (value.artifactCorrection !== undefined) {
        const correction = requireTypedArtifactCorrection(value.artifactCorrection);
        if (!input.expected.comment || input.expected.comment.headSha !== correction.priorRevision || Date.parse(correction.deadline) <= Date.now()) refuse('typed-correction-expired-or-head-changed');
        input.onArtifactCorrection?.(correction);
    }
    return typed;
}

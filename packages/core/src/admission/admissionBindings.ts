/**
 * Shape validators for the optional bindings an Ezer execution admission may carry. Each parser
 * accepts only its exact shape and fails closed; cross-claim authority lives in
 * ezerExecutionAdmission.ts, executionDelegation.ts and admissionUnit.ts.
 */

/** Tolerated issuer/consumer clock difference for every admission timestamp check. */
export const ADMISSION_CLOCK_SKEW_MS = 30_000;

export function refuse(reason: string): never {
    throw new Error(`ezer-execution-admission-refused:${reason}`);
}

export function requiredString(value: unknown, reason: string): string {
    if (typeof value !== 'string' || value.trim() === '') refuse(reason);
    return value;
}

export function requireIsoTimestamp(value: unknown, reason: string): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) refuse(reason);
    return value;
}

export interface CommentAdmissionBinding {
    commentId: number;
    bodyDigest: string;
    headSha: string;
    headBranch: string;
}

export function parseCommentBinding(value: unknown): CommentAdmissionBinding {
    if (!value || typeof value !== 'object') refuse('invalid-comment');
    const candidate = value as Record<string, unknown>;
    if (!Number.isSafeInteger(candidate.commentId) || Number(candidate.commentId) < 1) refuse('invalid-comment');
    return { commentId: Number(candidate.commentId), bodyDigest: requiredString(candidate.bodyDigest, 'invalid-comment'),
        headSha: requiredString(candidate.headSha, 'invalid-comment'), headBranch: requiredString(candidate.headBranch, 'invalid-comment') };
}

export function requireExactComment(actual: CommentAdmissionBinding | undefined, expected: CommentAdmissionBinding | undefined): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) refuse('wrong-comment');
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
export function parseStopBinding(value: unknown): StopAdmissionBinding {
    if (!value || typeof value !== 'object') refuse('invalid-stop-control');
    const v=value as Record<string,unknown>;
    if(v.kind!=='stop'||!Number.isSafeInteger(v.commentId)||Number(v.commentId)<1)refuse('invalid-stop-control');
    return {kind:'stop',taskId:requiredString(v.taskId,'invalid-stop-task'),executionAdmissionId:requiredString(v.executionAdmissionId,'invalid-stop-execution'),
        executionOperationId:requiredString(v.executionOperationId,'invalid-stop-operation'),containerId:requiredString(v.containerId,'invalid-stop-container'),
        unitId:requiredString(v.unitId,'invalid-stop-unit'),ownerAccountId:requiredString(v.ownerAccountId,'invalid-stop-owner'),
        commentId:Number(v.commentId),bodyDigest:requiredString(v.bodyDigest,'invalid-stop-comment')};
}

export interface ExecutionRouteBinding {selectionId:string;routeId:string;agentId:string;agentAlias:string;provider:string;model:string;attemptOrdinal:number;}
export function requireExecutionRoute(value:unknown):ExecutionRouteBinding {
 if(!value||typeof value!=='object')throw new Error('INVALID_EXECUTION_ROUTE');
 const v=value as Record<string,unknown>;
 for(const key of ['selectionId','routeId','agentId','agentAlias','provider','model'])if(typeof v[key]!=='string'||!v[key]||/\s/.test(String(v[key])))throw new Error('INVALID_EXECUTION_ROUTE');
 if(!Number.isSafeInteger(v.attemptOrdinal)||Number(v.attemptOrdinal)<1||v.routeId!==`${v.agentAlias}:${v.model}`)throw new Error('INVALID_EXECUTION_ROUTE');
 return {selectionId:String(v.selectionId),routeId:String(v.routeId),agentId:String(v.agentId),agentAlias:String(v.agentAlias),provider:String(v.provider),model:String(v.model),attemptOrdinal:Number(v.attemptOrdinal)};
}

/**
 * The delegated authority an Ezer execution admission may be issued under, in the exact shape
 * Ezer signs (services/ezer/src/upstreams/propr-admission-delegation.ts `ExecutionDelegation`).
 *
 * V1 requires the grant window. V2 permits durable grants without grantExpiresAt; both require
 * a scope naming the exact unit, epic, repository, issue, attempt, target branch and paths.
 * A delegation missing any scope field is refused, never read as "unconstrained". Both versions
 * require this exact scope, and a delegated admission always carries a story execution.
 *
 * The attempt the grant names is checked against the executing attempt Ezer signs outside the
 * delegation (`attemptOrdinal`), and against the selected route's attempt when one is signed; an
 * admission with no signed executing attempt cannot be held to its grant and is refused.
 */
import { ADMISSION_CLOCK_SKEW_MS, refuse, requiredString, requireIsoTimestamp } from './admissionBindings.js';

/** The exact work a delegated grant authorizes, copied from the grant itself. */
export interface ExecutionDelegationScope {
    epicId: string;
    /** The Ezer unit the grant authorizes: the story, or one repository lane `<story>-T<nn>`. */
    storyId: string;
    repository: string;
    issueNumber: number;
    attemptOrdinal: number;
    targetBranch: string;
    allowedPaths: string[];
}

export interface ExecutionDelegation {
    grantId: string;
    delegatePrincipalId: string;
    delegateSessionId: string;
    approvalPrincipalId: string;
    grantIssuedAt: string;
    grantExpiresAt?: string;
    provenance?: string;
    approvalEventId?: string;
    proposalEventId?: string;
    authorizationReference?: string;
    scope: ExecutionDelegationScope;
}

const OPTIONAL_REFERENCES = ['provenance', 'approvalEventId', 'proposalEventId', 'authorizationReference'] as const;
const INVALID_SCOPE = 'invalid-delegation-scope';
const INVALID_WINDOW = 'invalid-delegation-grant-window';
const MINIMUM_ORDINAL = 1;

/** A positive safe integer, or refusal with `reason`. */
export function requirePositiveOrdinal(value: unknown, reason: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < MINIMUM_ORDINAL) refuse(reason);
    return Number(value);
}

function parseScope(input: unknown): ExecutionDelegationScope {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse(INVALID_SCOPE);
    const value = input as Record<string, unknown>;
    if (!Array.isArray(value.allowedPaths) || value.allowedPaths.length === 0 ||
        value.allowedPaths.some(path => typeof path !== 'string' || path.trim() === '')) refuse(INVALID_SCOPE);
    return {
        epicId: requiredString(value.epicId, INVALID_SCOPE),
        storyId: requiredString(value.storyId, INVALID_SCOPE),
        repository: requiredString(value.repository, INVALID_SCOPE),
        issueNumber: requirePositiveOrdinal(value.issueNumber, INVALID_SCOPE),
        attemptOrdinal: requirePositiveOrdinal(value.attemptOrdinal, INVALID_SCOPE),
        targetBranch: requiredString(value.targetBranch, INVALID_SCOPE),
        allowedPaths: [...(value.allowedPaths as string[])],
    };
}

export function parseDelegation(input: unknown, version: 1 | 2 = 1): ExecutionDelegation {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('invalid-execution-delegation');
    const value = input as Record<string, unknown>;
    const references: Partial<Pick<ExecutionDelegation, typeof OPTIONAL_REFERENCES[number]>> = {};
    for (const field of OPTIONAL_REFERENCES)
        if (value[field] !== undefined) references[field] = requiredString(value[field], `invalid-delegation-${field}`);
    const grantIssuedAt = requireIsoTimestamp(value.grantIssuedAt, INVALID_WINDOW);
    const grantExpiresAt = version === 2 && value.grantExpiresAt === undefined
        ? undefined : requireIsoTimestamp(value.grantExpiresAt, INVALID_WINDOW);
    if (grantExpiresAt !== undefined && Date.parse(grantExpiresAt) <= Date.parse(grantIssuedAt)) refuse(INVALID_WINDOW);
    return {
        grantId: requiredString(value.grantId, 'missing-delegation-grant'),
        delegatePrincipalId: requiredString(value.delegatePrincipalId, 'missing-delegation-principal'),
        delegateSessionId: requiredString(value.delegateSessionId, 'missing-delegation-session'),
        approvalPrincipalId: requiredString(value.approvalPrincipalId, 'missing-delegation-approval-principal'),
        grantIssuedAt,
        ...(grantExpiresAt === undefined ? {} : { grantExpiresAt }),
        ...references,
        scope: parseScope(value.scope),
    };
}

/** The claims a delegated grant is checked against. */
export interface DelegatedAdmission {
    version?: 1 | 2;
    delegatedAuthority?: ExecutionDelegation;
    storyExecution?: unknown;
    /** The executing attempt Ezer signs outside the delegation. */
    attemptOrdinal?: number;
    route?: { attemptOrdinal: number };
    unit: string;
    epicId: string;
    repository: string;
    issueNumber: number;
    target: string;
    scope: string[];
    startBy?: string;
}

/**
 * A delegated admission may be consumed only while its grant authorizes a start, only for the
 * exact work the grant names, and only for the attempt the grant names. `unit` is the admission's
 * Ezer unit, never its parent story.
 */
export function requireDelegationWithinAdmission(admission: DelegatedAdmission, nowMs: number): void {
    const delegation = admission.delegatedAuthority;
    if (!delegation) return;
    const { grantIssuedAt, grantExpiresAt, scope } = delegation;
    if (!admission.storyExecution) refuse('delegation-requires-story-execution');
    if (Date.parse(grantIssuedAt) > nowMs + ADMISSION_CLOCK_SKEW_MS) refuse('not-yet-valid');
    if (grantExpiresAt !== undefined && Date.parse(grantExpiresAt) <= nowMs) refuse('expired');
    if ((admission.version !== 2 && (grantExpiresAt === undefined || admission.startBy === undefined)) ||
        (grantExpiresAt !== undefined && admission.startBy !== undefined && Date.parse(admission.startBy) > Date.parse(grantExpiresAt)))
        refuse('delegation-start-unbounded');
    if (admission.attemptOrdinal === undefined) refuse('delegation-attempt-unknown');
    if (scope.attemptOrdinal !== admission.attemptOrdinal ||
        (admission.route !== undefined && admission.route.attemptOrdinal !== admission.attemptOrdinal))
        refuse('delegation-attempt-mismatch');
    if (scope.epicId !== admission.epicId || scope.storyId !== admission.unit ||
        scope.repository !== admission.repository || scope.issueNumber !== admission.issueNumber ||
        scope.targetBranch !== admission.target || JSON.stringify(scope.allowedPaths) !== JSON.stringify(admission.scope))
        refuse('delegation-scope-mismatch');
}

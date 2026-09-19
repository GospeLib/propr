/**
 * The delegated authority an Ezer execution admission may be issued under, in the exact shape
 * Ezer signs (services/ezer/src/upstreams/propr-admission.ts `ExecutionDelegation`).
 *
 * The four identity fields are the original shape. The grant window, provenance references and
 * scope are optional only because admissions minted before them still parse; when present they
 * bind: the admission may be consumed only inside the grant window, and only for the exact unit,
 * repository, issue, target and paths the grant names. A lane's grant never widens to its story.
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
    targetBranch?: string;
    allowedPaths?: string[];
}

export interface ExecutionDelegation {
    grantId: string;
    delegatePrincipalId: string;
    delegateSessionId: string;
    approvalPrincipalId: string;
    grantIssuedAt?: string;
    grantExpiresAt?: string;
    provenance?: string;
    approvalEventId?: string;
    proposalEventId?: string;
    authorizationReference?: string;
    scope?: ExecutionDelegationScope;
}

const OPTIONAL_REFERENCES = ['provenance', 'approvalEventId', 'proposalEventId', 'authorizationReference'] as const;
const INVALID_SCOPE = 'invalid-delegation-scope';

function positiveInteger(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) refuse(INVALID_SCOPE);
    return Number(value);
}

function parseScope(input: unknown): ExecutionDelegationScope {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse(INVALID_SCOPE);
    const value = input as Record<string, unknown>;
    if (value.allowedPaths !== undefined && (!Array.isArray(value.allowedPaths) || value.allowedPaths.length === 0 ||
        value.allowedPaths.some(path => typeof path !== 'string' || path.trim() === ''))) refuse(INVALID_SCOPE);
    return {
        epicId: requiredString(value.epicId, INVALID_SCOPE),
        storyId: requiredString(value.storyId, INVALID_SCOPE),
        repository: requiredString(value.repository, INVALID_SCOPE),
        issueNumber: positiveInteger(value.issueNumber),
        attemptOrdinal: positiveInteger(value.attemptOrdinal),
        ...(value.targetBranch === undefined ? {} : { targetBranch: requiredString(value.targetBranch, INVALID_SCOPE) }),
        ...(value.allowedPaths === undefined ? {} : { allowedPaths: [...(value.allowedPaths as string[])] }),
    };
}

export function parseDelegation(input: unknown): ExecutionDelegation {
    if (!input || typeof input !== 'object' || Array.isArray(input)) refuse('invalid-execution-delegation');
    const value = input as Record<string, unknown>;
    const references: Partial<Pick<ExecutionDelegation, typeof OPTIONAL_REFERENCES[number]>> = {};
    for (const field of OPTIONAL_REFERENCES)
        if (value[field] !== undefined) references[field] = requiredString(value[field], `invalid-delegation-${field}`);
    return {
        grantId: requiredString(value.grantId, 'missing-delegation-grant'),
        delegatePrincipalId: requiredString(value.delegatePrincipalId, 'missing-delegation-principal'),
        delegateSessionId: requiredString(value.delegateSessionId, 'missing-delegation-session'),
        approvalPrincipalId: requiredString(value.approvalPrincipalId, 'missing-delegation-approval-principal'),
        ...(value.grantIssuedAt === undefined ? {} : { grantIssuedAt: requireIsoTimestamp(value.grantIssuedAt, 'invalid-delegation-grant-window') }),
        ...(value.grantExpiresAt === undefined ? {} : { grantExpiresAt: requireIsoTimestamp(value.grantExpiresAt, 'invalid-delegation-grant-window') }),
        ...references,
        ...(value.scope === undefined ? {} : { scope: parseScope(value.scope) }),
    };
}

/** The claims a delegated grant is checked against. */
export interface DelegatedAdmission {
    delegatedAuthority?: ExecutionDelegation;
    unit: string;
    epicId: string;
    repository: string;
    issueNumber: number;
    target: string;
    scope: string[];
    startBy?: string;
}

/**
 * A delegated admission may be consumed only while its grant authorizes a start, and only for the
 * exact work the grant names. `unit` is the admission's Ezer unit, never its parent story.
 */
export function requireDelegationWithinAdmission(admission: DelegatedAdmission, nowMs: number): void {
    const delegation = admission.delegatedAuthority;
    if (!delegation) return;
    const { grantIssuedAt, grantExpiresAt, scope } = delegation;
    if (grantIssuedAt !== undefined && grantExpiresAt !== undefined && Date.parse(grantExpiresAt) <= Date.parse(grantIssuedAt))
        refuse('invalid-delegation-grant-window');
    if (grantIssuedAt !== undefined && Date.parse(grantIssuedAt) > nowMs + ADMISSION_CLOCK_SKEW_MS) refuse('not-yet-valid');
    if (grantExpiresAt !== undefined) {
        if (Date.parse(grantExpiresAt) <= nowMs) refuse('expired');
        if (admission.startBy === undefined || Date.parse(admission.startBy) > Date.parse(grantExpiresAt))
            refuse('delegation-start-unbounded');
    }
    if (scope && (scope.epicId !== admission.epicId || scope.storyId !== admission.unit ||
        scope.repository !== admission.repository || scope.issueNumber !== admission.issueNumber ||
        (scope.targetBranch !== undefined && scope.targetBranch !== admission.target) ||
        (scope.allowedPaths !== undefined && JSON.stringify(scope.allowedPaths) !== JSON.stringify(admission.scope))))
        refuse('delegation-scope-mismatch');
}

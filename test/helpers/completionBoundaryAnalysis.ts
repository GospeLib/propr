/**
 * Repository-wide analysis of who publishes `completed`, who runs a model execution, and how the
 * two meet.
 *
 * A regex sweep over a fixed directory can only police the spellings someone remembered: it
 * already mis-classified a review job as non-executing because the execution happens in an
 * imported helper and is spelled `analyze` rather than `executeTask`. This analysis parses the
 * sources instead, resolves local aliases and variables, derives the model-execution method names
 * from the `Agent` interface itself, and follows relative imports so a completion publisher is
 * judged by what it can actually reach — not by what its own text happens to say.
 *
 * It is the SECOND net. The first is the runtime boundary in `@propr/core`: the transition
 * builder refuses `completed` without a capability, so an unguarded completion cannot be written
 * even if this analysis misses it.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Every first-party source tree, not one directory. */
export const ANALYZED_ROOTS = ['src', 'packages/api', 'packages/cli/src', 'packages/core/src', 'packages/shared/src'];
/** Never first-party sources: dependencies, build output, and the tests doing the checking. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'test', '__tests__', 'coverage']);
const AGENT_INTERFACE_FILE = 'packages/core/src/agents/types.ts';
const MODEL_RESULT_TYPES = ['AgentExecutionResult', 'AnalysisResult'];
const COMPLETED_STATE_LITERAL = 'completed';
const BARRIER_CALL = 'publishCompletedWithDurableExecutionEvidence';
const NON_EXECUTING_GUARD = 'nonExecutingCompletionGuard';
const EXECUTION_GUARD = 'durableExecutionCompletionGuard';
const TRANSITION_CLAIM = 'claimTerminalTransition';
/**
 * The one way a publisher may certify an execution it did not itself run: it hands the caller's
 * transition identity to the barrier, which reads the durable completed row for exactly that
 * identity and mints the capability only if the row is there. It cannot assert a completion, only
 * relay one — which is what the finalizer was doing wrongly when it stamped a NON-EXECUTING
 * capability on an executing job's outcome.
 */
const EVIDENCE_CERTIFICATION = 'certifyDurableCompletion';
/**
 * Taking the durable, mutually exclusive RIGHT to run one paid execution.
 *
 * This is the only call that excludes a second execution. The transition claim and the barrier
 * below it deduplicate a settled operation's RECORD after the fact, which is a different and
 * strictly later guarantee: by the time either speaks, the provider has run and charged.
 */
const EXECUTION_LEASE_ACQUISITION = 'acquireExecutionLease';
/**
 * Callees that write a task state. Anything naming `TaskState` is a transition API — the state
 * manager's `updateTaskState*`, the CAS helpers and the transition builder alike — so a completed
 * value reaching one publishes a completion, however that value was spelled or laundered.
 */
const STATE_WRITING_CALLEE = /TaskState/;
/** A transition built as an object literal rather than passed to a call. */
const STATE_PROPERTY = /^(state|newState|targetState)$/;
/** A method whose very name is "publish a completion", whatever it is handed. */
const COMPLETION_CALLEE = /^mark(Task)?Completed$/;
/** Query filters and on-disk markers also spell `state: 'completed'`; a transition names the enum. */
const DATA_QUERY_CALLEE = /^(where|andWhere|orWhere|whereIn|first|select|filter|find)$/;
/** How far above a property assignment to look for the query call it belongs to. */
const QUERY_ARGUMENT_DEPTH = 4;

export interface SourceFacts {
    /** Repository-relative path. */
    path: string;
    publishesCompleted: boolean;
    /** How the completion was spelled, for a failure message that can be acted on. */
    completionSites: string[];
    usesBarrier: boolean;
    /** Publishes an executed completion itself: claims a durable identity and mints its capability. */
    mintsExecutionCapability: boolean;
    claimsTerminalTransition: boolean;
    /** Takes the execution lease: the operation cannot be executed twice, not merely recorded once. */
    acquiresExecutionLease: boolean;
    /** Publishes only what the durable history proves, under an identity someone else claimed. */
    certifiesDurableCompletion: boolean;
    nonExecutingReasons: string[];
    invokesModelExecution: boolean;
    modelExecutionCalls: string[];
    /**
     * Call-graph edges: repository-relative paths of the modules whose imported bindings this
     * file actually INVOKES. Plain import edges are too coarse — a module that merely imports a
     * neighbour has not called it — so reachability follows invocations only.
     */
    imports: string[];
}

async function sourcePaths(root: string): Promise<string[]> {
    const absolute = path.join(REPOSITORY_ROOT, root);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
        const relative = `${root}/${entry.name}`;
        if (entry.isDirectory()) {
            if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
            files.push(...await sourcePaths(relative));
        }
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) files.push(relative);
    }
    return files;
}

function calleeName(node: ts.CallExpression): string {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
        return expression.argumentExpression.text;
    }
    return '';
}

/** The model-execution method names, read from the `Agent` interface rather than hard-coded. */
export async function modelExecutionMethodNames(): Promise<string[]> {
    const source = await readFile(path.join(REPOSITORY_ROOT, AGENT_INTERFACE_FILE), 'utf8');
    const file = ts.createSourceFile(AGENT_INTERFACE_FILE, source, ts.ScriptTarget.ES2022, true);
    const names: string[] = [];
    for (const statement of file.statements) {
        if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'Agent') continue;
        for (const member of statement.members) {
            if (!ts.isMethodSignature(member) || !member.type || !member.name) continue;
            const returnType = member.type.getText(file);
            if (MODEL_RESULT_TYPES.some(candidate => returnType.includes(candidate))) names.push(member.name.getText(file));
        }
    }
    return names.sort();
}

function collectCompletedAliases(file: ts.SourceFile): Set<string> {
    const aliases = new Set<string>();
    // Two passes so an alias of an alias resolves regardless of declaration order. A variable
    // counts when the completed state appears ANYWHERE in its initializer, because
    // `const next = aborted ? CANCELLED : done ? COMPLETED : FAILED` is exactly how a completion
    // gets laundered through a variable and out of a text sweep's sight.
    for (let pass = 0; pass < 2; pass++) {
        const visit = (node: ts.Node): void => {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
                && argumentCarriesCompleted(node.initializer, aliases)) {
                aliases.add(node.name.text);
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }
    return aliases;
}

function argumentCarriesCompleted(node: ts.Node, aliases: Set<string>): boolean {
    let found = false;
    const visit = (current: ts.Node): void => {
        if (found) return;
        if (ts.isStringLiteralLike(current) && current.text === COMPLETED_STATE_LITERAL) found = true;
        else if (ts.isPropertyAccessExpression(current) && current.name.text === 'COMPLETED') found = true;
        else if (ts.isIdentifier(current) && aliases.has(current.text)) found = true;
        if (!found) ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
}

/** `const REASON = '...'` declarations, so a guard reason stated once is still readable here. */
function collectStringConstants(file: ts.SourceFile): Map<string, string> {
    const constants = new Map<string, string>();
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
            && node.initializer && ts.isStringLiteralLike(node.initializer)) {
            constants.set(node.name.text, node.initializer.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return constants;
}

function resolveStringArgument(node: ts.Expression | undefined, constants: Map<string, string>): string {
    if (node && ts.isStringLiteralLike(node)) return node.text;
    if (node && ts.isIdentifier(node) && constants.has(node.text)) return constants.get(node.text) as string;
    return '[non-literal reason]';
}

/**
 * Whether this node sits inside the argument of a query call.
 *
 * `where({ state: TaskStates.COMPLETED })` names the enum — the read-back of a completed row has
 * every reason to — but it selects rows; it transitions nothing. Judging it a completion would
 * make the rule unreadable exactly where completions are being verified.
 */
function withinDataQuery(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    for (let depth = 0; current && depth < QUERY_ARGUMENT_DEPTH; depth++, current = current.parent) {
        if (ts.isCallExpression(current)) return DATA_QUERY_CALLEE.test(calleeName(current));
    }
    return false;
}

function analyzeSource(relativePath: string, source: string, modelMethods: Set<string>): SourceFacts {
    const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.ES2022, true);
    const aliases = collectCompletedAliases(file);
    const stringConstants = collectStringConstants(file);
    const importedFrom = new Map<string, string>();
    const invoked = new Set<string>();
    const facts: SourceFacts = {
        path: relativePath, publishesCompleted: false, completionSites: [], usesBarrier: false,
        mintsExecutionCapability: false, claimsTerminalTransition: false, acquiresExecutionLease: false,
        certifiesDurableCompletion: false,
        nonExecutingReasons: [], invokesModelExecution: false, modelExecutionCalls: [], imports: [],
    };

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && node.moduleSpecifier
            && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith('.')
            && node.importClause && !node.importClause.isTypeOnly) {
            const specifier = node.moduleSpecifier.text.replace(/\.js$/, '.ts');
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier));
            const bindings = node.importClause.namedBindings;
            if (node.importClause.name) importedFrom.set(node.importClause.name.text, target);
            if (bindings && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) {
                    if (!element.isTypeOnly) importedFrom.set(element.name.text, target);
                }
            }
            if (bindings && ts.isNamespaceImport(bindings)) importedFrom.set(bindings.name.text, target);
        }
        if (ts.isCallExpression(node)) {
            const name = calleeName(node);
            if (ts.isIdentifier(node.expression)) invoked.add(node.expression.text);
            if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) {
                invoked.add(node.expression.expression.text);
            }
            if (name === BARRIER_CALL) facts.usesBarrier = true;
            if (name === EXECUTION_GUARD) facts.mintsExecutionCapability = true;
            if (name === TRANSITION_CLAIM) facts.claimsTerminalTransition = true;
            if (name === EXECUTION_LEASE_ACQUISITION) facts.acquiresExecutionLease = true;
            if (name === EVIDENCE_CERTIFICATION) facts.certifiesDurableCompletion = true;
            if (name === NON_EXECUTING_GUARD) {
                const reason = node.arguments[0];
                facts.nonExecutingReasons.push(resolveStringArgument(reason, stringConstants));
            }
            if (modelMethods.has(name)) {
                facts.invokesModelExecution = true;
                facts.modelExecutionCalls.push(name);
            }
            if (name !== BARRIER_CALL && !DATA_QUERY_CALLEE.test(name)
                && (COMPLETION_CALLEE.test(name)
                    || (STATE_WRITING_CALLEE.test(name)
                        && node.arguments.some(argument => argumentCarriesCompleted(argument, aliases))))) {
                facts.publishesCompleted = true;
                const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
                facts.completionSites.push(`${name}() at ${relativePath}:${line}`);
            }
        }
        // A transition described as data rather than passed as an argument: `{ state: COMPLETED }`.
        // Only the enum (or an alias of it) counts here: a bare `state: 'completed'` string is how
        // query filters and on-disk markers are written, and neither transitions a task.
        if (ts.isPropertyAssignment(node) && STATE_PROPERTY.test(node.name.getText(file))
            && !ts.isStringLiteralLike(node.initializer)
            && !withinDataQuery(node)
            && argumentCarriesCompleted(node.initializer, aliases)) {
            facts.publishesCompleted = true;
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
            facts.completionSites.push(`${node.name.getText(file)}: completed at ${relativePath}:${line}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    for (const [binding, target] of importedFrom) {
        if (invoked.has(binding)) facts.imports.push(target);
    }
    facts.imports = [...new Set(facts.imports)];
    return facts;
}

/** Analyses one source in isolation, so the rule itself can be tested against fixtures. */
export function analyzeSourceText(relativePath: string, source: string, modelMethods: string[]): SourceFacts {
    return analyzeSource(relativePath, source, new Set(modelMethods));
}

export async function analyzeCompletionBoundary(): Promise<Map<string, SourceFacts>> {
    const modelMethods = new Set(await modelExecutionMethodNames());
    const paths = (await Promise.all(ANALYZED_ROOTS.map(sourcePaths))).flat();
    const analyzed = await Promise.all(paths.map(async relativePath => analyzeSource(
        relativePath, await readFile(path.join(REPOSITORY_ROOT, relativePath), 'utf8'), modelMethods)));
    const facts = new Map(analyzed.map(entry => [entry.path, entry]));
    // Keep only imports that resolve to a first-party source we actually analysed.
    for (const entry of facts.values()) entry.imports = entry.imports.filter(target => facts.has(target));
    return facts;
}

/** Whether this file can reach a model execution through its own code or its relative imports. */
/** Whether this publisher discharges the durability requirement itself, rather than via the barrier. */
export function publishesUnderClaimedIdentity(entry: SourceFacts): boolean {
    return entry.mintsExecutionCapability && entry.claimsTerminalTransition;
}

/**
 * Whether this publisher only RELAYS a completion, certified against the durable history under
 * an identity claimed elsewhere.
 *
 * This is the category the module-granular analysis previously had no name for, and so could not
 * police: a publisher that runs no model execution but certifies one another path ran. Calling
 * itself non-executing was true and beside the point, because what it was publishing was an
 * executing job's outcome.
 */
export function publishesCertifiedEvidence(entry: SourceFacts): boolean {
    return entry.certifiesDurableCompletion && !entry.mintsExecutionCapability;
}

/** Every analysed module this one can reach through the modules it actually INVOKES, itself included. */
export function invocationClosure(start: string, facts: Map<string, SourceFacts>): string[] {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const next of facts.get(current)?.imports ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    return [...seen];
}

/**
 * The modules from which a paid provider execution can START.
 *
 * A path that reaches a model execution but is itself invoked by another analysed module is a
 * step on someone else's path, not an entry to one; listing those would bury the handful of
 * places where the decision to spend money is actually made. Roots are derived from the
 * invocation graph, never enumerated by hand.
 */
export function paidExecutionEntryPoints(facts: Map<string, SourceFacts>): string[] {
    const invoked = new Set<string>();
    for (const entry of facts.values()) for (const target of entry.imports) invoked.add(target);
    return [...facts.keys()]
        .filter(path => reachesModelExecution(path, facts).length > 0 && !invoked.has(path))
        .sort();
}

/** How a paid path is protected against running the SAME logical operation's provider call twice. */
export type PaidExecutionProtection = 'execution exclusion' | 'post-execution deduplication' | 'neither';

export function paidExecutionProtection(start: string, facts: Map<string, SourceFacts>): PaidExecutionProtection {
    const closure = invocationClosure(start, facts).map(path => facts.get(path) as SourceFacts);
    if (closure.some(entry => entry.acquiresExecutionLease)) return 'execution exclusion';
    if (closure.some(entry => entry.claimsTerminalTransition || entry.usesBarrier)) return 'post-execution deduplication';
    return 'neither';
}

export function reachesModelExecution(start: string, facts: Map<string, SourceFacts>): string[] {
    const seen = new Set<string>([start]);
    const queue = [start];
    const reached: string[] = [];
    while (queue.length > 0) {
        const current = queue.shift() as string;
        const entry = facts.get(current);
        if (!entry) continue;
        if (entry.invokesModelExecution) reached.push(`${current} (${[...new Set(entry.modelExecutionCalls)].sort().join(', ')})`);
        for (const next of entry.imports) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
        }
    }
    return reached.sort();
}

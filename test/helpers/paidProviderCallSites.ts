/**
 * WHERE MONEY CAN BE SPENT, ONE CALL SITE AT A TIME.
 *
 * The previous ledger asked a coarser question and got a wrong answer: it labelled a whole MODULE
 * ROOT "execution-excluded" when ANY module in its import closure called `acquireExecutionLease`.
 * `agentRoutes.ts` therefore read as protected, although only its native-analysis branch takes a
 * lease — its two ordinary chat branches call `routingSession.analyze` and `agent.analyze`
 * directly, with nothing between them and the provider. A ledger that reports an unprotected path
 * as protected is worse than no ledger, because the number it produces is confidence about where
 * real money is at risk.
 *
 * So this analysis is built around the only unit that can actually be charged: ONE PROVIDER CALL
 * SITE. For each one it asks whether taking the durable right to run DOMINATES that call — whether
 * every path that reaches it has already passed through `acquireExecutionLease`.
 *
 * WHAT MAKES IT DEFENSIBLE.
 *
 * - SYMBOLS, NOT NAMES. The provider call sites are resolved with the TypeScript type checker:
 *   a call counts only when its callee symbol declares a method of the `Agent` interface itself.
 *   `.analyze` is an extremely common method name — the routing session has one, so do several
 *   helpers — and matching on the name alone both invents sinks and hides them behind a wrapper.
 *   The lease acquisition is resolved the same way, to its declaration in `executionLease.ts`, so
 *   a local variable that merely borrows the name cannot launder a protection claim.
 * - DOMINANCE, NOT PRESENCE. An acquisition inside an `if`, a `try`, a loop or a `switch` protects
 *   only the code inside that branch. It does NOT protect what follows, because the branch may not
 *   have been taken. Only an acquisition in the straight-line body of the enclosing function
 *   dominates the statements after it.
 * - CLOSURES ARE UNLEASED UNLESS A VERIFIED WRAPPER RUNS THEM. Argument position proves nothing:
 *   `setTimeout(() => agent.analyze(...), 0)` is an argument too, and so is every `.then`,
 *   every event registration and every helper that stores a callback for later. Only the wrappers
 *   in `SYNCHRONOUS_CALLBACK_WRAPPERS` — each read and each recorded with the parameter position
 *   it actually invokes — pass the state at the call into the callback. Everything else starts
 *   unleased, because a deferred paid call certified as protected is the failure this ledger
 *   exists to make impossible.
 * - AN EXPORTED FUNCTION IS ALWAYS ENTERED UNLEASED. A helper called only from leased positions is
 *   credited with that through the call graph, but only if nothing outside the analysed sources
 *   could call it. Anything exported could, so it is not credited.
 * - EVERY UNPROVEN CASE IS UNPROTECTED. There is no third verdict. A call site this analysis
 *   cannot show to be dominated is reported as exposure, which is the direction an audit about
 *   money has to fail in.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The declaration file of the interface whose methods ARE the paid provider surface. */
const AGENT_INTERFACE_FILE = 'agents/types.ts';
const AGENT_INTERFACE = 'Agent';
/**
 * Paid execution primitives that are NOT methods of `Agent`.
 *
 * The previous ledger counted one interface's methods and called the result the paid-provider
 * SINK count. It was the Agent-SURFACE count. `runLightweightLLMAnalysis` falls back to
 * `executeClaudeAnalysis` whenever the requested model has no agent alias, and that path calls
 * `executeClaudeCode`, which builds the Docker arguments and spawns the Claude Code CLI itself —
 * the same billable run, reached without touching `Agent` at all and with no execution lease
 * anywhere in front of it. A ledger built around one interface cannot see it, so the sinks are
 * enumerated as EXECUTION PRIMITIVES and this one is named here explicitly.
 *
 * `rawProviderSpawnSites` is what keeps this list honest: it enumerates every raw container spawn
 * in the sources and classifies each one, so a future primitive added outside this list fails the
 * audit instead of quietly becoming the next invisible bypass.
 */
const STANDALONE_PROVIDER_PRIMITIVES: readonly { module: string; name: string }[] = [
    { module: 'claude/claudeService.ts', name: 'executeClaudeCode' },
];
/**
 * Wrappers whose callback argument really does run inside the call, verified one at a time.
 *
 * A function expression passed as an argument was previously assumed to run synchronously, and
 * JavaScript guarantees nothing of the kind: `setTimeout`, `queueMicrotask`, `Promise.prototype
 * .then`, event registration and any ordinary helper that merely stores a callback all run it
 * later, possibly long after the lease is gone. Inheriting the leased state into those would
 * certify a deferred paid call as protected, which is the one direction an audit about money may
 * not fail in. So argument callbacks are UNLEASED by default, and inheritance is granted only
 * here, only to a symbol resolved to its declaration, and only at the parameter position that is
 * actually invoked — the same function passed anywhere else in the same call is not covered.
 *
 * - `runWithPlannerAbortContext(draftId, runId, operation)` is `plannerAbortContext.run({…},
 *   operation)`. `AsyncLocalStorage.prototype.run` invokes its callback synchronously, within the
 *   call, and returns its result; the wrapper returns that promise, so the caller's `await` is an
 *   await of the callback itself.
 * - `runWithExecutionAbortSignal(signal, operation, attemptGeneration)` is the same shape over
 *   `executionOwnershipContext.run({…}, operation)`.
 */
const SYNCHRONOUS_CALLBACK_WRAPPERS: readonly { module: string; name: string; parameterIndex: number }[] = [
    { module: 'docker/dockerAbortController.ts', name: 'runWithPlannerAbortContext', parameterIndex: 2 },
    { module: 'docker/dockerExecutionOwnership.ts', name: 'runWithExecutionAbortSignal', parameterIndex: 1 },
];
/** The raw container spawn every paid execution primitive in this repository ultimately goes through. */
const RAW_SPAWN_MODULE = 'docker/dockerExecutor.ts';
const RAW_SPAWN = 'executeDockerCommand';
/** The billing wrapper a model run is measured by, and which a management command never uses. */
const USAGE_TRACKING_MODULE = 'usageTrackingWrapper.ts';
const USAGE_TRACKING = 'executeWithUsageTracking';
/** The declaration file of the only call that takes the durable right to run. */
const LEASE_MODULE = 'executionLease.ts';
const LEASE_ACQUISITION = 'acquireExecutionLease';
/**
 * What makes an `Agent` method a PAID one: it returns a model result.
 *
 * `healthCheck()` is on the same interface and reaches the same container, but it returns a
 * boolean — it verifies an image exists, it does not run a model and is not billed. Counting it
 * would pad this ledger with sites that cost nothing, and a ledger padded with non-findings is
 * read less carefully than one where every line is real money.
 */
const MODEL_RESULT_TYPES = ['AgentExecutionResult', 'AnalysisResult'];
/** A fixpoint over a call graph this small settles in a handful of rounds; the cap is a guard. */
const MAX_PROPAGATION_ROUNDS = 12;

/** How a call site earned its verdict, in the words the ledger is read in. */
export type ProtectionBasis =
    | 'lease acquisition dominates this call in its own function'
    | 'every call into this function is itself dominated by a lease acquisition'
    | 'no lease acquisition dominates this call';

export interface ProviderCallSite {
    /** Repository-relative path. */
    path: string;
    line: number;
    /** The provider method being invoked, as declared on `Agent`. */
    method: string;
    /** The source text of the callee, so a finding can be found. */
    callee: string;
    /** The enclosing analysed function, or `<module>` for module-level code. */
    enclosing: string;
    protectedByLease: boolean;
    basis: ProtectionBasis;
}

interface Unit {
    id: string;
    declaration: ts.Node;
    body: ts.Node;
    /** Reachable from outside the analysed sources, so it may be entered without a lease. */
    externallyReachable: boolean;
    entryLeased: boolean;
    incoming: { fromUnitId: string; leased: boolean }[];
}

function isExported(declaration: ts.Node): boolean {
    let current: ts.Node | undefined = declaration;
    while (current) {
        const modifiers = ts.canHaveModifiers(current) ? ts.getModifiers(current) : undefined;
        if (modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
        if (ts.isSourceFile(current)) return false;
        current = current.parent;
    }
    return false;
}

function unitName(declaration: ts.Node): string | undefined {
    if (ts.isFunctionDeclaration(declaration)) return declaration.name?.text;
    if (ts.isMethodDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        const owner = ts.isClassDeclaration(declaration.parent) ? declaration.parent.name?.text : undefined;
        return `${owner ?? 'anonymous'}.${declaration.name.text}`;
    }
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) return declaration.name.text;
    return undefined;
}

function unitBody(declaration: ts.Node): ts.Node | undefined {
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration.body;
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        return declaration.initializer.body;
    }
    return undefined;
}

/**
 * The analysis proper.
 *
 * Kept independent of how the program was built, so the same rule that judges the repository can
 * be pointed at a fixture whose leased and unleased branches are known by construction.
 */
export function analyzeProviderCallSites(program: ts.Program, rootDirectory: string): ProviderCallSite[] {
    const checker = program.getTypeChecker();
    const sources = program.getSourceFiles().filter(file =>
        !file.isDeclarationFile && !file.fileName.includes('node_modules'));
    const relative = (file: ts.SourceFile) => path.relative(rootDirectory, file.fileName) || file.fileName;

    let agentInterface: ts.InterfaceDeclaration | undefined;
    for (const file of sources) {
        if (!file.fileName.endsWith(AGENT_INTERFACE_FILE)) continue;
        for (const statement of file.statements) {
            if (ts.isInterfaceDeclaration(statement) && statement.name.text === AGENT_INTERFACE) agentInterface = statement;
        }
    }
    if (!agentInterface) throw new Error('the Agent interface could not be found, so no provider call site can be judged');

    const declaredSymbol = (node: ts.Node): ts.Symbol | undefined => {
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol) return undefined;
        return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    };
    const calleeNode = (call: ts.CallExpression): ts.Node | undefined => {
        if (ts.isIdentifier(call.expression)) return call.expression;
        if (ts.isPropertyAccessExpression(call.expression)) return call.expression.name;
        return undefined;
    };
    /**
     * A call that reaches a PAID EXECUTION PRIMITIVE: a method declared on `Agent` that returns a
     * model result, or one of the standalone primitives that bypass `Agent` entirely.
     */
    const providerMethod = (call: ts.CallExpression): string | undefined => {
        const node = calleeNode(call);
        if (!node) return undefined;
        for (const declaration of declaredSymbol(node)?.getDeclarations() ?? []) {
            if (declaration.parent === agentInterface && ts.isMethodSignature(declaration)) {
                const returns = declaration.type?.getText(declaration.getSourceFile()) ?? '';
                if (!MODEL_RESULT_TYPES.some(candidate => returns.includes(candidate))) continue;
                return declaration.name.getText(declaration.getSourceFile());
            }
            const file = declaration.getSourceFile().fileName;
            const primitive = STANDALONE_PROVIDER_PRIMITIVES.find(candidate =>
                file.endsWith(candidate.module) && unitName(declaration) === candidate.name);
            if (primitive) return primitive.name;
        }
        return undefined;
    };
    /**
     * Whether this function expression is the callback an ALLOWLISTED wrapper invokes and awaits
     * within its own call — the only case in which a callback inherits the state at that call.
     */
    const inheritsLeasedState = (functionExpression: ts.Node): boolean => {
        const call = functionExpression.parent;
        if (!ts.isCallExpression(call)) return false;
        const node = calleeNode(call);
        if (!node) return false;
        for (const declaration of declaredSymbol(node)?.getDeclarations() ?? []) {
            const file = declaration.getSourceFile().fileName;
            const wrapper = SYNCHRONOUS_CALLBACK_WRAPPERS.find(candidate =>
                file.endsWith(candidate.module) && unitName(declaration) === candidate.name);
            if (wrapper && call.arguments[wrapper.parameterIndex] === functionExpression) return true;
        }
        return false;
    };
    const takesLease = (call: ts.CallExpression): boolean => {
        const node = calleeNode(call);
        if (!node || node.getText(node.getSourceFile()) !== LEASE_ACQUISITION) return false;
        return (declaredSymbol(node)?.getDeclarations() ?? []).some(declaration =>
            declaration.getSourceFile().fileName.endsWith(LEASE_MODULE));
    };

    // ------------------------------------------------------------ the analysed function units
    const units = new Map<string, Unit>();
    const unitByDeclaration = new Map<ts.Node, Unit>();
    for (const file of sources) {
        const key = relative(file);
        const register = (declaration: ts.Node) => {
            const body = unitBody(declaration);
            const name = unitName(declaration);
            if (!body || !name) return;
            const unit: Unit = {
                id: `${key}#${name}`, declaration, body,
                externallyReachable: isExported(declaration), entryLeased: false, incoming: [],
            };
            units.set(unit.id, unit);
            unitByDeclaration.set(declaration, unit);
        };
        for (const statement of file.statements) {
            if (ts.isFunctionDeclaration(statement)) register(statement);
            else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) register(declaration);
            else if (ts.isClassDeclaration(statement)) for (const member of statement.members) if (ts.isMethodDeclaration(member)) register(member);
        }
    }

    // A unit referenced as a VALUE — handed to something rather than called — can be invoked from
    // anywhere later, so it is entered unleased however carefully its call sites are guarded.
    for (const file of sources) {
        const bindingSite = (node: ts.Node): boolean => ts.isImportSpecifier(node) || ts.isImportClause(node)
            || ts.isNamespaceImport(node) || ts.isExportSpecifier(node);
        const visit = (node: ts.Node): void => {
            // An import binding is not a use; its uses are visited where they occur. Counting the
            // binding itself would mark every imported helper externally reachable and silently
            // delete the call-graph credit this pass exists to compute.
            if (ts.isIdentifier(node) && !bindingSite(node.parent)
                && !(ts.isCallExpression(node.parent) && node.parent.expression === node)
                && !(ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)
                    && node.parent.parent.expression === node.parent)) {
                for (const declaration of declaredSymbol(node)?.getDeclarations() ?? []) {
                    const unit = unitByDeclaration.get(declaration);
                    if (unit && declaration !== node.parent) unit.externallyReachable = true;
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(file);
    }

    // ------------------------------------------------------------------------ the walk itself
    interface Round { sites: ProviderCallSite[]; edges: { from: string; to: string; leased: boolean }[] }

    const walkUnitBodies = (): Round => {
        const sites: ProviderCallSite[] = [];
        const edges: { from: string; to: string; leased: boolean }[] = [];

        const record = (call: ts.CallExpression, method: string, leased: boolean, enclosing: Unit | undefined,
            localDominance: boolean) => {
            const file = call.getSourceFile();
            sites.push({
                path: relative(file),
                line: file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1,
                method,
                callee: call.expression.getText(file),
                enclosing: enclosing ? enclosing.id.split('#')[1] : '<module>',
                protectedByLease: leased,
                basis: !leased ? 'no lease acquisition dominates this call'
                    : localDominance ? 'lease acquisition dominates this call in its own function'
                        : 'every call into this function is itself dominated by a lease acquisition',
            });
        };

        /** One function's straight-line walk. `leased` is the state at each point, in order. */
        const walk = (unit: Unit | undefined, body: ts.Node, entryLeased: boolean): void => {
            // Whether a lease was taken in THIS function's straight-line body, as opposed to being
            // inherited from every caller. It only changes how the finding reads, not the verdict.
            let localDominanceReached = false;

            const walkExpression = (node: ts.Node, leased: boolean): boolean => {
                if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
                    // DEFERRED UNLESS PROVEN OTHERWISE. Being an argument says only that the
                    // callee received the function, never that it ran it before returning.
                    walkNested(node.body, inheritsLeasedState(node) && leased);
                    return leased;
                }
                if (ts.isConditionalExpression(node)) {
                    walkExpression(node.condition, leased);
                    walkExpression(node.whenTrue, leased);
                    walkExpression(node.whenFalse, leased);
                    return leased;
                }
                if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
                    || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
                    || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
                    walkExpression(node.left, leased);
                    walkExpression(node.right, leased);
                    return leased;
                }
                if (ts.isCallExpression(node)) {
                    // Operands are evaluated before the call takes effect, so they see the state
                    // as it stands, and only afterwards can this call have granted a lease.
                    let current = walkExpression(node.expression, leased);
                    for (const argument of node.arguments) current = walkExpression(argument, current);
                    const method = providerMethod(node);
                    if (method) record(node, method, current, unit, localDominanceReached);
                    const target = calleeNode(node);
                    for (const declaration of (target ? declaredSymbol(target)?.getDeclarations() ?? [] : [])) {
                        const called = unitByDeclaration.get(declaration);
                        if (called && unit) edges.push({ from: unit.id, to: called.id, leased: current });
                        else if (called) edges.push({ from: `${relative(node.getSourceFile())}#<module>`, to: called.id, leased: current });
                    }
                    if (takesLease(node)) {
                        if (!leased) localDominanceReached = true;
                        return true;
                    }
                    return current;
                }
                let current = leased;
                ts.forEachChild(node, child => { current = walkExpression(child, current); });
                return current;
            };

            const walkStatements = (statements: readonly ts.Statement[], leased: boolean): boolean => {
                let current = leased;
                for (const statement of statements) current = walkStatement(statement, current);
                return current;
            };

            const walkStatement = (statement: ts.Statement, leased: boolean): boolean => {
                // A registered unit nested here is analysed in its own right, under its own rules.
                if (unitByDeclaration.has(statement)) return leased;
                if (ts.isBlock(statement)) return walkStatements(statement.statements, leased);
                // BRANCHES DO NOT DOMINATE. An acquisition inside one arm protects that arm and
                // nothing after the statement, because the arm may not have been taken. That is
                // the whole difference between this ledger and the one it replaces.
                if (ts.isIfStatement(statement)) {
                    const inner = walkExpression(statement.expression, leased);
                    walkStatement(statement.thenStatement, inner);
                    if (statement.elseStatement) walkStatement(statement.elseStatement, inner);
                    return inner;
                }
                if (ts.isTryStatement(statement)) {
                    walkStatements(statement.tryBlock.statements, leased);
                    if (statement.catchClause) walkStatements(statement.catchClause.block.statements, leased);
                    if (statement.finallyBlock) walkStatements(statement.finallyBlock.statements, leased);
                    return leased;
                }
                if (ts.isSwitchStatement(statement)) {
                    const inner = walkExpression(statement.expression, leased);
                    for (const clause of statement.caseBlock.clauses) walkStatements(clause.statements, inner);
                    return inner;
                }
                if (ts.isForStatement(statement) || ts.isForOfStatement(statement) || ts.isForInStatement(statement)
                    || ts.isWhileStatement(statement) || ts.isDoStatement(statement)) {
                    ts.forEachChild(statement, child => { walkExpression(child, leased); });
                    return leased;
                }
                if (ts.isLabeledStatement(statement)) return walkStatement(statement.statement, leased);
                let current = leased;
                ts.forEachChild(statement, child => { current = walkExpression(child, current); });
                return current;
            };

            const walkNested = (node: ts.Node, leased: boolean): void => {
                if (ts.isBlock(node)) walkStatements(node.statements, leased);
                else walkExpression(node, leased);
            };

            walkNested(body, entryLeased);
        };

        for (const unit of units.values()) walk(unit, unit.body, unit.entryLeased);
        // Module-level code: anything outside a registered unit. It is always entered unleased.
        for (const file of sources) {
            for (const statement of file.statements) {
                if (unitByDeclaration.has(statement)) continue;
                if (ts.isVariableStatement(statement)
                    && statement.declarationList.declarations.every(declaration => unitByDeclaration.has(declaration))) continue;
                if (ts.isClassDeclaration(statement)) {
                    for (const member of statement.members) if (!unitByDeclaration.has(member)) walk(undefined, member, false);
                    continue;
                }
                walk(undefined, statement, false);
            }
        }
        return { sites, edges };
    };

    // A helper that is only ever called from leased positions is protected too, but only if
    // nothing outside these sources could call it first. The credit is propagated upwards until it
    // stops changing, starting from "nothing is credited" so the fixpoint can only ever add.
    let round = walkUnitBodies();
    for (let iteration = 0; iteration < MAX_PROPAGATION_ROUNDS; iteration++) {
        for (const unit of units.values()) unit.incoming = [];
        for (const edge of round.edges) units.get(edge.to)?.incoming.push({ fromUnitId: edge.from, leased: edge.leased });
        let changed = false;
        for (const unit of units.values()) {
            const credited = !unit.externallyReachable && unit.incoming.length > 0
                && unit.incoming.every(edge => edge.leased);
            if (credited !== unit.entryLeased) { unit.entryLeased = credited; changed = true; }
        }
        if (!changed) break;
        round = walkUnitBodies();
    }

    return round.sites.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

/**
 * ONE RAW CONTAINER SPAWN, AND WHETHER IT RUNS A MODEL.
 *
 * The call-site ledger above answers "is this sink protected"; this answers the question that has
 * to be settled BEFORE that one — "is the list of sinks complete". Every paid run in this
 * repository, whichever primitive starts it, ends at `executeDockerCommand`, so enumerating that
 * one symbol's call sites bounds the whole surface: a new bypass cannot avoid appearing here.
 *
 * A model run is told apart from a management command by `executeWithUsageTracking`, the billing
 * wrapper the token accounting is collected through. Every spawn that runs a model is inside one;
 * `docker images`, `image inspect`, `pull`, `rmi`, a Dockerfile build and a `chown` are not.
 */
export interface RawProviderSpawnSite {
    path: string;
    line: number;
    enclosing: string;
    /** Inside the billing wrapper, i.e. a spawn that runs a model and is charged for it. */
    modelRun: boolean;
}

/**
 * Every raw container spawn in the analysed sources, classified.
 *
 * Deliberately exhaustive rather than filtered: a frozen list of ALL of them is what makes a new
 * one fail the audit, whether or not this analysis would have called it a model run.
 */
export function analyzeRawProviderSpawns(program: ts.Program, rootDirectory: string): RawProviderSpawnSite[] {
    const checker = program.getTypeChecker();
    const sources = program.getSourceFiles().filter(file =>
        !file.isDeclarationFile && !file.fileName.includes('node_modules'));
    const declaredSymbol = (node: ts.Node): ts.Symbol | undefined => {
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol) return undefined;
        return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    };
    const resolvesTo = (call: ts.CallExpression, module: string, name: string): boolean => {
        const node = ts.isIdentifier(call.expression) ? call.expression
            : ts.isPropertyAccessExpression(call.expression) ? call.expression.name : undefined;
        if (!node || node.getText(node.getSourceFile()) !== name) return false;
        return (declaredSymbol(node)?.getDeclarations() ?? [])
            .some(declaration => declaration.getSourceFile().fileName.endsWith(module));
    };
    const enclosingName = (node: ts.Node): string => {
        // Only a declaration that IS a function counts: `const result = await spawn(...)` is a
        // variable declaration too, and reporting the call as enclosed by `result` names nothing.
        for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
            const named = unitName(current);
            if (named && unitBody(current)) return named;
        }
        return '<module>';
    };
    const sites: RawProviderSpawnSite[] = [];
    for (const file of sources) {
        // The declaring module is not a call site of its own surface, and a test that drives the
        // spawn directly is not production money.
        if (file.fileName.endsWith(RAW_SPAWN_MODULE)) continue;
        const relativePath = path.relative(rootDirectory, file.fileName) || file.fileName;
        if (relativePath.startsWith('test/') || relativePath.includes('/test/')) continue;
        let billed = 0;
        const visit = (node: ts.Node): void => {
            const isUsageTracking = ts.isCallExpression(node) && resolvesTo(node, USAGE_TRACKING_MODULE, USAGE_TRACKING);
            if (isUsageTracking) billed += 1;
            if (ts.isCallExpression(node) && resolvesTo(node, RAW_SPAWN_MODULE, RAW_SPAWN)) {
                sites.push({
                    path: relativePath,
                    line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
                    enclosing: enclosingName(node),
                    modelRun: billed > 0,
                });
            }
            ts.forEachChild(node, visit);
            if (isUsageTracking) billed -= 1;
        };
        visit(file);
    }
    return sites.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

/**
 * Every module declaring a class that IMPLEMENTS `Agent`, resolved by symbol.
 *
 * This is what makes the containment claim checkable rather than asserted: a raw model-running
 * spawn is accounted for only if it lives in a module that implements the enumerated provider
 * surface, or in one of the standalone primitives named above. Anything else is a paid path the
 * ledger does not cover, and the audit fails on it.
 */
export function agentImplementationModules(program: ts.Program, rootDirectory: string): string[] {
    const checker = program.getTypeChecker();
    const found = new Set<string>();
    for (const file of program.getSourceFiles()) {
        if (file.isDeclarationFile || file.fileName.includes('node_modules')) continue;
        for (const statement of file.statements) {
            if (!ts.isClassDeclaration(statement)) continue;
            for (const heritage of statement.heritageClauses ?? []) {
                if (heritage.token !== ts.SyntaxKind.ImplementsKeyword) continue;
                for (const type of heritage.types) {
                    const symbol = checker.getSymbolAtLocation(type.expression);
                    const resolved = symbol && symbol.flags & ts.SymbolFlags.Alias
                        ? checker.getAliasedSymbol(symbol) : symbol;
                    const implementsAgent = (resolved?.getDeclarations() ?? []).some(declaration =>
                        ts.isInterfaceDeclaration(declaration) && declaration.name.text === AGENT_INTERFACE
                        && declaration.getSourceFile().fileName.endsWith(AGENT_INTERFACE_FILE));
                    if (implementsAgent) found.add(path.relative(rootDirectory, file.fileName) || file.fileName);
                }
            }
        }
    }
    return [...found].sort();
}

/** The program the repository's own ledgers are derived from. Built once; it is not cheap. */
let repositoryProgramCache: ts.Program | undefined;
function repositoryProgram(): ts.Program {
    if (repositoryProgramCache) return repositoryProgramCache;
    const configPath = path.join(REPOSITORY_ROOT, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) throw new Error('the repository tsconfig could not be read, so nothing may be claimed about it');
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, REPOSITORY_ROOT);
    repositoryProgramCache = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    return repositoryProgramCache;
}

/** The repository's own ledger, built from the real `tsconfig.json` program. */
export function repositoryProviderCallSites(): ProviderCallSite[] {
    return analyzeProviderCallSites(repositoryProgram(), REPOSITORY_ROOT);
}

/** The repository's own raw-spawn inventory, from the same program. */
export function repositoryRawProviderSpawns(): RawProviderSpawnSite[] {
    return analyzeRawProviderSpawns(repositoryProgram(), REPOSITORY_ROOT);
}

/** The repository's `Agent` implementations, from the same program. */
export function repositoryAgentImplementationModules(): string[] {
    return agentImplementationModules(repositoryProgram(), REPOSITORY_ROOT);
}

/** The modules the enumerated standalone primitives are declared in. */
export const standaloneProviderPrimitiveModules: readonly string[] =
    STANDALONE_PROVIDER_PRIMITIVES.map(primitive => primitive.module);

const FIXTURE_ROOT = '/fixture';

/**
 * The same rule, applied to sources written for the occasion.
 *
 * A rule about dominance has to be shown discriminating between two branches of ONE function, and
 * the repository does not contain a convenient pair. These fixtures do, by construction.
 */
export function fixtureProviderCallSites(files: Record<string, string>): ProviderCallSite[] {
    const all: Record<string, string> = {
        'agents/types.ts': `
            export interface AnalysisResult { success: boolean }
            export interface Agent { analyze(prompt: string): Promise<AnalysisResult>; }
        `,
        'executionLease.ts': `
            export async function acquireExecutionLease(request: { leaseKey: string }): Promise<{ outcome: string }> {
                return { outcome: request.leaseKey };
            }
        `,
        // The standalone paid primitive, so a fixture can exercise a sink that bypasses `Agent`.
        'claude/claudeService.ts': `
            export async function executeClaudeCode(options: { prompt: string }): Promise<{ success: boolean }> {
                return { success: options.prompt.length > 0 };
            }
        `,
        // The two allowlisted synchronous wrappers, under the module names the allowlist resolves.
        'claude/docker/dockerAbortController.ts': `
            export function runWithPlannerAbortContext<T>(draftId: string, runId: string, operation: () => Promise<T>): Promise<T> {
                return operation();
            }
        `,
        'claude/docker/dockerExecutionOwnership.ts': `
            export function runWithExecutionAbortSignal<T>(signal: unknown, operation: () => Promise<T>, generation?: string): Promise<T> {
                return operation();
            }
        `,
        ...files,
    };
    const sources = new Map(Object.entries(all).map(([name, text]) => [
        path.posix.join(FIXTURE_ROOT, name),
        ts.createSourceFile(path.posix.join(FIXTURE_ROOT, name), text, ts.ScriptTarget.ES2022, true),
    ]));
    const host = ts.createCompilerHost({ target: ts.ScriptTarget.ES2022 });
    const readFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
        sources.get(fileName) ?? readFile(fileName, languageVersion, onError, shouldCreate);
    host.fileExists = fileName => sources.has(fileName) || ts.sys.fileExists(fileName);
    host.readFile = fileName => sources.get(fileName)?.text ?? ts.sys.readFile(fileName);
    // Module resolution walks directories and canonicalises paths before it ever reads a file, so
    // a host that only answers `fileExists` resolves nothing and every fixture silently analyses
    // as "no provider calls here" — a green test that checks nothing.
    const directories = new Set([...sources.keys()].map(fileName => path.posix.dirname(fileName)));
    for (const directory of [...directories]) {
        for (let current = directory; current !== '/' && current !== '.'; current = path.posix.dirname(current)) {
            directories.add(current);
        }
    }
    host.directoryExists = directory => directories.has(directory) || ts.sys.directoryExists(directory);
    host.realpath = fileName => fileName;
    const program = ts.createProgram([...sources.keys()], {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
        allowImportingTsExtensions: true, skipLibCheck: true,
    }, host);
    return analyzeProviderCallSites(program, FIXTURE_ROOT);
}

/** Every paid provider call site nothing excludes from running twice. */
export function unprotectedProviderCallSites(sites: ProviderCallSite[]): ProviderCallSite[] {
    return sites.filter(site => !site.protectedByLease);
}

/**
 * THE LEDGER OF PAID PROVIDER CALL SITES, AND WHAT STANDS IN FRONT OF EACH ONE.
 *
 * Two guarantees are routinely mistaken for one another, and the difference is money:
 *
 * - EXECUTION EXCLUSION stops a second provider invocation. Only the durable execution lease does
 *   this: the right to run is taken in one atomic statement before the provider is reachable.
 * - POST-EXECUTION DEDUPLICATION stops a second RECORD of an operation that already ran. The
 *   terminal transition identity and the durability barrier do this, and they are strictly later:
 *   when they speak, the provider has already run and already charged.
 *
 * THE LEDGER THIS REPLACES WAS WRONG, WHICH IS WHY IT IS A CALL-SITE LEDGER NOW. It classified
 * whole MODULE ROOTS, and called a root protected when anything in its coarse import closure took
 * a lease. `agentRoutes.ts` was reported as excluding a second execution; in fact only its
 * native-analysis branch leases anything, and its two ordinary chat branches hand a prompt
 * straight to the provider. A ledger that reports an unprotected path as protected is worse than
 * no ledger at all — it produces confidence about exactly the place money is being lost.
 *
 * So the unit here is ONE CALL SITE: a call whose callee symbol, resolved by the TYPE CHECKER, is
 * a PAID EXECUTION PRIMITIVE. Each is protected only if taking the lease DOMINATES it — on every
 * control-flow path into it, not merely somewhere in the same file. Anything unproven is reported
 * as exposure.
 *
 * AND THE LIST OF PRIMITIVES ITSELF WAS SHORT BY ONE. It enumerated the methods of `Agent`, which
 * is an Agent-SURFACE count, not a paid-SINK count: `runLightweightLLMAnalysis` falls back to
 * `executeClaudeCode` whenever the model has no agent alias, and that spawns the Claude Code CLI
 * directly, with no lease and no `Agent` anywhere in the path. So the primitives are enumerated
 * explicitly, and the enumeration is GUARDED — every raw container spawn in the sources is listed
 * and classified below, and every one that runs a model must live in a module that implements
 * `Agent` or in a named standalone primitive. A future bypass therefore fails this audit instead
 * of being invisible to it.
 *
 * THE RULING THIS LEDGER SERVES: before paid work runs on any non-native path, that path needs
 * durable operation-keyed execution exclusion plus atomic terminal settlement, or genuine provider
 * idempotency. Every UNPROTECTED line below is a path that ruling blocks.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    fixtureProcessCreationSites,
    fixtureProviderCallSites,
    providerProcessBoundaryModule,
    repositoryAgentImplementationModules,
    repositoryProcessCreationSites,
    repositoryProviderCallSites,
    standaloneProviderPrimitiveModules,
    unprotectedProviderCallSites,
} from './helpers/paidProviderCallSites.js';

const sites = repositoryProviderCallSites();
const ledger = sites.map(site =>
    `${site.protectedByLease ? 'PROTECTED' : 'UNPROTECTED'} ${site.path}:${site.line} ${site.callee}() in ${site.enclosing}`);

describe('every paid provider call site is classified individually', () => {
    test('the ledger is derived from the sources, call site by call site', () => {
        assert.deepEqual(ledger, [
            'UNPROTECTED packages/api/routes/agentRoutes.ts:230 agent.analyze() in executeChatQuery',
            // The one call site the lease stands in front of: `acquireExecutionLease` is a
            // straight-line statement of `nativeAnalysis`, above the try block, so no path
            // reaches the provider without having passed through it.
            'PROTECTED packages/api/routes/nativeAnalysis.ts:354 agent.analyze() in nativeAnalysis',
            'UNPROTECTED packages/core/src/claude/claudeLightweightAnalysis.ts:115 agent.analyze() in tryExecuteWithAgent',
            // The sink the Agent-only ledger could not see. `runLightweightLLMAnalysis` falls
            // back here whenever the model has no agent alias, and this call spawns the Claude
            // Code CLI itself. It is a paid execution primitive, it bypasses `Agent` entirely,
            // and nothing leases anything in front of it.
            'UNPROTECTED packages/core/src/claude/claudeLightweightAnalysis.ts:144 executeClaudeCode() in executeClaudeAnalysis',
            'UNPROTECTED packages/core/src/services/relevance/keywordExtractor.ts:270 agent.analyze() in extractKeywordsWithLLM',
            'UNPROTECTED packages/core/src/services/relevance/semanticScorer.ts:209 agent.analyze() in scoreSemanticRelevance',
            'UNPROTECTED packages/core/src/services/relevance/summaryMinerBatch.ts:398 agent.analyze() in analyzeBatchWithAgent',
            'UNPROTECTED packages/core/src/services/relevance/summaryMinerDirectoryBatch.ts:401 agent.analyze() in analyzeDirectoryBatchWithAgent',
            // The routing session is the indirection a name-matching sweep mistakes for a provider
            // call of its own. These two are the real ones behind every routed chat query.
            'UNPROTECTED packages/core/src/services/syntheticRoutingService.ts:148 selection.physicalAgent.analyze() in SyntheticRoutingSession.analyze',
            'UNPROTECTED packages/core/src/services/syntheticRoutingService.ts:173 selection.physicalAgent.executeTask() in SyntheticRoutingSession.executeTask',
            'UNPROTECTED src/jobs/issueJob/agent.ts:195 agent.executeTask() in executeAgentAndRecordMetrics',
            'UNPROTECTED src/jobs/mergeConflictAgentRunner.ts:153 agent.executeTask() in handleMergeWithAgent',
            'UNPROTECTED src/jobs/prCommentAgentUtils.ts:116 agent.analyze() in runWorktreeFreeTitleAnalysis',
            'UNPROTECTED src/jobs/prCommentAgentUtils.ts:317 agent.executeTask() in resolveAndExecuteAgent',
            'UNPROTECTED src/jobs/processTaskImportJob.ts:148 agent.executeTask() in processTaskImportJob',
            'UNPROTECTED src/jobs/prReviewRunner.ts:107 agent.analyze() in runSingleReview',
            'UNPROTECTED src/jobs/reviewContextScout.ts:229 options.agent.analyze() in gatherReviewContext',
        ], 'a new paid call site, or a change in what protects one, fails here');
    });

    test('exactly one paid call site is excluded from running twice, and it says on what basis', () => {
        const protectedSites = sites.filter(site => site.protectedByLease);
        assert.deepEqual(protectedSites.map(site => `${site.path}:${site.line} — ${site.basis}`), [
            'packages/api/routes/nativeAnalysis.ts:354 — lease acquisition dominates this call in its own function',
        ]);
        assert.equal(unprotectedProviderCallSites(sites).length, sites.length - 1,
            'every other paid call site can be reached without the right to run being taken');
    });

    test('the non-native agentRoutes chat branches are unprotected, and stay that way until leased', () => {
        // The regression this ledger exists for. `executeChatQuery` chooses between three
        // branches; only the native one takes a lease, by way of `nativeAnalysis`. The module
        // granularity that preceded this reported the whole route as excluding a second run.
        const chat = sites.filter(site => site.path === 'packages/api/routes/agentRoutes.ts');
        assert.equal(chat.length, 1, 'the direct provider call in the ordinary chat branch');
        assert.equal(chat[0].protectedByLease, false);
        assert.equal(chat[0].enclosing, 'executeChatQuery');
        // The routed branch of the same function is not a call site of its own — it is a call INTO
        // the routing session, whose provider calls are listed separately and are equally exposed.
        const routed = sites.filter(site => site.path === 'packages/core/src/services/syntheticRoutingService.ts');
        assert.equal(routed.length, 2);
        assert.ok(routed.every(site => !site.protectedByLease),
            'the routed chat branch reaches the provider with nothing excluding a second run');
    });
});

describe('the rule distinguishes a leased call from an unleased one in the same module', () => {
    test('one branch of one function takes the lease and the other does not', () => {
        const found = fixtureProviderCallSites({
            'route.ts': `
                import { acquireExecutionLease } from './executionLease.js';
                import type { Agent } from './agents/types.js';
                export async function route(agent: Agent, native: boolean, prompt: string) {
                    if (native) {
                        await acquireExecutionLease({ leaseKey: prompt });
                        return agent.analyze(prompt);
                    }
                    return agent.analyze(prompt);
                }
            `,
        });
        assert.deepEqual(found.map(site => ({ line: site.line, protectedByLease: site.protectedByLease })), [
            { line: 7, protectedByLease: true },
            { line: 9, protectedByLease: false },
        ], 'the lease protects the branch that takes it, and only that branch');
    });

    test('a lease taken inside a branch does not dominate what follows the branch', () => {
        const found = fixtureProviderCallSites({
            'later.ts': `
                import { acquireExecutionLease } from './executionLease.js';
                import type { Agent } from './agents/types.js';
                export async function later(agent: Agent, maybe: boolean, prompt: string) {
                    if (maybe) await acquireExecutionLease({ leaseKey: prompt });
                    return agent.analyze(prompt);
                }
            `,
        });
        assert.deepEqual(found.map(site => site.protectedByLease), [false],
            'the branch may not have been taken, so nothing after it is dominated');
    });

    test('a lease taken in the straight-line body dominates a call inside a later try block', () => {
        const found = fixtureProviderCallSites({
            'guarded.ts': `
                import { acquireExecutionLease } from './executionLease.js';
                import type { Agent } from './agents/types.js';
                export async function guarded(agent: Agent, prompt: string) {
                    await acquireExecutionLease({ leaseKey: prompt });
                    try { return await agent.analyze(prompt); }
                    finally { /* released elsewhere */ }
                }
            `,
        });
        assert.deepEqual(found.map(site => site.protectedByLease), [true]);
    });

    test('a method merely NAMED analyze is not a provider call site', () => {
        const found = fixtureProviderCallSites({
            'lookalike.ts': `
                class Session { async analyze(prompt: string) { return prompt; } }
                export async function run(session: Session, prompt: string) { return session.analyze(prompt); }
            `,
        });
        assert.deepEqual(found, [], 'the sink is the Agent method symbol, never the spelling');
    });

    test('a local function that borrows the lease name protects nothing', () => {
        const found = fixtureProviderCallSites({
            'borrowed.ts': `
                import type { Agent } from './agents/types.js';
                async function acquireExecutionLease(request: { leaseKey: string }) { return request; }
                export async function run(agent: Agent, prompt: string) {
                    await acquireExecutionLease({ leaseKey: prompt });
                    return agent.analyze(prompt);
                }
            `,
        });
        assert.deepEqual(found.map(site => site.protectedByLease), [false],
            'protection is a symbol from the lease module, not a name anyone may declare');
    });

    test('a module-private helper called only from a leased position is credited, an exported one is not', () => {
        const found = fixtureProviderCallSites({
            'helpers.ts': `
                import { acquireExecutionLease } from './executionLease.js';
                import type { Agent } from './agents/types.js';
                async function priv(agent: Agent, prompt: string) { return agent.analyze(prompt); }
                export async function shared(agent: Agent, prompt: string) { return agent.analyze(prompt); }
                export async function caller(agent: Agent, prompt: string) {
                    await acquireExecutionLease({ leaseKey: prompt });
                    await priv(agent, prompt);
                    await shared(agent, prompt);
                }
            `,
        });
        assert.deepEqual(found.map(site => ({ enclosing: site.enclosing, protectedByLease: site.protectedByLease })), [
            { enclosing: 'priv', protectedByLease: true },
            { enclosing: 'shared', protectedByLease: false },
        ], 'an exported helper can be entered from outside these sources, so it is never credited');
    });
});

/**
 * IS THE LIST OF SINKS COMPLETE — AND WHAT DOES "COMPLETE" MEAN HERE.
 *
 * The previous gate in this position advertised fail-closed containment and did not deliver it.
 * It recognised only calls whose callee symbol resolved directly to `executeDockerCommand`, and it
 * skipped that symbol's own declaring module, so three ways of starting a paid process left the
 * frozen list completely unchanged: an alias binding, a direct `child_process` creation, and a new
 * primitive added inside `dockerExecutor.ts`. No current path used any of them — which is exactly
 * why the gate could stay green while proving less than it claimed.
 *
 * WHAT IS PROVEN NOW, IN THE EXACT FORMS IT IS PROVEN FOR. The claim is not "every process
 * creation": it is every process creation WRITTEN IN ONE OF THE FORMS BELOW, in the production
 * sources of the repository's own `tsconfig.json` program, inventoried and frozen. The primitives
 * are `executeDockerCommand` and Node's process-creation APIs (`spawn`, `spawnSync`, `exec`,
 * `execSync`, `execFile`, `execFileSync`, `fork`), and the forms are:
 *
 * - a named import of one, or a destructuring of one out of a `require` or a dynamic `import`;
 * - any local `const` alias chain ending at one, because `const run = executeDockerCommand`
 *   produces a symbol a name test and a declaring-file test both miss;
 * - a property of the `child_process` MODULE NAMESPACE, whether the namespace is a typed
 *   `import * as cp`, an untyped `const cp = require('node:child_process')` — through any number
 *   of `const` hops — or the module load read inline as `require('child_process').spawn(…)`;
 * - the same property written with brackets and a STRING LITERAL name, `cp['spawn']`.
 *
 * Value references count, not only direct calls, so `promisify(execFile)` is inventoried where it
 * is written. No module is skipped, including the executor's own. Nothing in any of those forms
 * can be added without this list changing, and the hostile fixtures below show each one being
 * caught rather than merely not occurring.
 *
 * WHAT IS NOT PROVEN. A property name that is not a literal (`cp[whichever]`), a namespace handed
 * through a parameter or stored on an object and reached from there, a process created by `eval`
 * or a native addon, a paid call made over HTTP to a provider API rather than by spawning, and a
 * dependency spawning on this repository's behalf are all outside it. It says nothing about
 * `packages/cli` or `propr-ui`, which the program excludes. Read it as "a process creation written
 * in one of the forms above cannot enter these sources unnoticed", never as "no paid work can
 * happen by any other means".
 */
describe('every process creation written in a recognised form is inventoried and classified', () => {
    // Freezing ALL of them — not only the ones this analysis calls billable — is what makes a new
    // paid path fail here: it cannot be added without changing this list.
    test('the process-creation inventory is the one on file', () => {
        assert.deepEqual(repositoryProcessCreationSites().map(site =>
            `${site.modelRun ? 'MODEL RUN' : 'management'} ${site.primitive} ${site.path}:${site.line} in ${site.enclosing}`), [
            'management child_process.execFile packages/api/routes/agentRoutes.ts:24 in <module>',
            'management child_process.execFileSync packages/api/routes/dockerCommandSafety.ts:18 in getDockerContainerLogs',
            'management child_process.execFileSync packages/api/routes/dockerCommandSafety.ts:27 in getDockerContainerStatus',
            'management executeDockerCommand packages/api/routes/plannerHelpers/operationGuard.ts:140 in hasRunningPlannerContainer',
            'management child_process.execFile packages/api/services/agentLoginSessionManager.ts:100 in defaultRunDocker',
            'management child_process.spawn packages/api/services/agentLoginSessionManager.ts:116 in defaultSpawnDocker',
            'management executeDockerCommand packages/core/src/agents/AgentRegistry.ts:127 in AgentRegistry.refreshRegistry',
            'management executeDockerCommand packages/core/src/agents/AgentRegistry.ts:382 in AgentRegistry.registeredAgentImagesAvailable',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/AntigravityAgent.ts:115 in AntigravityAgent.executeTask',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/AntigravityAgent.ts:278 in AntigravityAgent.analyze',
            'management executeDockerCommand packages/core/src/agents/impl/AntigravityAgent.ts:321 in AntigravityAgent.healthCheck',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/ClaudeAgent.ts:128 in ClaudeAgent.executeTask',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/ClaudeAgent.ts:219 in ClaudeAgent.analyze',
            'management executeDockerCommand packages/core/src/agents/impl/ClaudeAgent.ts:307 in ClaudeAgent.healthCheck',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/CodexAgent.ts:73 in CodexAgent.executeTask',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/CodexAgent.ts:234 in CodexAgent.analyze',
            'management child_process.execSync packages/core/src/agents/impl/CodexAgent.ts:277 in CodexAgent.ensureAnalysisWorkspace',
            'management child_process.execSync packages/core/src/agents/impl/CodexAgent.ts:278 in CodexAgent.ensureAnalysisWorkspace',
            'management child_process.execSync packages/core/src/agents/impl/CodexAgent.ts:279 in CodexAgent.ensureAnalysisWorkspace',
            'management child_process.execSync packages/core/src/agents/impl/CodexAgent.ts:281 in CodexAgent.ensureAnalysisWorkspace',
            'management executeDockerCommand packages/core/src/agents/impl/CodexAgent.ts:367 in CodexAgent.healthCheck',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/OpenCodeAgent.ts:80 in OpenCodeAgent.executeTask',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/OpenCodeAgent.ts:159 in OpenCodeAgent.analyze',
            'management executeDockerCommand packages/core/src/agents/impl/OpenCodeAgent.ts:189 in OpenCodeAgent.healthCheck',
            'management child_process.execSync packages/core/src/agents/impl/OpenCodeAgent.ts:285 in OpenCodeAgent.ensureAnalysisWorkspace',
            'management child_process.execSync packages/core/src/agents/impl/OpenCodeAgent.ts:286 in OpenCodeAgent.ensureAnalysisWorkspace',
            'management child_process.execSync packages/core/src/agents/impl/OpenCodeAgent.ts:287 in OpenCodeAgent.ensureAnalysisWorkspace',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/VibeAgent.ts:100 in VibeAgent.executeTask',
            'MODEL RUN executeDockerCommand packages/core/src/agents/impl/VibeAgent.ts:227 in VibeAgent.analyze',
            'management executeDockerCommand packages/core/src/agents/impl/VibeAgent.ts:308 in VibeAgent.healthCheck',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackageCatalog.ts:88 in loadCatalog',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackageCatalog.ts:134 in validatePinnedPackage',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackageCatalog.ts:155 in validatePinnedPackageBatch',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackages.ts:162 in inspectAgentRuntimeBaseImage',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackages.ts:176 in inspectAgentRuntimeBaseImage',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackages.ts:240 in imageExists',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackages.ts:257 in buildRuntimeImage',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackages.ts:279 in cleanupRuntimeImages',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackages.ts:293 in cleanupRuntimeImages',
            'management executeDockerCommand packages/core/src/agents/runtime/agentRuntimePackageVerification.ts:419 in verifyAgentRuntimePackageProfile',
            'management executeDockerCommand packages/core/src/claude/claudeHelpers.ts:91 in setWorktreeOwnership',
            'MODEL RUN executeDockerCommand packages/core/src/claude/claudeService.ts:110 in executeClaudeCode',
            'management child_process.execFile packages/core/src/claude/docker/dockerContainerControl.ts:47 in runDocker',
            'management executeDockerCommand packages/core/src/claude/docker/dockerExecutor.ts:112 in findTaskContainer',
            'management executeDockerCommand packages/core/src/claude/docker/dockerExecutor.ts:154 in inspectLegacyDockerContainerLivenessForTask',
            'management child_process.spawn packages/core/src/claude/docker/dockerExecutor.ts:181 in spawnCommandProcess',
            'management child_process.execFileSync packages/core/src/claude/docker/dockerExecutor.ts:416 in detectContainerId',
            'management executeDockerCommand packages/core/src/claude/docker/dockerImageBuilder.ts:53 in agentDockerImageExists',
            'management executeDockerCommand packages/core/src/claude/docker/dockerImageBuilder.ts:58 in pullImage',
            'management executeDockerCommand packages/core/src/claude/docker/dockerImageBuilder.ts:73 in buildBundle',
            'management executeDockerCommand packages/core/src/claude/docker/dockerImageManager.ts:13 in listAgentImages',
            'management executeDockerCommand packages/core/src/claude/docker/dockerImageManager.ts:69 in cleanupUnusedAgentImages',
            'management child_process.execFile packages/core/src/git/executionCheckpointRetention.ts:20 in <module>',
            'management child_process.execFileSync packages/core/src/git/worktreeOperations.ts:297 in setupWorktreePermissions',
            'management child_process.execFileSync scripts/reconcile-npm-artifact.mjs:30 in lookupPublishedIntegrity',
            'management child_process.execFileSync scripts/reconcile-npm-artifact.mjs:76 in main',
            'management child_process.spawn scripts/run-test-suite.mjs:138 in runTestProcess',
            'management child_process.execFile src/jobs/issueJob/agent.ts:3 in <module>',
            'management child_process.execFileSync src/jobs/mergeConflictAgentRunner.ts:76 in verifyNoConflictMarkers',
            'management child_process.execFileSync src/jobs/processPullRequestCommentJob.ts:310 in executeProcessing',
            'management child_process.execFileSync src/jobs/processPullRequestCommentJob.ts:394 in executeProcessing',
            'management child_process.execFileSync src/jobs/processPullRequestCommentJob.ts:395 in executeProcessing',
            'management child_process.execFile src/jobs/prTaskTitleDiffHelpers.ts:182 in getConflictDiffForTitle',
            'management executeDockerCommand src/taskStateReconciler.ts:181 in inspectLegacyTaskContainerLiveness',
        ], 'a process creation was added, moved or reclassified; say which primitive it belongs to');
    });

    test('no model-running process creation lives outside the enumerated provider primitives', () => {
        // `dockerExecutor.ts` is accounted for by name rather than by implementing `Agent`: it is
        // the shared bottom of BOTH a model execution and a `docker images`, and so it is the one
        // place a process creation is expected to live without belonging to a single provider.
        const accounted = new Set([...repositoryAgentImplementationModules(), ...standaloneProviderPrimitiveModules,
            providerProcessBoundaryModule]);
        const strays = repositoryProcessCreationSites()
            .filter(site => site.modelRun)
            .filter(site => ![...accounted].some(module => site.path.endsWith(module)));
        assert.deepEqual(strays, [],
            'a paid provider path exists outside the surface this ledger enumerates');
    });

    test('the Agent implementations the containment argument rests on are the ones on file', () => {
        assert.deepEqual(repositoryAgentImplementationModules(), [
            'packages/core/src/agents/impl/AntigravityAgent.ts',
            'packages/core/src/agents/impl/ClaudeAgent.ts',
            'packages/core/src/agents/impl/CodexAgent.ts',
            'packages/core/src/agents/impl/OpenCodeAgent.ts',
            'packages/core/src/agents/impl/VibeAgent.ts',
            'packages/core/src/agents/SyntheticAgent.ts',
        ].sort(), 'an Agent implementation was added or removed; its spawns need classifying');
    });

    test('a primitive that bypasses `Agent` is still a paid call site', () => {
        const found = fixtureProviderCallSites({
            'bypass.ts': `
                import { executeClaudeCode } from './claude/claudeService.js';
                export async function bypass(prompt: string) { return executeClaudeCode({ prompt }); }
            `,
        });
        assert.deepEqual(found.map(site => ({ method: site.method, protectedByLease: site.protectedByLease })),
            [{ method: 'executeClaudeCode', protectedByLease: false }],
            'the sink is the execution primitive, whichever interface it is or is not behind');
    });
});

/**
 * THE BYPASSES THE GATE LET THROUGH, WRITTEN OUT AND CAUGHT.
 *
 * Each fixture is a paid run that an earlier inventory recorded nothing about: the frozen list
 * would not have changed, and the containment test would have found no stray. Here each one is
 * inventoried, classified as a model run because it sits inside the billing wrapper, and lands in
 * a module that is not an enumerated provider primitive — which is what a stray is.
 *
 * The three at the top are the ones the ORIGINAL gate missed — an alias binding, a direct
 * `child_process` import, a second primitive inside the executor module. The namespace ones below
 * them are the class the replacement still missed: it resolved a process-creation API only through
 * a typed declaration or a binding destructured out of `require`, so `const cp = require('node:
 * child_process'); cp.spawn(…)` and `require('node:child_process').spawn(…)` both produced an
 * EMPTY inventory. Nothing about those is exotic — they are ordinary first-party CommonJS — so
 * "the frozen list cannot be bypassed" was false as written until they were read too.
 */
describe('the containment gate catches a process creation that avoids the wrapper', () => {
    /** The rule the repository-level containment test applies, pointed at fixture sources. */
    const strays = (sites: ReturnType<typeof fixtureProcessCreationSites>) => sites
        .filter(site => site.modelRun)
        .filter(site => !site.path.endsWith(providerProcessBoundaryModule)
            && !standaloneProviderPrimitiveModules.some(module => site.path.endsWith(module)));

    test('an alias binding of the executor is inventoried under the primitive it names', () => {
        const found = fixtureProcessCreationSites({
            'alias.ts': `
                import { executeDockerCommand } from './claude/docker/dockerExecutor.js';
                import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                const run = executeDockerCommand;
                export async function sneaky(prompt: string) {
                    return executeWithUsageTracking('run', async () => run(['run', prompt]));
                }
            `,
        });
        assert.deepEqual(found.filter(site => site.path === 'alias.ts').map(site =>
            `${site.primitive} ${site.enclosing} modelRun=${site.modelRun}`), [
            'executeDockerCommand <module> modelRun=false',
            'executeDockerCommand sneaky modelRun=true',
        ], 'the callee is spelled `run`, and the alias chase resolves it to the primitive anyway');
        assert.deepEqual(strays(found).map(site => site.path), ['alias.ts'],
            'so the paid run fails containment instead of being invisible to it');
    });

    for (const api of ['spawn', 'exec', 'execFile', 'fork'] as const) {
        test(`a direct child_process.${api} is inventoried, wrapper or no wrapper`, () => {
            const found = fixtureProcessCreationSites({
                'direct.ts': `
                    import { ${api} } from 'node:child_process';
                    import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                    export async function direct(prompt: string) {
                        return executeWithUsageTracking('run', async () => ${api}('docker', ['run', prompt]));
                    }
                `,
            });
            assert.deepEqual(found.filter(site => site.path === 'direct.ts').map(site =>
                `${site.primitive} ${site.enclosing} modelRun=${site.modelRun}`),
            [`child_process.${api} direct modelRun=true`],
            'the repository wrapper was never involved, and the process creation is still on file');
            assert.deepEqual(strays(found).map(site => site.path), ['direct.ts']);
        });
    }

    test('a child_process API destructured out of a dynamic import is inventoried too', () => {
        const found = fixtureProcessCreationSites({
            'dynamic.ts': `
                import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                export async function dynamic(prompt: string) {
                    const { execFileSync } = await import('child_process');
                    return executeWithUsageTracking('run', async () => execFileSync('docker', ['run', prompt]));
                }
            `,
        });
        assert.deepEqual(found.filter(site => site.path === 'dynamic.ts').map(site =>
            `${site.primitive} modelRun=${site.modelRun}`), ['child_process.execFileSync modelRun=true'],
        'a late import is still an import of the process-creation surface');
    });

    test('a namespace CommonJS require of child_process is inventoried', () => {
        // `cp` has no type: `require` is not declared in this program, so the checker resolves
        // `cp.spawn` to nothing at all and every symbol-based test misses it. It is still
        // first-party syntax creating a first-party process, so it is read as what it is.
        const found = fixtureProcessCreationSites({
            'namespaced.ts': `
                import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                const cp = require('node:child_process');
                export async function namespaced(prompt: string) {
                    return executeWithUsageTracking('run', async () => cp.spawn('docker', ['run', prompt]));
                }
            `,
        });
        assert.deepEqual(found.filter(site => site.path === 'namespaced.ts').map(site =>
            `${site.primitive} ${site.enclosing} modelRun=${site.modelRun}`),
        ['child_process.spawn namespaced modelRun=true']);
        assert.deepEqual(strays(found).map(site => site.path), ['namespaced.ts']);
    });

    test('a process creation read straight off the require call is inventoried', () => {
        const found = fixtureProcessCreationSites({
            'inline.ts': `
                import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                export async function inline(prompt: string) {
                    return executeWithUsageTracking('run', async () =>
                        require('child_process').execFile('docker', ['run', prompt]));
                }
            `,
        });
        assert.deepEqual(found.filter(site => site.path === 'inline.ts').map(site =>
            `${site.primitive} ${site.enclosing} modelRun=${site.modelRun}`),
        ['child_process.execFile inline modelRun=true']);
        assert.deepEqual(strays(found).map(site => site.path), ['inline.ts']);
    });

    test('a bracketed literal property off the namespace is inventoried', () => {
        const found = fixtureProcessCreationSites({
            'bracketed.ts': `
                import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                import * as childProcess from 'node:child_process';
                export async function bracketed(prompt: string) {
                    return executeWithUsageTracking('run', async () => childProcess['execSync']('docker ' + prompt));
                }
            `,
        });
        assert.deepEqual(found.filter(site => site.path === 'bracketed.ts').map(site =>
            `${site.primitive} ${site.enclosing} modelRun=${site.modelRun}`),
        ['child_process.execSync bracketed modelRun=true'],
        'brackets and a literal name are the same process creation, written differently');
        assert.deepEqual(strays(found).map(site => site.path), ['bracketed.ts']);
    });

    test('a namespace binding of some other module is not mistaken for one', () => {
        // The companion to the two above: the rule is "this expression names child_process", not
        // "this expression is a namespace", and a rule that flagged any `x.spawn` would pass them
        // both while inventing sinks everywhere else.
        const found = fixtureProcessCreationSites({
            'other.ts': `
                import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                const pool = require('./workerPool.js');
                const later = pool;
                export async function other(prompt: string) {
                    return executeWithUsageTracking('run', async () => later.spawn(prompt));
                }
            `,
        });
        assert.deepEqual(found, [], 'the module the namespace names is what decides it');
    });

    test('a new primitive inside the executor module is inventoried, because that module is not skipped', () => {
        const found = fixtureProcessCreationSites({
            // The fixture supplies the executor module itself, which the previous inventory
            // skipped outright — anything added beside `executeDockerCommand` was invisible.
            'claude/docker/dockerExecutor.ts': `
                import { spawn } from 'node:child_process';
                export async function executeDockerCommand(args: string[]): Promise<{ code: number }> {
                    return { code: args.length };
                }
                export function executeModelDirectly(args: string[]) { return spawn('docker', args); }
            `,
        });
        assert.deepEqual(found.map(site => `${site.primitive} in ${site.enclosing}`),
            ['child_process.spawn in executeModelDirectly'],
            'a second process-creation primitive in the boundary module is on the record');
    });

    test('an ordinary function in the same module is not mistaken for a process creation', () => {
        // The companion to every fixture above: a rule that flagged everything would pass them
        // all and prove nothing.
        const found = fixtureProcessCreationSites({
            'innocent.ts': `
                import { executeWithUsageTracking } from './usageTrackingWrapper.js';
                function spawn(prompt: string) { return prompt.length; }
                export async function innocent(prompt: string) {
                    return executeWithUsageTracking('run', async () => spawn(prompt));
                }
            `,
        });
        assert.deepEqual(found, [], 'the primitive is a resolved symbol, never the spelling');
    });
});

describe('a callback argument is unleased unless a verified wrapper runs it', () => {
    // Each of these passes the provider call to something that receives a function. None of them
    // can be shown to invoke it within the call, and all of them can run it after the lease is
    // gone. Certifying any of them PROTECTED would be the ledger lying about money.
    const deferred: Record<string, string> = {
        'setTimeout': `
            import { acquireExecutionLease } from './executionLease.js';
            import type { Agent } from './agents/types.js';
            export async function run(agent: Agent, prompt: string) {
                await acquireExecutionLease({ leaseKey: prompt });
                setTimeout(() => { void agent.analyze(prompt); }, 0);
            }
        `,
        'a promise continuation': `
            import { acquireExecutionLease } from './executionLease.js';
            import type { Agent } from './agents/types.js';
            export async function run(agent: Agent, prompt: string) {
                await acquireExecutionLease({ leaseKey: prompt });
                void Promise.resolve().then(() => agent.analyze(prompt));
            }
        `,
        'a helper that stores the callback': `
            import { acquireExecutionLease } from './executionLease.js';
            import type { Agent } from './agents/types.js';
            let pending: (() => unknown) | undefined;
            export function later() { return pending?.(); }
            function defer(operation: () => unknown) { pending = operation; }
            export async function run(agent: Agent, prompt: string) {
                await acquireExecutionLease({ leaseKey: prompt });
                defer(() => agent.analyze(prompt));
            }
        `,
    };
    for (const [what, source] of Object.entries(deferred)) {
        test(`${what} does not carry the lease into its callback`, () => {
            const found = fixtureProviderCallSites({ 'deferred.ts': source });
            assert.deepEqual(found.map(site => site.protectedByLease), [false],
                'the callback may run long after the lease is gone, so it is entered unleased');
        });
    }

    test('an allowlisted wrapper does carry it, because it invokes and awaits the callback', () => {
        const found = fixtureProviderCallSites({
            'wrapped.ts': `
                import { acquireExecutionLease } from './executionLease.js';
                import { runWithExecutionAbortSignal } from './claude/docker/dockerExecutionOwnership.js';
                import type { Agent } from './agents/types.js';
                export async function run(agent: Agent, signal: unknown, prompt: string) {
                    await acquireExecutionLease({ leaseKey: prompt });
                    return runWithExecutionAbortSignal(signal, async () => agent.analyze(prompt));
                }
            `,
        });
        assert.deepEqual(found.map(site => site.protectedByLease), [true]);
    });

    test('the same wrapper in the wrong argument position carries nothing', () => {
        // The allowlist names the parameter that is actually invoked. A function handed to the
        // same wrapper anywhere else is just a value it received.
        const found = fixtureProviderCallSites({
            'misplaced.ts': `
                import { acquireExecutionLease } from './executionLease.js';
                import { runWithPlannerAbortContext } from './claude/docker/dockerAbortController.js';
                import type { Agent } from './agents/types.js';
                export async function run(agent: Agent, prompt: string) {
                    await acquireExecutionLease({ leaseKey: prompt });
                    return runWithPlannerAbortContext(prompt, String(() => agent.analyze(prompt)), async () => ({ ok: true }));
                }
            `,
        });
        assert.deepEqual(found.map(site => site.protectedByLease), [false]);
    });
});

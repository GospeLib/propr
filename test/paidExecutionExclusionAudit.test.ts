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
    fixtureProviderCallSites,
    repositoryAgentImplementationModules,
    repositoryProviderCallSites,
    repositoryRawProviderSpawns,
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

describe('the inventory of paid execution primitives is complete, not just the Agent surface', () => {
    // Every paid run in this repository, whichever primitive starts it, ends at one raw container
    // spawn. Freezing ALL of its call sites — not only the ones this analysis calls billable — is
    // what makes a new paid path fail here: it cannot be added without changing this list.
    test('every raw container spawn is listed and classified', () => {
        assert.deepEqual(repositoryRawProviderSpawns().map(site =>
            `${site.modelRun ? 'MODEL RUN' : 'management'} ${site.path}:${site.line} in ${site.enclosing}`), [
            'management packages/core/src/agents/AgentRegistry.ts:127 in AgentRegistry.refreshRegistry',
            'management packages/core/src/agents/AgentRegistry.ts:382 in AgentRegistry.registeredAgentImagesAvailable',
            'MODEL RUN packages/core/src/agents/impl/AntigravityAgent.ts:115 in AntigravityAgent.executeTask',
            'MODEL RUN packages/core/src/agents/impl/AntigravityAgent.ts:278 in AntigravityAgent.analyze',
            'management packages/core/src/agents/impl/AntigravityAgent.ts:321 in AntigravityAgent.healthCheck',
            'MODEL RUN packages/core/src/agents/impl/ClaudeAgent.ts:128 in ClaudeAgent.executeTask',
            'MODEL RUN packages/core/src/agents/impl/ClaudeAgent.ts:219 in ClaudeAgent.analyze',
            'management packages/core/src/agents/impl/ClaudeAgent.ts:307 in ClaudeAgent.healthCheck',
            'MODEL RUN packages/core/src/agents/impl/CodexAgent.ts:73 in CodexAgent.executeTask',
            'MODEL RUN packages/core/src/agents/impl/CodexAgent.ts:234 in CodexAgent.analyze',
            'management packages/core/src/agents/impl/CodexAgent.ts:367 in CodexAgent.healthCheck',
            'MODEL RUN packages/core/src/agents/impl/OpenCodeAgent.ts:80 in OpenCodeAgent.executeTask',
            'MODEL RUN packages/core/src/agents/impl/OpenCodeAgent.ts:159 in OpenCodeAgent.analyze',
            'management packages/core/src/agents/impl/OpenCodeAgent.ts:189 in OpenCodeAgent.healthCheck',
            'MODEL RUN packages/core/src/agents/impl/VibeAgent.ts:100 in VibeAgent.executeTask',
            'MODEL RUN packages/core/src/agents/impl/VibeAgent.ts:227 in VibeAgent.analyze',
            'management packages/core/src/agents/impl/VibeAgent.ts:308 in VibeAgent.healthCheck',
            'management packages/core/src/agents/runtime/agentRuntimePackageCatalog.ts:88 in loadCatalog',
            'management packages/core/src/agents/runtime/agentRuntimePackageCatalog.ts:134 in validatePinnedPackage',
            'management packages/core/src/agents/runtime/agentRuntimePackageCatalog.ts:155 in validatePinnedPackageBatch',
            'management packages/core/src/agents/runtime/agentRuntimePackages.ts:162 in inspectAgentRuntimeBaseImage',
            'management packages/core/src/agents/runtime/agentRuntimePackages.ts:176 in inspectAgentRuntimeBaseImage',
            'management packages/core/src/agents/runtime/agentRuntimePackages.ts:240 in imageExists',
            'management packages/core/src/agents/runtime/agentRuntimePackages.ts:257 in buildRuntimeImage',
            'management packages/core/src/agents/runtime/agentRuntimePackages.ts:279 in cleanupRuntimeImages',
            'management packages/core/src/agents/runtime/agentRuntimePackages.ts:293 in cleanupRuntimeImages',
            'management packages/core/src/claude/claudeHelpers.ts:91 in setWorktreeOwnership',
            // The legacy bypass, at the bottom of it: `executeClaudeCode` builds the Docker
            // arguments and spawns the CLI itself, reached from `executeClaudeAnalysis`.
            'MODEL RUN packages/core/src/claude/claudeService.ts:110 in executeClaudeCode',
            'management packages/core/src/claude/docker/dockerImageBuilder.ts:53 in agentDockerImageExists',
            'management packages/core/src/claude/docker/dockerImageBuilder.ts:58 in pullImage',
            'management packages/core/src/claude/docker/dockerImageBuilder.ts:73 in buildBundle',
            'management packages/core/src/claude/docker/dockerImageManager.ts:13 in listAgentImages',
            'management packages/core/src/claude/docker/dockerImageManager.ts:69 in cleanupUnusedAgentImages',
        ], 'a raw container spawn was added, moved or reclassified; say which primitive it belongs to');
    });

    test('no model-running spawn lives outside the enumerated provider primitives', () => {
        const accounted = new Set([...repositoryAgentImplementationModules(), ...standaloneProviderPrimitiveModules]);
        const strays = repositoryRawProviderSpawns()
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

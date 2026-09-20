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
 * a method of the `Agent` interface that returns a model result. Each is protected only if taking
 * the lease DOMINATES it — on every control-flow path into it, not merely somewhere in the same
 * file. Anything unproven is reported as exposure.
 *
 * THE RULING THIS LEDGER SERVES: before paid work runs on any non-native path, that path needs
 * durable operation-keyed execution exclusion plus atomic terminal settlement, or genuine provider
 * idempotency. Every UNPROTECTED line below is a path that ruling blocks.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    fixtureProviderCallSites,
    repositoryProviderCallSites,
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
            'PROTECTED packages/api/routes/nativeAnalysis.ts:312 agent.analyze() in nativeAnalysis',
            'UNPROTECTED packages/core/src/claude/claudeLightweightAnalysis.ts:115 agent.analyze() in tryExecuteWithAgent',
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
            'packages/api/routes/nativeAnalysis.ts:312 — lease acquisition dominates this call in its own function',
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

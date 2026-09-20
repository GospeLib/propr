/**
 * WHICH PAID PROVIDER PATHS ARE PROTECTED, AND BY WHAT.
 *
 * Two guarantees are routinely mistaken for one another, and the difference is money:
 *
 * - EXECUTION EXCLUSION stops a second provider invocation. Only the durable execution lease does
 *   this: the right to run is taken in one atomic statement before the provider is reachable.
 * - POST-EXECUTION DEDUPLICATION stops a second RECORD of an operation that already ran. The
 *   terminal transition identity and the durability barrier do this, and they are strictly later:
 *   when they speak, the provider has already run and already charged.
 *
 * Only the native-analysis route holds a lease. This ledger is how big the rest of the class is,
 * and it is DERIVED from the sources by the same AST analysis the completion-boundary rule uses —
 * entry points are the roots of the invocation graph that can reach a model-execution method taken
 * from the `Agent` interface, never a hand-kept list. A new paid path, or an existing one that
 * starts or stops holding a lease, changes this derivation and fails here.
 *
 * The analysis follows INVOCATIONS of imported bindings, so a module reached only by
 * instantiation (an agent implementation built by a factory) appears as its own root. That makes
 * the ledger conservative — it names more entry points than a human would — which is the safe
 * direction for a question about unprotected spending.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    analyzeCompletionBoundary,
    paidExecutionEntryPoints,
    paidExecutionProtection,
    reachesModelExecution,
    type SourceFacts,
} from './helpers/completionBoundaryAnalysis.js';

const facts = await analyzeCompletionBoundary();

describe('every path that can invoke a paid provider execution is classified', () => {
    test('the ledger of paid entry points and their protection is derived from the sources', () => {
        const derived = paidExecutionEntryPoints(facts)
            .map(path => ({ path, protection: paidExecutionProtection(path, facts) }));
        assert.deepEqual(derived, [
            { path: 'packages/api/routes/agentRoutes.ts', protection: 'execution exclusion' },
            { path: 'packages/core/src/agents/SyntheticAgent.ts', protection: 'neither' },
            { path: 'packages/core/src/agents/SyntheticAgentRegistry.ts', protection: 'neither' },
            { path: 'packages/core/src/agents/impl/AntigravityAgent.ts', protection: 'neither' },
            { path: 'packages/core/src/agents/impl/ClaudeAgent.ts', protection: 'neither' },
            { path: 'packages/core/src/agents/impl/CodexAgent.ts', protection: 'neither' },
            { path: 'packages/core/src/agents/impl/OpenCodeAgent.ts', protection: 'neither' },
            { path: 'packages/core/src/agents/impl/VibeAgent.ts', protection: 'neither' },
            { path: 'packages/core/src/agents/impl/utils/dockerArgsBuilder.ts', protection: 'neither' },
            { path: 'packages/core/src/claude/claudeLightweightAnalysis.ts', protection: 'neither' },
            { path: 'packages/core/src/config/configManagerUltrafix.ts', protection: 'neither' },
            { path: 'packages/core/src/config/modelLabelResolution.ts', protection: 'neither' },
            { path: 'packages/core/src/daemon/issueDetection.ts', protection: 'neither' },
            { path: 'packages/core/src/services/analysisService.ts', protection: 'neither' },
            { path: 'packages/core/src/services/context/additionalContext.ts', protection: 'neither' },
            { path: 'packages/core/src/services/planning/planningUtils.ts', protection: 'neither' },
            { path: 'packages/core/src/services/planning/previewService.ts', protection: 'neither' },
            { path: 'packages/core/src/services/relevance/summaryMiner.ts', protection: 'neither' },
            { path: 'packages/core/src/services/relevance/summaryMinerDirectories.ts', protection: 'neither' },
            { path: 'packages/core/src/services/syntheticUsageSnapshotProvider.ts', protection: 'neither' },
            { path: 'packages/core/src/services/taskPlanning/llmCalling.ts', protection: 'neither' },
            { path: 'packages/core/src/services/taskPlanning/refinement.ts', protection: 'neither' },
            { path: 'packages/core/src/utils/github/logFiles.ts', protection: 'neither' },
            { path: 'packages/core/src/webhook/commentEventHandler.ts', protection: 'neither' },
            { path: 'packages/core/src/webhook/webhookHandler.ts', protection: 'neither' },
            { path: 'src/jobs/issueJob/worktree.ts', protection: 'post-execution deduplication' },
            { path: 'src/jobs/processMergeConflictJob.ts', protection: 'post-execution deduplication' },
            { path: 'src/jobs/processPullRequestCommentJob.ts', protection: 'post-execution deduplication' },
            { path: 'src/jobs/processTaskImportJob.ts', protection: 'post-execution deduplication' },
        ], 'a new paid execution path, or a change in what protects one, fails here');
    });

    test('exactly one entry point excludes a second execution, and the rest only deduplicate', () => {
        const excluded = paidExecutionEntryPoints(facts)
            .filter(path => paidExecutionProtection(path, facts) === 'execution exclusion');
        assert.deepEqual(excluded, ['packages/api/routes/agentRoutes.ts'],
            'the lease covers the native-analysis route only; every other paid path is still unexcluded');
    });

    test('the queued job paths deduplicate an executed operation without excluding a second run', () => {
        const queued = paidExecutionEntryPoints(facts).filter(path => path.startsWith('src/jobs/'));
        assert.ok(queued.length > 0, 'the queue is a paid path, whatever else changes');
        for (const path of queued) {
            assert.equal(paidExecutionProtection(path, facts), 'post-execution deduplication',
                `${path} records one outcome per operation, and nothing stops it invoking the provider twice`);
        }
    });

    test('the lease is taken before the provider is reachable, on the one path that has it', () => {
        const route = facts.get('packages/api/routes/nativeAnalysis.ts') as SourceFacts;
        assert.ok(route.acquiresExecutionLease, 'the route takes the durable right to run');
        assert.ok(route.invokesModelExecution && reachesModelExecution(route.path, facts).length > 0,
            'and it is the same module that invokes the provider');
    });
});

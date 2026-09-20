/**
 * The two nets under a published `completed`.
 *
 * 1. THE RUNTIME BOUNDARY. `buildTaskStateTransition` — the one function every state transition
 *    passes through, whatever API or spelling reached it — refuses `completed` without a
 *    capability. The capability is minted by the durability barrier (and carries the transition
 *    identity it was claimed for), or explicitly declared by a path that ran no model execution.
 *    There is no longer a keyless `markTaskCompleted` on the state manager to bypass it with.
 *
 * 2. THE REPOSITORY-WIDE RULE. An AST analysis over every first-party source tree, which resolves
 *    aliases and variables, derives the model-execution method names from the `Agent` interface,
 *    and follows invoked imports — so a completion published through a helper, or an execution
 *    run through `analyze` rather than `executeTask`, is seen. The previous regex sweep saw
 *    neither, which is how `prCommentReviewJob` sat in the ledger as "non-executing" while its
 *    imported `runSingleReview` called `agent.analyze`.
 *
 * The ledger is DERIVED here, not hand-maintained: the reason each exempt path gives is read out
 * of its own source, and its claim to run no model execution is re-checked against the call graph.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, mock, test } from 'node:test';
import {
    analyzeCompletionBoundary,
    analyzeSourceText,
    modelExecutionMethodNames,
    reachesModelExecution,
    publishesUnderClaimedIdentity,
    ANALYZED_ROOTS,
    type SourceFacts,
} from './helpers/completionBoundaryAnalysis.js';
import {
    durableExecutionCompletionGuard,
    nonExecutingCompletionGuard,
    assertCompletionGuarded,
    isCompletionGuard,
    UNGUARDED_TASK_COMPLETION,
    COMPLETION_GUARD_IDENTITY_MISMATCH,
} from '../packages/core/src/utils/completionGuard.js';
import { TaskStates } from '../packages/core/src/utils/workerStateManager.types.js';

// The transition builder is pure, but its module opens a database and an event publisher on
// import. Neither is exercised here, so both are stubbed rather than started.
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: () => ({}) } });
await mock.module('../packages/core/src/utils/eventPublisher.js', {
    namedExports: { getEventPublisher: () => ({ publishTaskUpdate: async () => true }) },
});
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
await mock.module('../packages/core/src/utils/logger.js', {
    defaultExport: { ...silent, withCorrelation: () => silent },
    namedExports: { generateCorrelationId: () => 'correlation-boundary' },
});
const { buildTaskStateTransition } = await import('../packages/core/src/utils/workerStateTransition.js');

const BARRIER_MODULE = 'src/jobs/completedExecutionDurability.ts';
const TRANSITION_ID = 'completed:7b1f';

const facts = await analyzeCompletionBoundary();
const publishers = [...facts.values()].filter(entry => entry.publishesCompleted && entry.path !== BARRIER_MODULE);

function taskState() {
    const timestamp = '2026-09-21T00:00:00.000Z';
    return {
        taskId: 'task-boundary', issueRef: { number: 1, repoOwner: 'GospeLib', repoName: 'main' },
        correlationId: 'correlation-boundary', state: TaskStates.POST_PROCESSING,
        createdAt: timestamp, updatedAt: timestamp, version: 1, attempts: 0,
        history: [{ state: TaskStates.POST_PROCESSING, timestamp, reason: 'seed', metadata: {} }],
    } as never;
}

describe('the runtime boundary makes an unguarded completion impossible', () => {
    test('a completed transition without a capability is refused at the one place every transition passes', () => {
        assert.throws(() => buildTaskStateTransition(taskState(), TaskStates.COMPLETED, { reason: 'done' }),
            new RegExp(UNGUARDED_TASK_COMPLETION));
        // The spelling does not matter: the state value is what is checked, not the call site.
        const aliased = TaskStates.COMPLETED;
        assert.throws(() => buildTaskStateTransition(taskState(), aliased, { reason: 'done' }),
            new RegExp(UNGUARDED_TASK_COMPLETION));
    });

    test('a hand-made object cannot forge the capability', () => {
        const forged = { reason: 'durable-execution-evidence', transitionId: TRANSITION_ID } as never;
        assert.equal(isCompletionGuard(forged), false);
        assert.throws(() => buildTaskStateTransition(taskState(), TaskStates.COMPLETED, { completionGuard: forged }),
            new RegExp(UNGUARDED_TASK_COMPLETION));
    });

    test('an execution capability only publishes the transition identity it was claimed for', () => {
        const guard = durableExecutionCompletionGuard(TRANSITION_ID);
        assert.throws(() => assertCompletionGuarded(TaskStates.COMPLETED, { completionGuard: guard, transitionId: 'completed:other' }),
            new RegExp(COMPLETION_GUARD_IDENTITY_MISMATCH));
        assert.throws(() => assertCompletionGuarded(TaskStates.COMPLETED, { completionGuard: guard }),
            new RegExp(COMPLETION_GUARD_IDENTITY_MISMATCH), 'and not a completion published with no key at all');
        assert.doesNotThrow(() => assertCompletionGuarded(TaskStates.COMPLETED, { completionGuard: guard, transitionId: TRANSITION_ID }));
    });

    test('a non-executing completion must state a reason, and never rides an execution key', () => {
        assert.throws(() => nonExecutingCompletionGuard('  '), new RegExp(UNGUARDED_TASK_COMPLETION));
        assert.throws(() => durableExecutionCompletionGuard('  '), new RegExp(UNGUARDED_TASK_COMPLETION));
        const guard = nonExecutingCompletionGuard('the job posts a comment and completes');
        assert.doesNotThrow(() => buildTaskStateTransition(taskState(), TaskStates.COMPLETED, { completionGuard: guard }));
    });

    test('no other terminal state is gated, so a failure or cancellation still settles', () => {
        for (const state of [TaskStates.FAILED, TaskStates.CANCELLED, TaskStates.PROCESSING]) {
            assert.doesNotThrow(() => buildTaskStateTransition(taskState(), state, { reason: 'settled' }));
        }
    });

    test('the keyless completion writer no longer exists on the state manager', async () => {
        const stateManagerSource = await readFile(
            new URL('../packages/core/src/utils/workerStateManager.ts', import.meta.url), 'utf8');
        assert.doesNotMatch(stateManagerSource, /async\s+markTaskCompleted\s*\(/,
            'markTaskCompleted published completed with no evidence and no key; it must not come back');
        const callers = [...facts.values()].filter(entry => /markTaskCompleted/.test(entry.completionSites.join(' ')));
        assert.deepEqual(callers.map(entry => entry.path), [], 'and nothing may call it');
    });
});

describe('the repository-wide rule sees what a regex sweep could not', () => {
    test('it walks every first-party source tree, not one directory', async () => {
        assert.ok(facts.size > 400, `the analysis must actually walk the sources (saw ${facts.size})`);
        for (const root of ANALYZED_ROOTS) {
            assert.ok([...facts.keys()].some(path => path.startsWith(`${root}/`)), `${root} must be analysed`);
        }
        assert.ok(facts.has(BARRIER_MODULE), 'including the barrier itself');
        assert.ok(facts.has('packages/core/src/utils/workerStateManager.ts'),
            'and the state-transition API outside src/, where the previous sweep never looked');
    });

    test('the model-execution methods are derived from the Agent interface, not hard-coded', async () => {
        const methods = await modelExecutionMethodNames();
        assert.deepEqual(methods, ['analyze', 'executeTask'],
            'every method of Agent returning a model result counts as a model execution');
    });

    test('a completion spelled through a variable, an alias or an imported helper is still seen', () => {
        const aliased = analyzeSourceText('fixture/aliased.ts', `
            import { TaskStates } from '@propr/core';
            const DONE = TaskStates.COMPLETED;
            const ALSO_DONE = DONE;
            export async function finish(stateManager: never, taskId: string) {
                await stateManager.updateTaskState(taskId, ALSO_DONE, { reason: 'done' });
            }
        `, ['analyze', 'executeTask']);
        assert.equal(aliased.publishesCompleted, true, 'an alias of an alias is resolved');

        const viaHelper = analyzeSourceText('fixture/viaHelper.ts', `
            import { runSingleReview } from './reviewRunner.js';
            export async function review() { await runSingleReview(); }
        `, ['analyze', 'executeTask']);
        assert.deepEqual(viaHelper.imports, ['fixture/reviewRunner.ts'],
            'an invoked import is a call-graph edge the reachability walk follows');

        const otherApi = analyzeSourceText('fixture/analyze.ts', `
            export async function run(agent: never) { await agent.analyze('prompt', {}); }
        `, ['analyze', 'executeTask']);
        assert.equal(otherApi.invokesModelExecution, true,
            'a model execution run through analyze() counts, not only executeTask()');

        // How the native analysis route spells it: the state is chosen in a conditional and only
        // then written. Nothing at the call site says "completed".
        const laundered = analyzeSourceText('fixture/laundered.ts', `
            import { TaskStates } from '@propr/core';
            export async function settle(state: never, taskId: string, done: boolean, aborted: boolean) {
                const next = aborted ? TaskStates.CANCELLED : done ? TaskStates.COMPLETED : TaskStates.FAILED;
                await state.updateTaskState(taskId, next, {});
            }
        `, ['analyze', 'executeTask']);
        assert.equal(laundered.publishesCompleted, true, 'a state laundered through a conditional is still seen');

        const asData = analyzeSourceText('fixture/asData.ts', `
            import { TaskStates } from '@propr/core';
            export function transition() { return { state: TaskStates.COMPLETED, metadata: {} }; }
        `, ['analyze', 'executeTask']);
        assert.equal(asData.publishesCompleted, true, 'and so is a transition described as data');

        const notATransition = analyzeSourceText('fixture/notATransition.ts', `
            export async function findCompleted(db: never, taskId: string) {
                return db('task_history').where({ task_id: taskId, state: 'completed' }).first();
            }
        `, ['analyze', 'executeTask']);
        assert.equal(notATransition.publishesCompleted, false,
            'while a query filter that merely mentions the state is not a completion');
    });

    test('every completion publisher is guarded, and every executing one uses the barrier', () => {
        for (const entry of publishers) {
            const reached = reachesModelExecution(entry.path, facts);
            const detail = `${entry.path} publishes completed at ${entry.completionSites.join(', ')}`;
            if (reached.length > 0) {
                assert.ok(entry.usesBarrier || publishesUnderClaimedIdentity(entry),
                    `${detail} and reaches a model execution (${reached.join('; ')}), so it must publish through the`
                    + ' barrier, or claim a durable transition identity and mint the execution capability itself');
                continue;
            }
            assert.equal(entry.nonExecutingReasons.length, entry.completionSites.length,
                `${detail} but runs no model execution, so every site must declare nonExecutingCompletionGuard with a reason`);
            for (const reason of entry.nonExecutingReasons) {
                assert.notEqual(reason, '[non-literal reason]', `${detail} must state a readable reason`);
            }
        }
    });

    test('the ledger of non-executing publishers is derived from the sources, never hand-kept', () => {
        const derived = publishers
            .filter(entry => !entry.usesBarrier && !publishesUnderClaimedIdentity(entry))
            .map(entry => ({ path: entry.path, reasons: [...new Set(entry.nonExecutingReasons)], executions: reachesModelExecution(entry.path, facts) }))
            .sort((a, b) => a.path.localeCompare(b.path));
        assert.deepEqual(derived, [
            {
                path: 'src/jobs/prCommentNoAuthorizedFindings.ts',
                reasons: ['no authorized finding was selected, so no agent runs: the job posts a comment and completes'],
                executions: [],
            },
            {
                path: 'src/jobs/prCommentTaskFinalizer.ts',
                reasons: ['reconciles a task from its BullMQ job outcome; it executes nothing itself'],
                executions: [],
            },
        ], 'a new exempt publisher, or one that starts executing, changes this derivation and fails here');
    });

    test('the native analysis route publishes an executed completion under a claimed identity', () => {
        const route = facts.get('packages/api/routes/nativeAnalysis.ts') as SourceFacts;
        assert.ok(route, 'a completion writer outside src/, which the previous sweep never looked at');
        assert.ok(route.publishesCompleted && route.invokesModelExecution,
            'it runs a model execution and publishes completed in the same call');
        assert.ok(publishesUnderClaimedIdentity(route),
            'so it claims a durable transition identity and presents the execution capability');
    });

    test('prCommentReviewJob does run a model execution, and completes through the barrier', () => {
        const review = facts.get('src/jobs/prCommentReviewJob.ts') as SourceFacts;
        assert.ok(review, 'the review job must be analysed');
        const reached = reachesModelExecution(review.path, facts);
        assert.ok(reached.some(entry => entry.startsWith('src/jobs/prReviewRunner.ts')),
            `the review job reaches a model execution through runSingleReview (saw ${JSON.stringify(reached)})`);
        assert.equal(review.publishesCompleted, false,
            'so it no longer publishes completed directly, as the old ledger entry wrongly permitted');
        // Its completion is published for it, through the barrier, by the module it invokes.
        const completionModule = 'src/jobs/reviewExecutionOutcome.ts';
        assert.ok(review.imports.includes(completionModule), 'the review job invokes its completion publisher');
        assert.ok((facts.get(completionModule) as SourceFacts).usesBarrier,
            'and that publisher goes through the durability barrier');
    });

});

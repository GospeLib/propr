/**
 * The test double's copy of the transition-identity derivation must not drift from production.
 *
 * Suites that never touch the database cannot import the real module (it opens the connection on
 * import), so the derivation is reproduced in `helpers/completionCoreDoubles.ts`. A copy that
 * drifted would let those suites assert against an identity the production code never writes,
 * which is exactly the kind of quietly-wrong evidence this whole remediation is about.
 */
import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: () => ({}) } });
const production = await import('../packages/core/src/utils/terminalTransitionClaim.js');
const { terminalTransitionId, durableOperationIdentity, TERMINAL_OPERATION_IDENTITY_MISSING } =
    await import('./helpers/completionCoreDoubles.js');

describe('the doubled transition identity matches the production derivation', () => {
    test('every combination of task, state and operation derives the same identity', () => {
        for (const taskId of ['task-a', 'GospeLib-main-4711-claude-model-correlation']) {
            for (const state of ['completed', 'failed']) {
                for (const operationId of ['issue-job:job-1', 'native-analysis:op-2', 'issue-job:job-1#completion-persistence-failed']) {
                    assert.equal(terminalTransitionId(taskId, state, operationId),
                        production.terminalTransitionId(taskId, state, operationId),
                        `${taskId}/${state}/${operationId}`);
                }
            }
        }
    });

    test('and so does the operation identity, including its refusal', () => {
        assert.equal(durableOperationIdentity('issue-job', 'job-1'), production.durableOperationIdentity('issue-job', 'job-1'));
        assert.equal(durableOperationIdentity('issue-job', 7), production.durableOperationIdentity('issue-job', 7));
        assert.equal(TERMINAL_OPERATION_IDENTITY_MISSING, production.TERMINAL_OPERATION_IDENTITY_MISSING);
        assert.throws(() => durableOperationIdentity('issue-job', ''), new RegExp(TERMINAL_OPERATION_IDENTITY_MISSING));
        assert.throws(() => production.durableOperationIdentity('issue-job', ''), new RegExp(TERMINAL_OPERATION_IDENTITY_MISSING));
    });
});

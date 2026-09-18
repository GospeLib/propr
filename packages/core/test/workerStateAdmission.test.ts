import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import knex from 'knex';
import { TaskStates, type TaskStateData } from '../src/utils/workerStateManager.types.js';

const database = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
const { persistTaskAdmission } = await import('../src/utils/workerStateAdmission.js');
before(async () => {
    await database.schema.createTable('tasks', table => {
        table.string('task_id').primary(); table.string('job_id'); table.string('correlation_id');
        table.string('repository'); table.integer('issue_number'); table.string('task_type');
        table.string('model_name'); table.string('created_at'); table.text('initial_job_data');
    });
    await database.schema.createTable('task_history', table => {
        table.increments('history_id'); table.string('task_id').references('task_id').inTable('tasks');
        table.string('state'); table.string('timestamp'); table.string('reason'); table.text('metadata');
    });
});
after(async () => { await database.destroy(); });
function fixture(taskId: string): TaskStateData {
    const timestamp = new Date().toISOString();
    return { taskId, issueRef: { number: 0, repoOwner: 'fixture', repoName: 'planning', type: 'analysis' },
        state: TaskStates.PENDING, correlationId: 'real-admission', createdAt: timestamp, updatedAt: timestamp,
        attempts: 0, version: 1, history: [] };
}
test('a failed Redis admission projection records FAILED in the real SQLite authority', async () => {
    const original = new Error('Redis projection unavailable');
    await assert.rejects(persistTaskAdmission(fixture('failed-projection'), async () => { throw original; }), error => error === original);
    const history = await database('task_history').where({ task_id: 'failed-projection' }).orderBy('history_id');
    assert.deepEqual(history.map(row => row.state), [TaskStates.PENDING, TaskStates.FAILED]);
    assert.equal(JSON.parse(history[1].metadata).admissionProjectionError, original.message);
    assert.equal(JSON.parse(history[1].metadata).executionStarted, false);
    assert.equal((await database('tasks').where({ task_id: 'failed-projection' })).length, 1);
});
test('successful admission retains the existing PENDING lineage and projects once', async () => {
    let projected = 0;
    assert.equal(await persistTaskAdmission(fixture('successful'), async () => { projected++; }), 'fixture/planning');
    assert.equal(projected, 1);
    assert.deepEqual((await database('task_history').where({ task_id: 'successful' })).map(row => row.state), [TaskStates.PENDING]);
});
test('a failed failure-record append preserves the original admission error', async () => {
    const original = new Error('Redis projection failed before failure storage');
    await assert.rejects(persistTaskAdmission(fixture('failed-record'), async () => {
        await database.schema.dropTable('task_history'); throw original;
    }), error => error === original && 'admissionSettlementError' in error);
});

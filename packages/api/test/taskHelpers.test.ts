import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { closeConnection } from '@propr/core';
import { up as createInitialSchema } from '../../core/src/db/migrations/20251216000000_initial_sqlite_schema.js';
import { up as addPlanIssues } from '../../core/src/db/migrations/20260120000000_add_plan_issues.js';
import { up as addTaskIdToPlanIssues } from '../../core/src/db/migrations/20260121000000_add_task_id_to_plan_issues.js';
import { up as addCommitHash } from '../../core/src/db/migrations/20260203000000_add_commit_hash_to_tasks.js';
import { up as addPrNumber } from '../../core/src/db/migrations/20260216000000_add_pr_number_to_tasks.js';
import { getTasksFromDb } from '../routes/taskHelpers.js';

after(async () => closeConnection());

let database: Knex;

beforeEach(async () => {
  database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
  });
  await createInitialSchema(database);
  await addPlanIssues(database);
  await addTaskIdToPlanIssues(database);
  await addCommitHash(database);
  await addPrNumber(database);
});

afterEach(async () => {
  await database.destroy();
});

async function insertTask(overrides: Partial<{
  taskId: string; repository: string; issueNumber: number; correlationId: string | null;
  commitHash: string | null; prNumber: number | null;
}> = {}): Promise<string> {
  const {
    taskId = 'task-1', repository = 'integry/propr', issueNumber = 42,
    correlationId = null, commitHash = null, prNumber = null,
  } = overrides;
  await database('tasks').insert({
    task_id: taskId,
    repository,
    issue_number: issueNumber,
    task_type: 'issue',
    correlation_id: correlationId,
    commit_hash: commitHash,
    pr_number: prNumber,
  });
  await database('task_history').insert({
    task_id: taskId,
    state: 'completed',
    timestamp: new Date().toISOString(),
  });
  return taskId;
}

describe('getTasksFromDb', () => {
  test('filters by exact repository and issueNumber', async () => {
    await insertTask({ taskId: 'task-match', repository: 'integry/propr', issueNumber: 42 });
    await insertTask({ taskId: 'task-other-repo', repository: 'integry/other', issueNumber: 42 });
    await insertTask({ taskId: 'task-other-issue', repository: 'integry/propr', issueNumber: 43 });

    const result = await getTasksFromDb({
      db: database, status: 'all', repository: 'integry/propr', issueNumber: 42, limit: 50, offset: 0,
    });

    assert.equal(result.total, 1);
    assert.equal(result.tasks.length, 1);
    assert.equal((result.tasks[0] as { id: string }).id, 'task-match');
  });

  test('exposes durable correlation, commit, and PR fields on each task', async () => {
    await insertTask({
      taskId: 'task-durable', repository: 'integry/propr', issueNumber: 7,
      correlationId: 'corr-abc', commitHash: 'deadbeef', prNumber: 99,
    });
    await database('task_history').insert({
      task_id: 'task-durable',
      state: 'claude_execution',
      timestamp: new Date(Date.now() - 1000).toISOString(),
      metadata: JSON.stringify({ admissionId: 'adm-1', operationId: 'op-1', sessionId: 'sess-1' }),
    });

    const result = await getTasksFromDb({
      db: database, status: 'all', repository: 'all', limit: 50, offset: 0,
    });

    assert.equal(result.tasks.length, 1);
    const task = result.tasks[0] as Record<string, unknown>;
    assert.equal(task.correlationId, 'corr-abc');
    assert.equal(task.commitHash, 'deadbeef');
    assert.equal(task.prNumber, 99);
    assert.equal(task.admissionId, 'adm-1');
    assert.equal(task.operationId, 'op-1');
    assert.equal(task.sessionId, 'sess-1');
  });

  test('returns null durable fields when no correlation metadata or durable columns are set', async () => {
    await insertTask({ taskId: 'task-bare', repository: 'integry/propr', issueNumber: 1 });

    const result = await getTasksFromDb({
      db: database, status: 'all', repository: 'all', limit: 50, offset: 0,
    });

    const task = result.tasks[0] as Record<string, unknown>;
    assert.equal(task.correlationId, null);
    assert.equal(task.commitHash, null);
    assert.equal(task.admissionId, null);
    assert.equal(task.operationId, null);
    assert.equal(task.sessionId, null);
  });
});


test('authenticated owner cancellation stays current after refused same-task retries, retaining every history row', async () => {
  const taskId = await insertTask();
  const originalRows = await database('task_history').where({task_id:taskId});
  const base = Date.now();
  const rows = [
    {state:'cancelled',reason:'Owner stop comment; Ezer admission.',metadata:JSON.stringify({cancellationReason:'ezer_owner_stop',controlAdmissionId:'stop-admission',controlOperationId:'stop-operation'})},
    {state:'pending',reason:'Task created',metadata:'{}'},
    {state:'failed',reason:'ezer-execution-admission-refused:missing-worker-receipt',metadata:'{}'},
  ].map((row,index)=>({...row,task_id:taskId,timestamp:new Date(base+index+1).toISOString()}));
  await database('task_history').insert(rows);
  const before=await database('task_history').where({task_id:taskId}).orderBy('history_id');
  const result=await getTasksFromDb({db:database,status:'cancelled',repository:'all',limit:50,offset:0});
  assert.equal(result.total,1);
  assert.equal((result.tasks[0] as Record<string,unknown>).status,'cancelled');
  assert.deepEqual(await database('task_history').where({task_id:taskId}).orderBy('history_id'),before);
  assert.equal(before.length,originalRows.length+rows.length);
});

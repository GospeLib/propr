/**
 * The schema half of the completion-idempotency barrier.
 *
 * Without uniqueness on `task_history.transition_id`, a retry of a terminal transition whose
 * INSERT committed but never acknowledged would write a second row, and the read-back could not
 * name one transition. These tests run the real migration over the real schema and check the
 * three properties the barrier depends on: existing rows survive with a NULL key, NULL keys stay
 * mutually compatible, and a repeated key is rejected.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { fileURLToPath } from 'node:url';

const MIGRATION_FILE = '20260920000000_add_task_history_transition_id.js';
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../packages/core/src/db/migrations', import.meta.url));

const LEGACY_TASK_ID = 'task-legacy-transition-id';
const LEGACY_TIMESTAMP = '2026-09-01T10:00:00.000Z';

let database: Knex;

function historyRow(state: string, transitionId?: string): Record<string, unknown> {
    return {
        task_id: LEGACY_TASK_ID,
        state,
        timestamp: LEGACY_TIMESTAMP,
        reason: `state changed to ${state}`,
        metadata: '{}',
        ...(transitionId === undefined ? {} : { transition_id: transitionId }),
    };
}

async function migrateUpTo(target: string): Promise<void> {
    for (;;) {
        const [, pending] = await database.migrate.list({ directory: MIGRATIONS_DIRECTORY }) as [unknown, Array<{ file?: string } | string>];
        if (pending.length === 0) throw new Error(`${target} is not among the pending migrations`);
        const next = pending[0];
        const file = typeof next === 'string' ? next : next.file ?? '';
        if (file.includes(target)) return;
        await database.migrate.up({ directory: MIGRATIONS_DIRECTORY });
    }
}

before(async () => {
    database = knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        migrations: { directory: MIGRATIONS_DIRECTORY },
    });
    await migrateUpTo(MIGRATION_FILE);

    // Rows written before the column existed, exactly as a live database holds them.
    await database('tasks').insert({
        task_id: LEGACY_TASK_ID, repository: 'GospeLib/main', task_type: 'issue', created_at: LEGACY_TIMESTAMP,
    });
    await database('task_history').insert([historyRow('processing'), historyRow('claude_execution')]);

    await database.migrate.up({ directory: MIGRATIONS_DIRECTORY });
});

after(async () => { await database.destroy(); });

describe('task_history carries a unique transition id', () => {
    test('the migration ran and existing rows survive it with a NULL key', async () => {
        const [completed] = await database.migrate.list({ directory: MIGRATIONS_DIRECTORY }) as [Array<{ name?: string } | string>, unknown];
        const names = completed.map(entry => (typeof entry === 'string' ? entry : entry.name ?? ''));
        assert.ok(names.some(name => name.includes(MIGRATION_FILE)), 'the migration is applied');

        const rows = await database('task_history').where({ task_id: LEGACY_TASK_ID }).select('state', 'transition_id');
        assert.equal(rows.length, 2, 'no pre-existing row was lost');
        for (const row of rows) assert.equal(row.transition_id, null, 'and none violates the new constraint');
    });

    test('keyless rows stay mutually compatible, so untouched writers are unaffected', async () => {
        await database('task_history').insert([historyRow('post_processing'), historyRow('post_processing')]);
        const rows = await database('task_history').where({ task_id: LEGACY_TASK_ID, state: 'post_processing' });
        assert.equal(rows.length, 2, 'a unique index treats NULLs as distinct');
    });

    test('one transition can only be recorded once, while different transitions both land', async () => {
        const first = `completed:${LEGACY_TASK_ID}:11111111-1111-4111-8111-111111111111`;
        const second = `completed:${LEGACY_TASK_ID}:22222222-2222-4222-8222-222222222222`;

        await database('task_history').insert(historyRow('completed', first));
        await assert.rejects(() => database('task_history').insert(historyRow('completed', first)),
            /UNIQUE constraint failed/);
        await database('task_history').insert(historyRow('completed', second));

        const rows = await database('task_history').where({ task_id: LEGACY_TASK_ID, state: 'completed' });
        assert.equal(rows.length, 2, 'a retry is rejected; a genuinely different transition is not');
    });
});

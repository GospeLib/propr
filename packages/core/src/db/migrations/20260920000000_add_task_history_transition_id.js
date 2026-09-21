/**
 * Gives every terminal task-history transition an idempotency key.
 *
 * A history INSERT can commit and still reject before the client sees the acknowledgement. With
 * no uniqueness on the row, a blind retry could not tell "nothing landed" from "it landed and I
 * never heard", so a durably recorded `completed` could be followed by a `failed` fallback and a
 * delivered success would be read as a failure and re-dispatched.
 *
 * `transition_id` is written by the writer that owns a logical terminal transition and stays the
 * same across that transition's retries, so the unique index makes the retry a no-op instead of a
 * duplicate row, and the key can be read back to establish what is actually durable.
 *
 * Existing rows predate the column and are therefore NULL. A unique index treats NULLs as
 * distinct (SQLite and PostgreSQL alike), so no existing row can violate the new constraint and
 * no backfill is needed; transitions written without a key keep their previous semantics.
 */
export async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('task_history', 'transition_id');
  if (!hasColumn) {
    await knex.schema.alterTable('task_history', table => {
      table.string('transition_id', 191).nullable();
    });
  }
  await knex.schema.alterTable('task_history', table => {
    table.unique(['transition_id'], { indexName: 'task_history_transition_id_unique' });
  });
}

export async function down(knex) {
  await knex.schema.alterTable('task_history', table => {
    table.dropUnique(['transition_id'], 'task_history_transition_id_unique');
  });
  await knex.schema.alterTable('task_history', table => {
    table.dropColumn('transition_id');
  });
}

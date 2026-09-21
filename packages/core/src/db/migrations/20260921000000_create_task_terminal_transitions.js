/**
 * The durable claim a terminal transition makes on its identity, written before the terminal row.
 *
 * A randomly generated idempotency key is worthless across the failure it exists for: the process
 * dies after the INSERT commits, the queue redelivers the job, and the retry invents a different
 * key. The read-back by key then finds nothing, the completion looks absent, and a second
 * completed row — or a `failed` settlement over a delivered success — follows.
 *
 * So the identity is derived from the logical operation (the admission or job identity that owns
 * this attempt) and claimed here BEFORE the terminal write. A crash and a queue retry re-derive
 * the same operation identity, re-claim, and get the same `transition_id` back — the one the
 * committed row already carries — so the read-back recognises it.
 *
 * `(task_id, state, operation_id)` is unique so one logical operation owns exactly one terminal
 * transition of one task; `transition_id` is unique because it is the key written into
 * `task_history.transition_id`, whose own unique index turns a repeat insert into a rejection.
 */
export async function up(knex) {
  const exists = await knex.schema.hasTable('task_terminal_transitions');
  if (exists) return;
  await knex.schema.createTable('task_terminal_transitions', table => {
    table.string('transition_id', 191).primary();
    table.string('task_id', 191).notNullable();
    table.string('state', 64).notNullable();
    table.string('operation_id', 512).notNullable();
    table.string('claimed_at').notNullable();
    table.unique(['task_id', 'state', 'operation_id'], { indexName: 'task_terminal_transitions_operation_unique' });
    table.index(['task_id'], 'task_terminal_transitions_task_id_index');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_terminal_transitions');
}

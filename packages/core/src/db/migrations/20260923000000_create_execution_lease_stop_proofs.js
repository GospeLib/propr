/**
 * Durable proof that a NAMED generation of an execution lease has stopped executing.
 *
 * A lapsed `expires_at` says only that nothing renewed the lease — a suspended event loop, a
 * stalled write or a skewed clock all produce it while the provider keeps running and keeps
 * charging. Treating that silence as permission is how a second PAID execution starts, and the
 * terminal transition identity then only deduplicates the row it eventually writes.
 *
 * So a takeover needs this: a row written by whoever ESTABLISHED that the prior executor stopped
 * (an operator who confirmed the container is gone, or a reconciler that verified it), naming the
 * exact generation it is about. `consumed_at` is set by the conditional UPDATE that spends it, so
 * one proof admits exactly one successor and can never be replayed for a later holder.
 */
export async function up(knex) {
  const exists = await knex.schema.hasTable('task_execution_lease_stop_proofs');
  if (exists) return;
  await knex.schema.createTable('task_execution_lease_stop_proofs', table => {
    table.string('lease_key', 512).notNullable();
    table.string('lease_generation', 191).notNullable();
    table.text('proof').notNullable();
    table.string('recorded_by', 191).notNullable();
    table.string('recorded_at').notNullable();
    table.string('consumed_at').nullable();
    table.string('consumed_by_generation', 191).nullable();
    table.primary(['lease_key', 'lease_generation']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_execution_lease_stop_proofs');
}

/**
 * The durable, mutually exclusive right to run ONE paid execution of one logical operation.
 *
 * The terminal transition identity in `task_terminal_transitions` makes a settled operation
 * recognisable after the fact, which stops a SECOND COMPLETED ROW but not a second CHARGE: by the
 * time it speaks the provider has already run. Two deliveries in flight at once, or a redelivery
 * whose Redis projection is gone, both got past it and paid twice.
 *
 * `lease_key` is the durable operation identity and the primary key, so an insert that conflicts
 * is the database refusing a second holder — arbitration happens in one statement rather than in a
 * read-then-write. `lease_generation` fences the holder: renewal, settlement and release all match
 * on it, so a superseded attempt cannot act on the lease that superseded it. `expires_at` is the
 * holder's term, extended by its heartbeat, and a lapsed term is the only evidence that permits a
 * takeover. `settled_at` is terminal — once the operation is settled the lease is never granted
 * again, whatever its expiry says.
 */
export async function up(knex) {
  const exists = await knex.schema.hasTable('task_execution_leases');
  if (exists) return;
  await knex.schema.createTable('task_execution_leases', table => {
    table.string('lease_key', 512).primary();
    table.string('task_id', 191).notNullable();
    table.string('operation_id', 512).notNullable();
    table.string('lease_generation', 191).notNullable();
    table.string('acquired_at').notNullable();
    table.string('expires_at').notNullable();
    table.string('settled_at').nullable();
    table.string('settled_state', 64).nullable();
    table.index(['task_id'], 'task_execution_leases_task_id_index');
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('task_execution_leases');
}

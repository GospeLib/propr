/**
 * Why a lapsed lease is waiting, recorded by the attempt that lapsed it.
 *
 * An unsettled lease whose term ran out is refused, and refusing is right — silence is not proof
 * that the provider stopped. But an operator then has to decide whether the executor is gone, and
 * the one fact that decision turns on is whether the provider was ever REACHED. An attempt that
 * failed before `analyze` was called spent nothing and its lease is safe to hand back; an attempt
 * that failed after it spent something that may already have been billed, and handing that lease
 * back is how the same work gets paid for twice.
 *
 * The attempt itself is the only thing that knows which of the two happened, so it writes it here
 * before it goes. `reconciliation_reason` is free text for a human; `provider_invocation_started`
 * is the decidable flag the refusal and the reconciliation command both read.
 */
export async function up(knex) {
  const exists = await knex.schema.hasTable('task_execution_leases');
  if (!exists) return;
  const hasReason = await knex.schema.hasColumn('task_execution_leases', 'reconciliation_reason');
  if (hasReason) return;
  await knex.schema.alterTable('task_execution_leases', table => {
    table.text('reconciliation_reason').nullable();
    table.string('reconciliation_requested_at').nullable();
    table.boolean('provider_invocation_started').notNullable().defaultTo(false);
  });
}

export async function down(knex) {
  const exists = await knex.schema.hasTable('task_execution_leases');
  if (!exists) return;
  await knex.schema.alterTable('task_execution_leases', table => {
    table.dropColumn('reconciliation_reason');
    table.dropColumn('reconciliation_requested_at');
    table.dropColumn('provider_invocation_started');
  });
}

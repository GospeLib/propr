/**
 * The two facts a lapsed lease can carry, kept as two different records.
 *
 * "That executor stopped" and "that executor stopped AFTER it had already reached the provider"
 * are not the same fact, and an ordinary stop proof may only ever mean the first. Once
 * `provider_invocation_started` is set the attempt may already have been billed, so admitting a
 * successor on a plain proof buys the same work twice — the proof is therefore refused outright
 * while the flag stands, and the flag becomes a durable barrier no ordinary reconciliation crosses.
 *
 * Crossing it deliberately is a separate decision, and this migration is where that decision
 * becomes recordable. `provider_spend_disposition` names, on the proof itself, which decision was
 * taken about the money already spent; `reconciliation_recorded_by` attributes the decision on the
 * lease, so a lease closed out by hand says who closed it and on what grounds.
 */
export async function up(knex) {
  const hasProofs = await knex.schema.hasTable('task_execution_lease_stop_proofs');
  if (hasProofs && !(await knex.schema.hasColumn('task_execution_lease_stop_proofs', 'provider_spend_disposition'))) {
    await knex.schema.alterTable('task_execution_lease_stop_proofs', table => {
      table.string('provider_spend_disposition', 64).nullable();
    });
  }
  const hasLeases = await knex.schema.hasTable('task_execution_leases');
  if (hasLeases && !(await knex.schema.hasColumn('task_execution_leases', 'reconciliation_recorded_by'))) {
    await knex.schema.alterTable('task_execution_leases', table => {
      table.string('reconciliation_recorded_by', 191).nullable();
    });
  }
}

export async function down(knex) {
  if (await knex.schema.hasTable('task_execution_lease_stop_proofs')) {
    await knex.schema.alterTable('task_execution_lease_stop_proofs', table => {
      table.dropColumn('provider_spend_disposition');
    });
  }
  if (await knex.schema.hasTable('task_execution_leases')) {
    await knex.schema.alterTable('task_execution_leases', table => {
      table.dropColumn('reconciliation_recorded_by');
    });
  }
}

/**
 * THE ONLY INTERFACE A HUMAN HAS TO A STUCK PAID OPERATION.
 *
 * The lease state machine makes two decisions about an attempt that already reached the provider,
 * and it makes them unmistakable in the database: `settle-without-rerun` closes the operation on
 * the money already spent, `authorise-another-paid-run` pays for the work again and says so on the
 * proof it writes. Until this command could express either of them, an operation in that state was
 * stuck: `record` NECESSARILY refuses it with "its spend must be reconciled first", and there was
 * nothing else to type. A distinction the database is careful about is worth nothing if the only
 * interface to it cannot reach one side of it and cannot show the other.
 *
 * So these tests are about the interface, at the boundary the script calls: which command was
 * named, what it insists on before the database is touched, and how a lease reads back. The
 * script's own wiring — `process.argv`, the terminal, the connection pool, the exit code — is not
 * exercised here and is stated as such in the report.
 *
 * THE ASYMMETRY IS THE POINT. `settle-without-rerun` costs nothing and asks for nothing beyond the
 * ordinary controls. `authorise-another-paid-run` spends money, and it is deliberately harder to
 * arrive at: a verb of its own rather than a value of `--disposition`, plus a sentence that names
 * the very lease about to be charged a second time.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createExecutionLeases } from '../packages/core/src/db/migrations/20260922000000_create_task_execution_leases.js';
import { up as createStopProofs } from '../packages/core/src/db/migrations/20260923000000_create_execution_lease_stop_proofs.js';
import { up as addReconciliation } from '../packages/core/src/db/migrations/20260924000000_add_execution_lease_reconciliation.js';
import { up as addSpendReconciliation } from '../packages/core/src/db/migrations/20260925000000_add_execution_lease_spend_reconciliation.js';
import type { LapsedExecutionLease } from '../packages/core/src/utils/executionLease.js';
import {
    AUTHORISE_ANOTHER_PAID_RUN, SETTLE_WITHOUT_RERUN, announceCommand, describeLapsedLease,
    parseReconciliationCommand, secondChargeAcknowledgement,
} from '../scripts/lib/execution-lease-reconciliation.js';

// The real schema, for the end-to-end suite at the bottom: what this command is FOR is moving a
// lease the state machine has deliberately frozen, and only the real statements can show that.
const database: Knex = knex({
    client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true,
});
await mock.module('../packages/core/src/db/connection.js', { namedExports: { db: database } });
const {
    acquireExecutionLease, lapsedExecutionLeases, markProviderInvocationStarted,
    recordVerifiedExecutorStop, reconcileProviderInvocationSpend, PROVIDER_SPEND_RECONCILED_STATE,
} = await import('../packages/core/src/utils/executionLease.js');

before(async () => {
    await createExecutionLeases(database);
    await createStopProofs(database);
    await addReconciliation(database);
    await addSpendReconciliation(database);
});
after(async () => { await database.destroy(); });

const KEY = 'operation:9f2c';
const OTHER_KEY = 'operation:0000';
const GENERATION = 'gen-1a2b3c';
const identity = ['--lease-key', KEY, '--generation', GENERATION,
    '--confirm-generation', GENERATION, '--recorded-by', 'lance'];
const finding = ['--finding', 'the container is gone and its run produced a complete result'];

describe('the operator can reach BOTH spend dispositions, and they are different commands', () => {
    test('settle-without-rerun becomes the settling disposition, with the ordinary controls', () => {
        const command = parseReconciliationCommand(SETTLE_WITHOUT_RERUN, [...identity, ...finding]);
        assert.deepEqual(command, { kind: 'spend', options: {
            leaseKey: KEY, generation: GENERATION, confirmGeneration: GENERATION, recordedBy: 'lance',
            spendFinding: 'the container is gone and its run produced a complete result',
            disposition: 'settle-without-rerun',
        } }, 'the disposition the core refuses to guess is named by the verb the operator typed');
    });

    test('authorise-another-paid-run becomes the spending disposition, once acknowledged', () => {
        const command = parseReconciliationCommand(AUTHORISE_ANOTHER_PAID_RUN,
            [...identity, ...finding, '--acknowledge-second-charge', secondChargeAcknowledgement(KEY)]);
        assert.equal(command.kind, 'spend');
        assert.equal(command.kind === 'spend' && command.options.disposition, 'authorise-another-paid-run');
    });

    test('both dispositions are spelled exactly as the reconciliation accepts them', () => {
        // The core refuses anything else with "the spend disposition must be one of the two
        // decisions this reconciliation offers", and a CLI that produced a near-miss would send
        // the operator round a loop with no way out of it.
        assert.deepEqual([SETTLE_WITHOUT_RERUN, AUTHORISE_ANOTHER_PAID_RUN],
            ['settle-without-rerun', 'authorise-another-paid-run']);
    });

    for (const verb of [SETTLE_WITHOUT_RERUN, AUTHORISE_ANOTHER_PAID_RUN]) {
        for (const missing of ['lease-key', 'generation', 'confirm-generation', 'recorded-by', 'finding']) {
            test(`${verb} refuses without --${missing}, like record does`, () => {
                const argv = [...identity, ...finding,
                    '--acknowledge-second-charge', secondChargeAcknowledgement(KEY)];
                const at = argv.indexOf(`--${missing}`);
                const without = [...argv.slice(0, at), ...argv.slice(at + 2)];
                const command = parseReconciliationCommand(verb, without);
                assert.equal(command.kind, 'refused', 'nothing may reach the database half-stated');
                assert.match(command.kind === 'refused' ? command.message : '', /every option is required/);
            });
        }
    }

    test('an option left empty before the next flag is missing, not the next flag', () => {
        // `--generation --confirm-generation gen-x` would otherwise confirm a generation the
        // operator never typed against a generation named `--confirm-generation`.
        const command = parseReconciliationCommand(SETTLE_WITHOUT_RERUN,
            ['--lease-key', KEY, '--generation', '--confirm-generation', GENERATION,
                '--recorded-by', 'lance', ...finding]);
        assert.equal(command.kind, 'refused');
    });

    test('record is untouched: it still parses to the ordinary stop proof', () => {
        const command = parseReconciliationCommand('record',
            [...identity, '--proof', 'docker ps shows no container for this generation']);
        assert.deepEqual(command, { kind: 'record', options: {
            leaseKey: KEY, generation: GENERATION, confirmGeneration: GENERATION, recordedBy: 'lance',
            proof: 'docker ps shows no container for this generation',
        } });
    });

    test('list takes no options and an unknown verb refuses with the usage', () => {
        assert.deepEqual(parseReconciliationCommand('list', []), { kind: 'list' });
        assert.equal(parseReconciliationCommand('reconcile', identity).kind, 'refused');
        assert.equal(parseReconciliationCommand(undefined, []).kind, 'refused');
    });
});

describe('the command that spends money is harder to choose than the one that does not', () => {
    test('the safe disposition asks for no acknowledgement at all', () => {
        assert.equal(parseReconciliationCommand(SETTLE_WITHOUT_RERUN, [...identity, ...finding]).kind, 'spend');
    });

    test('the spending one is refused with no acknowledgement, and says what costs nothing instead', () => {
        const command = parseReconciliationCommand(AUTHORISE_ANOTHER_PAID_RUN, [...identity, ...finding]);
        assert.equal(command.kind, 'refused');
        const message = command.kind === 'refused' ? command.message : '';
        assert.match(message, /pays for the same work a second time/);
        assert.match(message, new RegExp(`--acknowledge-second-charge "${secondChargeAcknowledgement(KEY)}"`));
        assert.match(message, new RegExp(`${SETTLE_WITHOUT_RERUN} costs nothing`),
            'the refusal points at the decision that spends nothing, because that is usually the right one');
    });

    test('the acknowledgement names THIS lease: the right words about another one are refused', () => {
        const command = parseReconciliationCommand(AUTHORISE_ANOTHER_PAID_RUN,
            [...identity, ...finding, '--acknowledge-second-charge', secondChargeAcknowledgement(OTHER_KEY)]);
        assert.equal(command.kind, 'refused',
            'a phrase that can be pasted between incidents is a phrase that stops meaning anything');
    });

    for (const attempt of ['yes', 'pay again', `pay again for ${KEY} `, 'PAY AGAIN FOR operation:9f2c']) {
        test(`"${attempt}" does not authorise a second charge`, () => {
            assert.equal(parseReconciliationCommand(AUTHORISE_ANOTHER_PAID_RUN,
                [...identity, ...finding, '--acknowledge-second-charge', attempt]).kind, 'refused');
        });
    }

    test('the spending disposition cannot be reached through the safe verb', () => {
        // The disposition is not a value an operator supplies, so there is no wrong word to type
        // in the right place: `--disposition authorise-another-paid-run` changes nothing.
        const command = parseReconciliationCommand(SETTLE_WITHOUT_RERUN,
            [...identity, ...finding, '--disposition', AUTHORISE_ANOTHER_PAID_RUN]);
        assert.equal(command.kind === 'spend' && command.options.disposition, 'settle-without-rerun');
    });

    test('the spending disposition cannot be reached through record either', () => {
        const command = parseReconciliationCommand('record',
            [...identity, '--proof', 'the container is gone', '--disposition', AUTHORISE_ANOTHER_PAID_RUN]);
        assert.equal(command.kind, 'record', 'record writes an ordinary stop proof or nothing');
    });

    test('what it announces before acting says plainly that money is about to be spent', () => {
        const spending = announceCommand(parseReconciliationCommand(AUTHORISE_ANOTHER_PAID_RUN,
            [...identity, ...finding, '--acknowledge-second-charge', secondChargeAcknowledgement(KEY)]));
        assert.match(spending, /PAYING AGAIN/);
        assert.match(spending, /this costs money/);
        const settling = announceCommand(parseReconciliationCommand(SETTLE_WITHOUT_RERUN, [...identity, ...finding]));
        assert.doesNotMatch(settling, /costs money/);
        assert.match(settling, /never be executed again/);
    });
});

describe('the listing distinguishes an authorised rerun from an ordinary stop proof', () => {
    const lease = (over: Partial<LapsedExecutionLease>): LapsedExecutionLease => ({
        leaseKey: KEY, taskId: 'task-1', operationId: 'op-1', holderGeneration: GENERATION,
        acquiredAt: '2026-09-20T10:00:00Z', expiresAt: '2026-09-20T10:05:00Z',
        providerInvocationStarted: false, ...over,
    });

    test('an authorised second paid run reads as one, not as an unspent stop proof', () => {
        const printed = describeLapsedLease(lease({
            providerInvocationStarted: true, reconciliationRecordedBy: 'lance',
            stopProof: { recordedBy: 'lance', recordedAt: '2026-09-20T11:00:00Z',
                providerSpendDisposition: 'authorise-another-paid-run' },
        }));
        assert.match(printed, /AUTHORISED ANOTHER PAID RUN/);
        assert.match(printed, /reconciled {2}by hand, by lance/);
    });

    test('an ordinary unspent proof is not dressed up as a reconciliation', () => {
        const printed = describeLapsedLease(lease({
            stopProof: { recordedBy: 'lance', recordedAt: '2026-09-20T11:00:00Z' },
        }));
        assert.match(printed, /on file, unspent/);
        assert.doesNotMatch(printed, /AUTHORISED/);
        assert.match(printed, /disposition none/);
        assert.match(printed, /reconciled {2}by nobody/,
            'the field is printed even when it is empty, because its absence is the thing being said');
    });

    test('a settled-without-rerun reconciliation names who closed it and why', () => {
        const printed = describeLapsedLease(lease({
            providerInvocationStarted: true, reconciliationRecordedBy: 'lance',
            reconciliationReason: 'the run completed and its result was recovered from the log',
        }));
        assert.match(printed, /reconciled {2}by hand, by lance/);
        assert.match(printed, /why {9}the run completed/);
        assert.match(printed, /REACHED/);
    });

    test('a holder that never reached the provider says nothing was spent', () => {
        const printed = describeLapsedLease(lease({}));
        assert.match(printed, /never reached — nothing was spent by this holder/);
        assert.match(printed, /stop proof {2}none on file/);
    });
});

/**
 * THE STUCK OPERATION, MOVED — THROUGH THIS COMMAND'S OWN PARSE, AGAINST THE REAL STATEMENTS.
 *
 * Everything above is about the interface in isolation. This is the claim that matters: an
 * attempt that reached the provider and then lapsed is refused by `record` BY DESIGN, and before
 * these two verbs existed there was nothing else an operator could type. So the parse output is
 * handed to the very functions the script hands it to, against the schema built from the
 * migrations, and the lease is watched actually moving.
 */
describe('a lease frozen after the provider was reached can be moved from this command', () => {
    const lapsed = async (): Promise<{ leaseKey: string; generation: string }> => {
        const leaseKey = `native-analysis:${randomUUID()}`;
        const outcome = await acquireExecutionLease({
            leaseKey, taskId: 'task-1', operationId: 'op-1', generation: randomUUID(), ttlMs: -1_000,
        });
        assert.equal(outcome.outcome, 'acquired');
        const lease = outcome.outcome === 'acquired' ? outcome.lease : undefined;
        assert.ok(lease);
        assert.equal(await markProviderInvocationStarted(lease), true);
        return { leaseKey, generation: lease.generation };
    };
    const spendOptions = (verb: string, leaseKey: string, generation: string) => {
        const command = parseReconciliationCommand(verb, [
            '--lease-key', leaseKey, '--generation', generation, '--confirm-generation', generation,
            '--recorded-by', 'lance', '--finding', 'the container is gone; the run never returned a result',
            ...(verb === AUTHORISE_ANOTHER_PAID_RUN
                ? ['--acknowledge-second-charge', secondChargeAcknowledgement(leaseKey)] : []),
        ]);
        assert.equal(command.kind, 'spend');
        return command.kind === 'spend' ? command.options : undefined!;
    };

    test('`record` refuses it, which is why the other two verbs had to exist', async () => {
        const { leaseKey, generation } = await lapsed();
        assert.deepEqual(await recordVerifiedExecutorStop({
            leaseKey, generation, confirmGeneration: generation, recordedBy: 'lance',
            proof: 'the container for this generation is gone',
        }), { recorded: false,
            refusal: 'that executor had already reached the provider, so its spend must be reconciled first' });
    });

    test('settle-without-rerun closes it out, and the listing stops reporting it stuck', async () => {
        const { leaseKey, generation } = await lapsed();
        assert.deepEqual(await reconcileProviderInvocationSpend(
            spendOptions(SETTLE_WITHOUT_RERUN, leaseKey, generation)), { recorded: true });
        const row = await database('task_execution_leases').where({ lease_key: leaseKey }).first();
        assert.equal(row.settled_state, PROVIDER_SPEND_RECONCILED_STATE);
        assert.equal(row.reconciliation_recorded_by, 'lance');
        assert.equal((await lapsedExecutionLeases()).some(lease => lease.leaseKey === leaseKey), false,
            'a settled lease is no longer a stuck operation');
    });

    test('authorise-another-paid-run lowers the barrier and the listing says what it was', async () => {
        const { leaseKey, generation } = await lapsed();
        assert.deepEqual(await reconcileProviderInvocationSpend(
            spendOptions(AUTHORISE_ANOTHER_PAID_RUN, leaseKey, generation)), { recorded: true });
        const lease = (await lapsedExecutionLeases()).find(candidate => candidate.leaseKey === leaseKey);
        assert.ok(lease, 'it is still unsettled: a successor is admitted, the operation is not closed');
        assert.equal(lease.stopProof?.providerSpendDisposition, 'authorise-another-paid-run');
        const printed = describeLapsedLease(lease);
        assert.match(printed, /AUTHORISED ANOTHER PAID RUN/);
        assert.match(printed, /reconciled {2}by hand, by lance/,
            'the two records the database distinguishes are distinguished at the interface too');
    });

    test('the same authorisation twice does not admit two paid successors', async () => {
        const { leaseKey, generation } = await lapsed();
        const options = spendOptions(AUTHORISE_ANOTHER_PAID_RUN, leaseKey, generation);
        assert.deepEqual(await reconcileProviderInvocationSpend(options), { recorded: true });
        assert.deepEqual(await reconcileProviderInvocationSpend(options),
            { recorded: false, refusal: 'a proof for this generation is already on file' });
    });
});

/**
 * The execution lease decides, in the database, which attempt is allowed to spend money.
 *
 * These run against a real SQLite schema built from the migrations, because the properties being
 * asserted are properties of the STATEMENTS — `INSERT … ON CONFLICT DO NOTHING` admitting exactly
 * one row, a conditional `UPDATE` reporting how many rows it actually changed, and a transaction
 * that carries a settlement in with its caller's write or takes it back out. A hand-written double
 * would assert the test author's model of those statements, which is precisely the thing that must
 * not be assumed.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createExecutionLeases } from '../src/db/migrations/20260922000000_create_task_execution_leases.js';
import { up as createStopProofs } from '../src/db/migrations/20260923000000_create_execution_lease_stop_proofs.js';
import { up as addReconciliation } from '../src/db/migrations/20260924000000_add_execution_lease_reconciliation.js';

const database: Knex = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
});
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
const {
    acquireExecutionLease, databaseNow, lapsedExecutionLeases, markProviderInvocationStarted,
    recordExecutorStopProof, recordVerifiedExecutorStop, releaseExecutionLease,
    renewExecutionLease, retainLeaseForReconciliation, settleExecutionLease,
} = await import('../src/utils/executionLease.js');

const TTL_MS = 60_000;
const leaseKey = () => `native-analysis:${randomUUID()}`;

before(async () => {
    await createExecutionLeases(database);
    await createStopProofs(database);
    await addReconciliation(database);
});
after(async () => { await database.destroy(); });

function request(key: string, generation: string, overrides: Record<string, unknown> = {}) {
    return { leaseKey: key, taskId: `task-${key.slice(-8)}`, operationId: key, generation, ttlMs: TTL_MS, ...overrides };
}

/** The holder stopped heartbeating. Nothing else about it is known — which is the whole point. */
async function lapseTerm(key: string): Promise<void> {
    await database('task_execution_leases').where({ lease_key: key })
        .update({ expires_at: new Date(Date.now() - TTL_MS).toISOString() });
}

async function stopProof(key: string, generation: string): Promise<void> {
    await recordExecutorStopProof({ leaseKey: key, generation,
        proof: 'operator confirmed the provider container is gone', recordedBy: 'operator:test' });
}

describe('the right to run one paid execution is exclusive, durable and generation-fenced', () => {
    test('two simultaneous acquisitions of one operation produce exactly one holder', async () => {
        const key = leaseKey();
        const generations = [randomUUID(), randomUUID(), randomUUID()];
        const outcomes = await Promise.all(generations.map(generation => acquireExecutionLease(request(key, generation))));
        assert.equal(outcomes.filter(outcome => outcome.outcome === 'acquired').length, 1,
            'the insert is the arbitration: one statement admits one row, so one attempt may execute');
        assert.deepEqual(outcomes.filter(outcome => outcome.outcome !== 'acquired').map(outcome => outcome.outcome),
            ['held', 'held'], 'and every other attempt is refused while the holder is live');
        assert.equal((await database('task_execution_leases').where({ lease_key: key })).length, 1);
    });

    test('a live holder is never taken over, however long its work runs', async () => {
        const key = leaseKey();
        const holder = randomUUID();
        assert.equal((await acquireExecutionLease(request(key, holder))).outcome, 'acquired');
        assert.equal(await renewExecutionLease({ leaseKey: key, generation: holder, expiresAt: '' }, TTL_MS), true);
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'held');
    });

    test('a lapsed term admits NOBODY: silence is not proof that the provider stopped', async () => {
        const key = leaseKey();
        const suspended = randomUUID();
        assert.equal((await acquireExecutionLease(request(key, suspended))).outcome, 'acquired');
        // The holder's event loop is suspended, or its renewals cannot reach SQLite: the term
        // lapses while the provider it started keeps running and keeps charging.
        await lapseTerm(key);
        const contender = await acquireExecutionLease(request(key, randomUUID()));
        assert.equal(contender.outcome, 'unreconciled',
            'an expired heartbeat is not evidence of a stopped executor, so it grants nothing');
        assert.equal((contender as { holderGeneration: string }).holderGeneration, suspended);
        const row = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(row.lease_generation, suspended, 'and the suspended holder still owns the lease');
    });

    test('durable proof that the named executor stopped admits exactly one successor', async () => {
        const key = leaseKey();
        const abandoned = randomUUID();
        await acquireExecutionLease(request(key, abandoned));
        await lapseTerm(key);
        await stopProof(key, abandoned);
        const takers = await Promise.all([randomUUID(), randomUUID()]
            .map(generation => acquireExecutionLease(request(key, generation))));
        const winners = takers.filter(outcome => outcome.outcome === 'acquired');
        assert.equal(winners.length, 1, 'consuming the proof is a conditional update, so it has one winner');
        assert.equal((winners[0] as { takenOverFrom?: string }).takenOverFrom, abandoned);
        assert.equal(takers.filter(outcome => outcome.outcome === 'unreconciled').length, 1,
            'and the loser is refused rather than admitted to a second paid run');
        const proof = await database('task_execution_lease_stop_proofs')
            .where({ lease_key: key, lease_generation: abandoned }).first();
        assert.ok(proof.consumed_at, 'a spent proof is spent: it can never admit a second successor');
    });

    test('a stop proof about one generation cannot be spent on another', async () => {
        const key = leaseKey();
        const first = randomUUID();
        await acquireExecutionLease(request(key, first));
        await lapseTerm(key);
        await stopProof(key, first);
        const successor = await acquireExecutionLease(request(key, randomUUID()));
        assert.equal(successor.outcome, 'acquired');
        // The successor now stalls in exactly the same way. The proof already on file was about
        // the FIRST executor, and says nothing about this one.
        await lapseTerm(key);
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'unreconciled');
    });

    test('a settled operation is never leased again, expiry or not', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        assert.equal((await acquireExecutionLease(request(key, generation))).outcome, 'acquired');
        assert.equal(await settleExecutionLease({ leaseKey: key, generation, expiresAt: '' }, 'completed'), true);
        await lapseTerm(key);
        await stopProof(key, generation);
        const retry = await acquireExecutionLease(request(key, randomUUID()));
        assert.equal(retry.outcome, 'settled',
            'an expired lease over a settled operation is still not executable, proof or no proof');
        assert.equal((retry as { settledState: string }).settledState, 'completed');
    });

    test('a fenced-out attempt can neither renew, settle nor release the lease that superseded it', async () => {
        const key = leaseKey();
        const stale = randomUUID();
        await acquireExecutionLease(request(key, stale));
        await lapseTerm(key);
        await stopProof(key, stale);
        const successor = randomUUID();
        assert.equal((await acquireExecutionLease(request(key, successor))).outcome, 'acquired');
        const staleLease = { leaseKey: key, generation: stale, expiresAt: '' };
        assert.equal(await renewExecutionLease(staleLease, TTL_MS), false);
        assert.equal(await settleExecutionLease(staleLease, 'completed'), false);
        assert.equal(await releaseExecutionLease(staleLease), false);
        const row = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(row.lease_generation, successor);
        assert.equal(row.settled_at, null, 'and the live holder is still unsettled and still holding');
    });

    test('releasing an unsettled lease lets a legitimate retry run at once, without waiting out the term', async () => {
        const key = leaseKey();
        const first = randomUUID();
        await acquireExecutionLease(request(key, first));
        assert.equal(await releaseExecutionLease({ leaseKey: key, generation: first, expiresAt: '' }), true);
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'acquired',
            'an attempt that settled nothing and says so itself must not become a permanent refusal');
    });

    test('a settled lease is never released, so its operation cannot be re-run', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        await acquireExecutionLease(request(key, generation));
        const lease = { leaseKey: key, generation, expiresAt: '' };
        await settleExecutionLease(lease, 'failed');
        assert.equal(await releaseExecutionLease(lease), false);
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'settled');
    });

    test('a settlement joins its caller\'s transaction, and leaves with it when that rolls back', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        await acquireExecutionLease(request(key, generation));
        const lease = { leaseKey: key, generation, expiresAt: '' };
        await assert.rejects(() => database.transaction(async transaction => {
            assert.equal(await settleExecutionLease(lease, 'failed', transaction), true);
            throw new Error('the terminal history write failed');
        }));
        const afterRollback = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(afterRollback.settled_at, null,
            'a settlement without its terminal record is not a settlement');
        await database.transaction(async transaction => {
            await settleExecutionLease(lease, 'failed', transaction);
        });
        const afterCommit = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(afterCommit.settled_state, 'failed');
    });

    test('every term is measured by the database clock, not by the acquiring process', async () => {
        const key = leaseKey();
        const acquired = await acquireExecutionLease(request(key, randomUUID()));
        assert.equal(acquired.outcome, 'acquired');
        const row = await database('task_execution_leases').where({ lease_key: key }).first();
        const drift = Math.abs(new Date(row.expires_at).getTime()
            - (new Date(await databaseNow()).getTime() + TTL_MS));
        assert.ok(drift < 5_000, `the term is derived from the database clock (drift ${drift}ms)`);
    });
});

/**
 * A failure interleaved BETWEEN spending the stop proof and taking the lease.
 *
 * The two statements used to be separately committed, and the gap between them had no way out of
 * it: the proof is spent, the prior generation is still installed, and `recordExecutorStopProof`
 * cannot write that generation's proof a second time — so every later attempt reads `unreconciled`
 * for ever. Each of these makes the second statement fail, by a different mechanism, and asks the
 * same question of all of them: is the proof still spendable afterwards?
 *
 * A trigger is used because the interleave has to land INSIDE the transaction, which is strictly
 * the harder case: a renewal or a settlement that commits before the transaction opens is refused
 * by the conditional UPDATE anyway.
 */
async function withTrigger(sql: string, run: () => Promise<void>): Promise<void> {
    await database.raw(sql);
    try { await run(); } finally { await database.raw('DROP TRIGGER IF EXISTS interleaved'); }
}

const proofRow = (key: string, generation: string) => database('task_execution_lease_stop_proofs')
    .where({ lease_key: key, lease_generation: generation }).first();

describe('spending a stop proof and taking the lease are one transaction', () => {
    test('a failing takeover leaves the proof unspent, so the operation is not stuck for ever', async () => {
        const key = leaseKey();
        const abandoned = randomUUID();
        await acquireExecutionLease(request(key, abandoned));
        await lapseTerm(key);
        await stopProof(key, abandoned);
        await withTrigger(`CREATE TRIGGER interleaved BEFORE UPDATE OF lease_generation ON task_execution_leases
            BEGIN SELECT RAISE(ABORT, 'SQLite refused the takeover'); END`, async () => {
            // A database fault is never turned into a quiet refusal: it propagates, because "the
            // write would not land" is not permission to start a second paid run either.
            await assert.rejects(() => acquireExecutionLease(request(key, randomUUID())), /refused the takeover/);
        });
        assert.equal((await proofRow(key, abandoned)).consumed_at, null,
            'the consumption left with the transaction that could not complete it');
        const successor = randomUUID();
        assert.equal((await acquireExecutionLease(request(key, successor))).outcome, 'acquired',
            'and the proof still admits the successor it was written about');
        assert.ok((await proofRow(key, abandoned)).consumed_at, 'spent, once, by the takeover that landed');
    });

    test('a renewal landing between the two statements refuses the takeover and keeps the proof', async () => {
        const key = leaseKey();
        const suspended = randomUUID();
        await acquireExecutionLease(request(key, suspended));
        await lapseTerm(key);
        await stopProof(key, suspended);
        await withTrigger(`CREATE TRIGGER interleaved AFTER UPDATE OF consumed_at ON task_execution_lease_stop_proofs
            BEGIN UPDATE task_execution_leases SET expires_at = '9999-01-01T00:00:00.000Z'
                WHERE lease_key = NEW.lease_key; END`, async () => {
            const contender = await acquireExecutionLease(request(key, randomUUID()));
            assert.notEqual(contender.outcome, 'acquired',
                'the holder said it was alive after all, so nothing may take its lease');
        });
        assert.equal((await proofRow(key, suspended)).consumed_at, null,
            'and the proof about the suspended generation is still on file, unspent');
        assert.equal((await database('task_execution_leases').where({ lease_key: key }).first()).lease_generation,
            suspended, 'with the prior generation still holding, exactly as before the attempt');
    });

    test('a settlement landing between the two statements refuses the takeover and keeps the proof', async () => {
        const key = leaseKey();
        const holder = randomUUID();
        await acquireExecutionLease(request(key, holder));
        await lapseTerm(key);
        await stopProof(key, holder);
        await withTrigger(`CREATE TRIGGER interleaved AFTER UPDATE OF consumed_at ON task_execution_lease_stop_proofs
            BEGIN UPDATE task_execution_leases SET settled_at = '2026-01-01T00:00:00.000Z',
                settled_state = 'completed' WHERE lease_key = NEW.lease_key; END`, async () => {
            const contender = await acquireExecutionLease(request(key, randomUUID()));
            assert.notEqual(contender.outcome, 'acquired', 'a settled operation is never taken over');
        });
        assert.equal((await proofRow(key, holder)).consumed_at, null);
    });

    test('a proof already on file is reported rather than silently ignored', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        await acquireExecutionLease(request(key, generation));
        await lapseTerm(key);
        assert.equal(await recordExecutorStopProof({ leaseKey: key, generation,
            proof: 'the operator confirmed the container exited', recordedBy: 'operator:test' }), 'recorded');
        assert.equal(await recordExecutorStopProof({ leaseKey: key, generation,
            proof: 'the operator confirmed the container exited', recordedBy: 'operator:other' }), 'already_recorded',
            'two operators recording the same fact must not stack two admissions');
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'acquired');
        assert.equal(await recordExecutorStopProof({ leaseKey: key, generation,
            proof: 'the operator confirmed the container exited', recordedBy: 'operator:test' }), 'already_consumed',
            'and a spent proof says so, instead of leaving "why is this still refused?" unanswerable');
    });
});

describe('a lease is handed back only by an attempt that never reached the provider', () => {
    test('an attempt that reached the provider cannot release, whatever it settled', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        await acquireExecutionLease(request(key, generation));
        const lease = { leaseKey: key, generation, expiresAt: '' };
        assert.equal(await markProviderInvocationStarted(lease), true);
        assert.equal(await releaseExecutionLease(lease), false,
            '"I settled nothing" is not "I spent nothing", and only the second permits a free retry');
        assert.ok(await database('task_execution_leases').where({ lease_key: key }).first());
    });

    test('an attempt that never reached the provider releases at once', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        await acquireExecutionLease(request(key, generation));
        assert.equal(await releaseExecutionLease({ leaseKey: key, generation, expiresAt: '' }), true);
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'acquired');
    });

    test('a retained lease says why it is waiting, and a takeover clears that with it', async () => {
        const key = leaseKey();
        const stranded = randomUUID();
        await acquireExecutionLease(request(key, stranded));
        const lease = { leaseKey: key, generation: stranded, expiresAt: '' };
        await markProviderInvocationStarted(lease);
        assert.equal(await retainLeaseForReconciliation(lease, 'the provider was invoked and nothing came back'), true);
        await lapseTerm(key);
        const lapsed = (await lapsedExecutionLeases()).find(candidate => candidate.leaseKey === key);
        assert.ok(lapsed, 'a lapsed, unsettled lease is listed for reconciliation');
        assert.equal(lapsed.providerInvocationStarted, true,
            'the one fact a reconciliation decision turns on is on the row, not in a lost log');
        assert.equal(lapsed.reconciliationReason, 'the provider was invoked and nothing came back');
        assert.equal(lapsed.stopProof, undefined);

        await stopProof(key, stranded);
        const listed = (await lapsedExecutionLeases()).find(candidate => candidate.leaseKey === key);
        assert.equal(listed?.stopProof?.recordedBy, 'operator:test');
        assert.equal(listed?.stopProof?.consumedAt, undefined,
            'a proof on file but unspent is distinguishable from one already used');
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'acquired');
        const row = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(Boolean(row.provider_invocation_started), false,
            'the successor inherits the term, never the previous holder\'s spending');
        assert.equal(row.reconciliation_reason, null);
    });
});

describe('recording a verified executor stop refuses every mistake the database can see', () => {
    const PROOF = 'docker ps shows no container for this task and the host was drained';

    test('it records a proof about the current, lapsed, unsettled holder', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        await acquireExecutionLease(request(key, generation));
        await lapseTerm(key);
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: key, generation,
            confirmGeneration: generation, proof: PROOF, recordedBy: 'operator:test' }), { recorded: true });
        // It records a fact and nothing else: the lease still moves only through the ordinary
        // atomic takeover, under the ordinary rules.
        const row = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(row.lease_generation, generation);
        assert.equal(row.settled_at, null);
    });

    test('it refuses a live holder, a settled lease, a stale generation and an unconfirmed one', async () => {
        const live = leaseKey();
        const liveGeneration = randomUUID();
        await acquireExecutionLease(request(live, liveGeneration));
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: live, generation: liveGeneration,
            confirmGeneration: liveGeneration, proof: PROOF, recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the term has not lapsed, so the executor is still reporting itself alive' });

        await lapseTerm(live);
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: live, generation: liveGeneration,
            confirmGeneration: randomUUID(), proof: PROOF, recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the confirmation did not match the generation being declared stopped' });
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: live, generation: randomUUID(),
            confirmGeneration: 'mismatched', proof: PROOF, recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the confirmation did not match the generation being declared stopped' });
        const stale = randomUUID();
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: live, generation: stale,
            confirmGeneration: stale, proof: PROOF, recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the named generation no longer holds this lease' });
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: live, generation: liveGeneration,
            confirmGeneration: liveGeneration, proof: 'gone', recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the proof must state what was verified, in the operator\'s own words' });
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: live, generation: liveGeneration,
            confirmGeneration: liveGeneration, proof: PROOF, recordedBy: '  ' }),
        { recorded: false, refusal: 'the proof must state what was verified, in the operator\'s own words' });
        assert.equal(await proofRow(live, liveGeneration), undefined, 'and nothing was written by any of them');

        const settled = leaseKey();
        const settledGeneration = randomUUID();
        await acquireExecutionLease(request(settled, settledGeneration));
        await settleExecutionLease({ leaseKey: settled, generation: settledGeneration, expiresAt: '' }, 'completed');
        await lapseTerm(settled);
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: settled, generation: settledGeneration,
            confirmGeneration: settledGeneration, proof: PROOF, recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the lease is settled and needs no reconciliation' });

        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: leaseKey(), generation: randomUUID(),
            confirmGeneration: 'no', proof: PROOF, recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the confirmation did not match the generation being declared stopped' });
    });

    test('it refuses to stack a second admission on a proof that already exists or is spent', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        await acquireExecutionLease(request(key, generation));
        await lapseTerm(key);
        const declare = () => recordVerifiedExecutorStop({ leaseKey: key, generation,
            confirmGeneration: generation, proof: PROOF, recordedBy: 'operator:test' });
        assert.deepEqual(await declare(), { recorded: true });
        assert.deepEqual(await declare(), { recorded: false, refusal: 'a proof for this generation is already on file' });
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'acquired');
        await lapseTerm(key);
        assert.deepEqual(await declare(), { recorded: false, refusal: 'the named generation no longer holds this lease' });
    });
});

/**
 * A PROOF SAYS "THAT GENERATION STOPPED". A RENEWAL SAYS "THAT GENERATION IS ALIVE".
 *
 * Both were previously allowed to stand at once: a proof recorded against a lapsed term survived
 * the holder waking up and renewing, and waited, unspent, to admit a successor beside an execution
 * that had told the database it was still running. These assert the two statements now exclude
 * each other, whichever arrives first.
 */
describe('a stop proof and the holder\'s own liveness fence each other', () => {
    test('proof recorded, holder renews, term lapses again, successor takes over', async () => {
        const key = leaseKey();
        const holder = randomUUID();
        await acquireExecutionLease(request(key, holder));
        const lease = { leaseKey: key, generation: holder, expiresAt: '' };
        // 1. The term lapses and an operator records that this exact generation stopped.
        await lapseTerm(key);
        await stopProof(key, holder);
        // 2. The holder is not gone after all and tries to extend its term. It loses to the
        //    proof: the renewal matches no row and reports the fence as lost, which is the
        //    existing signal for "stop executing at once".
        assert.equal(await renewExecutionLease(lease, TTL_MS), false,
            'a generation declared stopped may not go on extending its own term');
        const row = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.ok(row.expires_at <= await databaseNow(),
            '3. so the term is still lapsed — the refused renewal changed nothing');
        // 4. The successor is admitted on the proof, exactly once, and the holder that tried to
        //    renew is fenced out for good.
        const successor = randomUUID();
        const takeover = await acquireExecutionLease(request(key, successor));
        assert.equal(takeover.outcome, 'acquired');
        assert.equal(takeover.outcome === 'acquired' ? takeover.takenOverFrom : undefined, holder);
        assert.equal((await proofRow(key, holder)).consumed_at !== null, true, 'the proof is spent');
        assert.equal(await renewExecutionLease(lease, TTL_MS), false);
        assert.equal((await acquireExecutionLease(request(key, randomUUID()))).outcome, 'held',
            'and one proof admits one successor, never a second');
    });

    test('a stop-fenced generation may not mark the provider, so only the successor can be billed', async () => {
        const key = leaseKey();
        const fenced = randomUUID();
        await acquireExecutionLease(request(key, fenced));
        const fencedLease = { leaseKey: key, generation: fenced, expiresAt: '' };
        // 1. The term lapses and an operator records that THIS generation stopped. Nothing has
        //    taken the lease over yet, so the row still names this generation and is still
        //    unsettled — which is all the provider-start gate used to ask about.
        await lapseTerm(key);
        await stopProof(key, fenced);
        // 2. The fenced generation asks for the right to reach the provider. It is refused by the
        //    proof, exactly as its renewal is: a generation somebody has recorded as stopped may
        //    not walk into `agent.analyze` and wait there while the successor below is admitted.
        assert.equal(await markProviderInvocationStarted(fencedLease), false,
            'an unconsumed proof that this generation stopped is a refusal to reach the provider');
        const beforeTakeover = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(Boolean(beforeTakeover.provider_invocation_started), false,
            'and the row does not claim it reached the provider, so reconciliation is told the truth');
        // 3. The successor is admitted on the proof — the order that makes the two executions
        //    concurrent: the fenced attempt would already be inside the provider call by now.
        const successor = randomUUID();
        const takeover = await acquireExecutionLease(request(key, successor));
        assert.equal(takeover.outcome, 'acquired');
        assert.equal(takeover.outcome === 'acquired' ? takeover.takenOverFrom : undefined, fenced);
        // 4. Only the successor may invoke, and the fenced attempt is refused again — now by the
        //    generation itself — so exactly one of the two ever reaches the provider.
        assert.equal(await markProviderInvocationStarted({ leaseKey: key, generation: successor, expiresAt: '' }), true);
        assert.equal(await markProviderInvocationStarted(fencedLease), false);
        const row = await database('task_execution_leases').where({ lease_key: key }).first();
        assert.equal(row.lease_generation, successor);
        assert.equal(Boolean(row.provider_invocation_started), true);
    });

    test('a marker with no proof against it still succeeds, so a live holder is not starved', async () => {
        const key = leaseKey();
        const holder = randomUUID();
        await acquireExecutionLease(request(key, holder));
        // A proof about a DIFFERENT generation of this same lease fences nothing here: the
        // condition names both columns, exactly as the renewal's does.
        await database('task_execution_lease_stop_proofs').insert({
            lease_key: key, lease_generation: randomUUID(), proof: 'about some older generation',
            recorded_by: 'operator:test', recorded_at: await databaseNow(),
            consumed_at: null, consumed_by_generation: null,
        });
        assert.equal(await markProviderInvocationStarted({ leaseKey: key, generation: holder, expiresAt: '' }), true);
    });

    test('a proof is refused outright while the lease says the holder is alive', async () => {
        const key = leaseKey();
        const holder = randomUUID();
        await acquireExecutionLease(request(key, holder));
        // The term has NOT lapsed. The refusal is the INSERT's own `where exists`, not a check
        // this process did a moment earlier: asked at the instant of the write, the database says
        // the holder still holds a live term, and the proof contradicts it.
        assert.equal(await recordExecutorStopProof({ leaseKey: key, generation: holder,
            proof: 'the operator believed the container was gone', recordedBy: 'operator:test' }), 'holder_is_live');
        assert.equal(await database('task_execution_lease_stop_proofs')
            .where({ lease_key: key, lease_generation: holder }).first(), undefined,
            'and nothing is on file to be spent later');
        assert.deepEqual(await recordVerifiedExecutorStop({ leaseKey: key, generation: holder,
            confirmGeneration: holder, proof: 'the operator believed the container was gone',
            recordedBy: 'operator:test' }),
        { recorded: false, refusal: 'the term has not lapsed, so the executor is still reporting itself alive' });
    });

    test('a proof about a settled lease is refused by the same condition', async () => {
        const key = leaseKey();
        const holder = randomUUID();
        await acquireExecutionLease(request(key, holder));
        await lapseTerm(key);
        await settleExecutionLease({ leaseKey: key, generation: holder, expiresAt: '' }, 'completed');
        assert.equal(await recordExecutorStopProof({ leaseKey: key, generation: holder,
            proof: 'the operator confirmed the container exited', recordedBy: 'operator:test' }), 'holder_is_live',
        'a settled operation is finished; nothing about it may be admitted again');
    });

    test('a renewal with no proof against it still succeeds, so a live holder is not starved', async () => {
        const key = leaseKey();
        const holder = randomUUID();
        await acquireExecutionLease(request(key, holder));
        assert.equal(await renewExecutionLease({ leaseKey: key, generation: holder, expiresAt: '' }, TTL_MS), true);
        const other = leaseKey();
        const otherHolder = randomUUID();
        await acquireExecutionLease(request(other, otherHolder));
        await lapseTerm(other);
        await stopProof(other, otherHolder);
        // A proof about a DIFFERENT lease, and about a different generation of this one, fences
        // nothing here: the condition names both columns.
        await database('task_execution_lease_stop_proofs').insert({
            lease_key: key, lease_generation: randomUUID(), proof: 'about some older generation',
            recorded_by: 'operator:test', recorded_at: await databaseNow(),
            consumed_at: null, consumed_by_generation: null,
        });
        assert.equal(await renewExecutionLease({ leaseKey: key, generation: holder, expiresAt: '' }, TTL_MS), true);
    });
});

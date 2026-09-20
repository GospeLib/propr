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

const database: Knex = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
});
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
const {
    acquireExecutionLease, databaseNow, recordExecutorStopProof, releaseExecutionLease,
    renewExecutionLease, settleExecutionLease,
} = await import('../src/utils/executionLease.js');

const TTL_MS = 60_000;
const leaseKey = () => `native-analysis:${randomUUID()}`;

before(async () => { await createExecutionLeases(database); await createStopProofs(database); });
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

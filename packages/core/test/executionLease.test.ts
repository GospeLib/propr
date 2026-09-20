/**
 * The execution lease decides, in the database, which attempt is allowed to spend money.
 *
 * These run against a real SQLite schema built from the migration, because the properties being
 * asserted are properties of the STATEMENTS — `INSERT … ON CONFLICT DO NOTHING` admitting exactly
 * one row, and a conditional `UPDATE` reporting how many rows it actually changed. A hand-written
 * double would assert the test author's model of those statements, which is precisely the thing
 * that must not be assumed.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, mock, test } from 'node:test';
import knex, { type Knex } from 'knex';
import { up as createExecutionLeases } from '../src/db/migrations/20260922000000_create_task_execution_leases.js';

const database: Knex = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
});
await mock.module('../src/db/connection.js', { namedExports: { db: database } });
const {
    acquireExecutionLease, releaseExecutionLease, renewExecutionLease, settleExecutionLease,
} = await import('../src/utils/executionLease.js');

const TTL_MS = 60_000;
const leaseKey = () => `native-analysis:${randomUUID()}`;

before(async () => { await createExecutionLeases(database); });
after(async () => { await database.destroy(); });

function request(key: string, generation: string, overrides: Record<string, unknown> = {}) {
    return { leaseKey: key, taskId: `task-${key.slice(-8)}`, operationId: key, generation, ttlMs: TTL_MS, ...overrides };
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
        // Far beyond the term, but the holder kept heartbeating, so its term has not lapsed.
        assert.equal(await renewExecutionLease({ leaseKey: key, generation: holder, expiresAt: '' }, TTL_MS,
            () => new Date(Date.now() + 10 * TTL_MS)), true);
        const contender = await acquireExecutionLease(request(key, randomUUID(),
            { now: () => new Date(Date.now() + 5 * TTL_MS) }));
        assert.equal(contender.outcome, 'held');
    });

    test('takeover needs a lapsed term, and only one taker can win it', async () => {
        const key = leaseKey();
        const abandoned = randomUUID();
        assert.equal((await acquireExecutionLease(request(key, abandoned, { ttlMs: 0 }))).outcome, 'acquired');
        const later = () => new Date(Date.now() + TTL_MS);
        const takers = await Promise.all([randomUUID(), randomUUID()]
            .map(generation => acquireExecutionLease(request(key, generation, { now: later }))));
        const winners = takers.filter(outcome => outcome.outcome === 'acquired');
        assert.equal(winners.length, 1, 'a conditional update naming the observed generation has one winner');
        assert.equal((winners[0] as { takenOverFrom?: string }).takenOverFrom, abandoned);
        assert.equal(takers.filter(outcome => outcome.outcome === 'held').length, 1);
    });

    test('a settled operation is never leased again, expiry or not', async () => {
        const key = leaseKey();
        const generation = randomUUID();
        const acquired = await acquireExecutionLease(request(key, generation, { ttlMs: 0 }));
        assert.equal(acquired.outcome, 'acquired');
        assert.equal(await settleExecutionLease({ leaseKey: key, generation, expiresAt: '' }, 'completed'), true);
        const retry = await acquireExecutionLease(request(key, randomUUID(), { now: () => new Date(Date.now() + TTL_MS) }));
        assert.equal(retry.outcome, 'settled', 'an expired lease over a settled operation is still not executable');
        assert.equal((retry as { settledState: string }).settledState, 'completed');
    });

    test('a fenced-out attempt can neither renew, settle nor release the lease that superseded it', async () => {
        const key = leaseKey();
        const stale = randomUUID();
        await acquireExecutionLease(request(key, stale, { ttlMs: 0 }));
        const successor = randomUUID();
        assert.equal((await acquireExecutionLease(request(key, successor, { now: () => new Date(Date.now() + TTL_MS) }))).outcome,
            'acquired');
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
            'a crashed attempt that settled nothing must not become a permanent refusal');
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
});

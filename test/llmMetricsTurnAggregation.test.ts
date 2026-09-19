import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateAggregatedMetrics, getTotalMetrics, getModelMetrics, checkCostThreshold } from '../packages/core/src/utils/llmMetrics.js';

// Regression coverage for the P2 finding: aggregated turn averages used to divide the
// turn sum by every request (`numTurns ?? 0`), so unknown-turn executions silently
// pulled the average down. The fix tracks a separate known-turn-evidence count and
// divides only by that.

/** Minimal in-memory stand-in for the subset of the ioredis client these functions use. */
class FakeRedis {
    private store = new Map<string, string>();
    private sets = new Map<string, Set<string>>();
    private lists = new Map<string, string[]>();

    async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
    async set(key: string, value: string): Promise<'OK'> { this.store.set(key, value); return 'OK'; }
    async incr(key: string): Promise<number> {
        const next = (parseInt(this.store.get(key) ?? '0', 10)) + 1;
        this.store.set(key, String(next));
        return next;
    }
    async sadd(key: string, member: string): Promise<number> {
        const set = this.sets.get(key) ?? new Set<string>();
        const added = set.has(member) ? 0 : 1;
        set.add(member);
        this.sets.set(key, set);
        return added;
    }
    async smembers(key: string): Promise<string[]> { return Array.from(this.sets.get(key) ?? []); }
    async lpush(key: string, value: string): Promise<number> {
        const list = this.lists.get(key) ?? [];
        list.unshift(value);
        this.lists.set(key, list);
        return list.length;
    }
    async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
        const list = this.lists.get(key) ?? [];
        this.lists.set(key, list.slice(start, stop + 1));
        return 'OK';
    }
    async lrange(key: string, start: number, stop: number): Promise<string[]> {
        const list = this.lists.get(key) ?? [];
        return list.slice(start, stop === -1 ? undefined : stop + 1);
    }
}

function fakeRedis() {
    // updateAggregatedMetrics/getTotalMetrics/getModelMetrics only exercise the subset
    // implemented above; cast past the full ioredis surface.
    return new FakeRedis() as unknown as Parameters<typeof updateAggregatedMetrics>[0];
}

test('an unknown turn count is excluded from both the turn sum and its divisor', async () => {
    const redis = fakeRedis();
    const dateKey = '2026-09-19';
    await updateAggregatedMetrics(redis, { model: 'claude-x', success: true, costUsd: 1, numTurns: 10, executionTimeMs: 1000, dateKey });
    await updateAggregatedMetrics(redis, { model: 'claude-x', success: true, costUsd: 1, numTurns: undefined, executionTimeMs: 1000, dateKey });
    await updateAggregatedMetrics(redis, { model: 'claude-x', success: true, costUsd: 1, numTurns: 20, executionTimeMs: 1000, dateKey });

    const summary = await getTotalMetrics(redis);
    // Naive `numTurns ?? 0` would average (10+0+20)/3 = 10. The unknown run must not
    // count toward the divisor: the true average of the two known runs is 15.
    assert.equal(summary.totalRequests, 3);
    assert.equal(summary.totalTurns, 30);
    assert.equal(summary.avgTurnsPerRequest, 15);

    const modelBreakdown = await getModelMetrics(redis);
    assert.equal(modelBreakdown['claude-x'].totalTurns, 30);
    assert.equal(modelBreakdown['claude-x'].avgTurnsPerRequest, 15);
});

test('every execution having an unknown turn count never divides by zero', async () => {
    const redis = fakeRedis();
    const dateKey = '2026-09-19';
    await updateAggregatedMetrics(redis, { model: 'claude-y', success: false, costUsd: 0, numTurns: undefined, executionTimeMs: 500, dateKey });

    const summary = await getTotalMetrics(redis);
    assert.equal(summary.totalTurns, 0);
    assert.equal(summary.avgTurnsPerRequest, 0);
});

test('a high-cost alert omits numTurns rather than reporting a fabricated 0', async () => {
    const redis = fakeRedis();
    process.env.LLM_COST_THRESHOLD_USD = '1.00';
    try {
        await checkCostThreshold(redis, { timestamp: '2026-09-19T00:00:00.000Z', costUsd: 5, model: 'claude-x', numTurns: undefined },
            { number: 1, repoOwner: 'o', repoName: 'r' });
        const stored = await redis.lrange('llm:metrics:alerts:highcost', 0, -1);
        const alert = JSON.parse(stored[0]);
        assert.equal('numTurns' in alert, false);
    } finally {
        delete process.env.LLM_COST_THRESHOLD_USD;
    }
});

test('legacy turn aggregates written without a known-turn count never distort the new average', async () => {
    const redis = fakeRedis();
    const dateKey = '2026-09-19';
    // A deployment upgraded from the pre-versioned writer: nonzero legacy turn sums and
    // request counts, and no known-turn count at all.
    await redis.set('llm:metrics:total:successful', '50');
    await redis.set('llm:metrics:total:turns', '500');
    await redis.sadd('llm:metrics:models:used', 'claude-legacy');
    await redis.set('llm:metrics:model:claude-legacy:successful', '50');
    await redis.set('llm:metrics:model:claude-legacy:turns', '500');

    // Before any new evidence the average is unknown (0), not the legacy sum over nothing.
    assert.equal((await getTotalMetrics(redis)).avgTurnsPerRequest, 0);

    await updateAggregatedMetrics(redis, { model: 'claude-legacy', success: true, costUsd: 1, numTurns: 10, executionTimeMs: 1000, dateKey });

    // One known run of 10 turns: the average is 10, never (500 + 10) / 1 = 510.
    const summary = await getTotalMetrics(redis);
    assert.equal(summary.avgTurnsPerRequest, 10);
    assert.equal(summary.totalTurns, 510);
    const model = (await getModelMetrics(redis))['claude-legacy'];
    assert.equal(model.avgTurnsPerRequest, 10);
    assert.equal(model.totalTurns, 510);
});

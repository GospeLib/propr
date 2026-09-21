import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateFailedMetrics } from '../packages/core/src/queue/taskQueue.metrics.js';

// Regression coverage for the P2 finding: a failed job used to serialize `turns: 0` with
// no provider evidence backing it. Only a proven zero-turn run may ever report 0; a bare
// job failure (no claudeResult) has no such evidence and must omit the field entirely.

class FakeRedis {
    private zsets = new Map<string, Array<{ score: number; member: string }>>();
    private store = new Map<string, string>();

    async incr(key: string): Promise<number> {
        const next = (parseInt(this.store.get(key) ?? '0', 10)) + 1;
        this.store.set(key, String(next));
        return next;
    }
    async zadd(key: string, score: number, member: string): Promise<number> {
        const list = this.zsets.get(key) ?? [];
        list.push({ score, member });
        this.zsets.set(key, list);
        return 1;
    }
    lastMember(key: string): string | undefined {
        const list = this.zsets.get(key) ?? [];
        return list.at(-1)?.member;
    }
}

test('updateFailedMetrics omits turns when there is no claudeResult evidence', async () => {
    const redis = new FakeRedis() as unknown as Parameters<typeof updateFailedMetrics>[0];
    const job = {
        timestamp: 1000,
        finishedOn: 2000,
        data: { modelName: 'claude-x', correlationId: 'corr-1', number: 7 },
    } as unknown as Parameters<typeof updateFailedMetrics>[1];

    await updateFailedMetrics(redis, job, new Error('boom'), 'owner/repo');

    const stored = JSON.parse((redis as unknown as FakeRedis).lastMember('metrics:ai:log:v1') ?? '{}');
    assert.equal('turns' in stored, false, 'turns must be absent, never a fabricated 0');
    assert.equal(stored.status, 'failed');
    assert.equal(stored.model, 'claude-x');
});

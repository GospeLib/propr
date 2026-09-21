import type { StopTaskQueue, StopTaskRedisClient } from '../routes/dockerRoutes.js';

interface FakeRedisCall { method: string; key: string; value?: string }
export function makeFakeRedis(initial: Record<string, string> = {}): StopTaskRedisClient & { store: Map<string, string>; calls: FakeRedisCall[] } {
  const store = new Map(Object.entries(initial));
  const calls: FakeRedisCall[] = [];
  return {
    store, calls,
    async get(key) { calls.push({ method: 'get', key }); return store.get(key) ?? null; },
    async set(key, value) { calls.push({ method: 'set', key, value }); store.set(key, value); return 'OK'; },
    async rPush(key, value) { calls.push({ method: 'rPush', key, value }); return 1; },
    async del(key) { calls.push({ method: 'del', key }); store.delete(key); return 1; },
    async eval(_script, options) {
      const [stateKey, markerKey] = options.keys;
      const [expected, , marker] = options.arguments;
      if (store.get(stateKey) !== expected) return 0;
      if (options.keys.length === 1) { store.delete(stateKey); calls.push({ method: 'del', key: stateKey }); return 1; }
      store.set(markerKey, marker); calls.push({ method: 'eval', key: markerKey, value: marker }); return 1;
    },
  };
}

export function makeFakeQueue(
  pendingJobs: Array<{ id: string; data?: Record<string, unknown> }>,
  activeJobs: Array<{ id: string; data?: Record<string, unknown> }> = [],
): StopTaskQueue & { removed: string[] } {
  const removed: string[] = [];
  return { removed, async getJobs(states) {
    const jobs = states.includes('active') ? activeJobs : pendingJobs;
    return jobs.map(job => ({ id: job.id, data: 'data' in job ? job.data : undefined,
      remove: async () => { removed.push(job.id); } }));
  } };
}

import type { AgentRegistryOperationalStatus } from '@propr/core';

const WORKER_STATUS_TTL_SECONDS = 90;
export const WORKER_HEALTH_PREFIX = 'system:status:worker:';

type AgentImageStatus = AgentRegistryOperationalStatus['unifiedAgentImage'];
interface HealthWorker {
    isPaused(): boolean;
    pause(doNotWaitActive?: boolean): Promise<void>;
    resume(): void;
}
interface HealthRedis {
    sadd(key: string, member: string): Promise<unknown>;
    expire(key: string, seconds: number): Promise<unknown>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** Publish worker-owned health; API registry state may belong to a different daemon. */
export async function publishWorkerAgentHealth(options: {
    workerId: string;
    redis: HealthRedis;
    image: AgentImageStatus;
    worker?: HealthWorker;
}): Promise<void> {
    const { workerId, redis, image, worker } = options;
    const canExecute = image.status === 'ready' || Boolean(image.fallbackImage);
    if (worker) {
        if (!canExecute && !worker.isPaused()) await worker.pause(true);
        else if (canExecute && worker.isPaused()) worker.resume();
    }
    await redis.set(`${WORKER_HEALTH_PREFIX}${workerId}`, JSON.stringify({
        workerId,
        status: image.status === 'ready' ? 'running' : 'degraded',
        canExecute,
        unifiedAgentImage: image,
    }), 'EX', WORKER_STATUS_TTL_SECONDS);
    await redis.sadd('system:status:workers', workerId);
    await redis.expire('system:status:workers', WORKER_STATUS_TTL_SECONDS);
}

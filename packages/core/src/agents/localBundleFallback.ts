import { executeDockerCommand } from '../claude/docker/dockerExecutor.js';
import logger from '../utils/logger.js';

const DOCKER_LOOKUP_TIMEOUT_MS = 10_000;

/** Same repository and CLI matrix only; never use latest, an overlay, or another family. */
export async function findLocalBundleFallback(imageTag: string): Promise<string | undefined> {
    const match = /^(.*:bundle-[a-f0-9]{12}-)[a-f0-9]{6}$/.exec(imageTag);
    if (!match) return undefined;
    const prefix = match[1];
    try {
        const listed = await executeDockerCommand('docker', [
            'image', 'ls', '--filter', `reference=${prefix}*`, '--format', '{{.Repository}}:{{.Tag}}',
        ], { timeout: DOCKER_LOOKUP_TIMEOUT_MS });
        if (listed.exitCode !== 0) return undefined;
        const tags = listed.stdout.trim().split(/\s+/).filter(tag => tag.startsWith(prefix) && /^[a-f0-9]{6}$/.test(tag.slice(prefix.length)) && tag !== imageTag);
        if (!tags.length) return undefined;
        const inspected = await executeDockerCommand('docker', ['image', 'inspect', ...tags], { timeout: DOCKER_LOOKUP_TIMEOUT_MS });
        if (inspected.exitCode !== 0) return undefined;
        const images = JSON.parse(inspected.stdout) as Array<{ Created: string; RepoTags?: string[] }>;
        return images.filter(image => Number.isFinite(Date.parse(image.Created)))
            .sort((left, right) => Date.parse(right.Created) - Date.parse(left.Created))
            .flatMap(image => (image.RepoTags ?? []).filter(tag => tags.includes(tag)))[0];
    } catch (error) {
        logger.warn({ imageTag, error: (error as Error).message }, 'Local agent bundle fallback lookup failed');
        return undefined;
    }
}

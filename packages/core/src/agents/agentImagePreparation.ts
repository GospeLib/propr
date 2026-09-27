import { findLocalBundleFallback } from './localBundleFallback.js';
import logger from '../utils/logger.js';
import os from 'node:os';
import path from 'node:path';
import { AGENT_DEFAULTS } from '../config/modelDefinitions.js';
import {
    agentDockerImageExists,
    ensureAgentBundleImage,
    ensureAgentDockerImage,
} from '../claude/docker/dockerExecutor.js';
import { resolveAgentRuntimeImage } from './runtime/agentRuntimePackages.js';
import type { AgentConfig } from './types.js';
import { AGENT_DEFAULT_VERSIONS } from './version/types.js';
import {
    computeContentHash,
    generateAgentBundleImageTag,
    getAgentCliVersionMatrix,
} from './version/versionService.js';

export interface AgentImageResolution {
    image?: string;
    imageTag?: string;
    error?: string;
    fallbackImage?: string;
}

/** Prepare one coherent replacement without racing runtime-package state saves. */
export async function resolveInstalledAgentImages(
    installed: ReadonlyMap<string, string>,
    prepareImages: boolean,
): Promise<{ images: Map<string, string> } | { images?: never; imageTag: string; error: string }> {
    const images = new Map<string, string>();
    for (const [id, imageTag] of installed) {
        try {
            images.set(id, await resolveAgentRuntimeImage(imageTag, { buildMissing: prepareImages }));
        } catch (error) {
            return { imageTag, error: (error as Error).message };
        }
    }
    return { images };
}

async function resolveBundleBaseImage(
    configs: AgentConfig[],
    prepareImages: boolean,
): Promise<AgentImageResolution> {
    const versions = getAgentCliVersionMatrix(configs);
    const contentHash = computeContentHash();
    const imageTag = generateAgentBundleImageTag(versions, contentHash);
    const result = prepareImages
        ? await ensureAgentBundleImage(versions, contentHash)
        : { success: await agentDockerImageExists(imageTag), imageTag, error: 'Image has not been prepared by the worker' };
    if (result.success) return { image: imageTag, imageTag };
    const error = result.error || 'Unified agent image is unavailable';
    const fallbackImage = await findLocalBundleFallback(imageTag);
    if (fallbackImage) {
        logger.warn({ imageTag, fallbackImage, error }, 'Using newest local bundle from the same CLI family; agent runtime is degraded');
        return { image: fallbackImage, imageTag, fallbackImage, error };
    }
    return { imageTag, error };
}

export async function resolveUnifiedAgentImage(
    configs: AgentConfig[],
    prepareImages: boolean,
): Promise<AgentImageResolution> {
    try {
        const base = await resolveBundleBaseImage(configs, prepareImages);
        if (!base.image) return base;
        return {
            image: await resolveAgentRuntimeImage(base.image, { buildMissing: prepareImages }),
            imageTag: base.imageTag,
            fallbackImage: base.fallbackImage,
            error: base.error,
        };
    } catch (error) {
        return { error: (error as Error).message };
    }
}

async function resolveConfiguredDefaultImage(
    dockerImage: string,
    prepareImages: boolean,
): Promise<AgentImageResolution> {
    const available = prepareImages
        ? await ensureAgentDockerImage('claude', dockerImage)
        : await agentDockerImageExists(dockerImage);
    if (!available) {
        return {
            imageTag: dockerImage,
            error: prepareImages
                ? 'Configured default agent image could not be pulled or built'
                : 'Configured default agent image has not been prepared by the worker',
        };
    }
    return {
        image: await resolveAgentRuntimeImage(dockerImage, { buildMissing: prepareImages }),
        imageTag: dockerImage,
    };
}

export async function resolveDefaultAgentConfig(
    prepareImages: boolean,
): Promise<AgentImageResolution & { config?: AgentConfig }> {
    const configuredImage = process.env.AGENT_DOCKER_IMAGE;
    let resolution: AgentImageResolution;
    try {
        resolution = configuredImage
            ? await resolveConfiguredDefaultImage(configuredImage, prepareImages)
            : await resolveUnifiedAgentImage([], prepareImages);
    } catch (error) {
        return { imageTag: configuredImage, error: (error as Error).message };
    }
    if (!resolution.image) return resolution;

    return {
        config: {
            id: 'default-claude-agent',
            type: 'claude',
            alias: 'default',
            enabled: true,
            dockerImage: resolution.image,
            configPath: process.env.CLAUDE_CONFIG_PATH || path.join(os.homedir(), '.claude'),
            supportedModels: [...AGENT_DEFAULTS.claude.defaultModels],
            defaultModel: process.env.CLAUDE_MODEL || undefined,
            cliVersionType: 'default',
            cliVersionResolved: AGENT_DEFAULT_VERSIONS.claude,
        },
        imageTag: resolution.imageTag,
        fallbackImage: resolution.fallbackImage,
        error: resolution.error,
    };
}

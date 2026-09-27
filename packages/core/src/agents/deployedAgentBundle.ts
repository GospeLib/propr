import crypto from 'node:crypto';
import type { AgentType } from './types.js';

interface DeployedAgentBundle {
    versions: Record<AgentType, string>;
    contentHash: string;
    tag: string;
    repository: string;
}

// Captured once from the app image, never resolved from a network registry.
function readDeployedBundle(): DeployedAgentBundle | undefined {
    const raw = process.env.PROPR_AGENT_BUNDLE_METADATA;
    if (!raw) return undefined; // Source checkouts use the checked-in defaults.
    const bundle = JSON.parse(raw) as DeployedAgentBundle;
    const types: AgentType[] = ['claude', 'codex', 'antigravity', 'opencode', 'vibe'];
    if (!/^[a-f0-9]{6}$/.test(bundle.contentHash)
        || !/^bundle-[a-f0-9]{12}-[a-f0-9]{6}$/.test(bundle.tag)
        || !/^[a-z0-9][a-z0-9._/:-]*$/.test(bundle.repository)
        || types.some(type => !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(bundle.versions?.[type]))) {
        throw new Error('Invalid pinned agent bundle metadata; rebuild the app and agent with scripts/build-images.sh');
    }
    const hash = crypto.createHash('sha256').update(types.map(type => `${type}=${bundle.versions[type]}`).join('\n')).digest('hex').slice(0, 12);
    if (bundle.tag !== `bundle-${hash}-${bundle.contentHash}`) throw new Error('Pinned agent bundle tag does not match its version/content metadata');
    return bundle;
}

export const deployedAgentBundle = readDeployedBundle();

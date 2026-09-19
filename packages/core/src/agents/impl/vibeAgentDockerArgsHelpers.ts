/**
 * Docker-arg helpers extracted from VibeAgent to keep the class file under the repo's
 * file-size cap (INV-4). Behaviour-preserving split: parameterized on the config fields
 * each function needs instead of reading `this` directly.
 */
import logger from '../../utils/logger.js';
import {
    getForwardedVibeEnvVars,
    splitVibeCliArgs,
    getDefaultVibeCliArgs,
    resolveHostBindPath,
    hasUsableVibeConfigDir,
    hasStructuredOutputArg,
} from './utils/vibeAgentHelpers.js';
import { buildVibeRepositoryScoutConfig } from './utils/repositoryScoutMcpServer.js';
import { resolveConfigPath } from '../../config/configManager.js';

export const VIBE_CONTAINER_CONFIG_PATH = '/home/node/.vibe';

export function getVibeCliArgs(agentAlias: string, envVars: Record<string, string> | undefined): string[] {
    const processArgs = process.env.VIBE_CLI_ARGS;
    const configuredArgs = processArgs ?? envVars?.VIBE_CLI_ARGS;
    const source = processArgs !== undefined ? 'process.env.VIBE_CLI_ARGS' : 'config.envVars.VIBE_CLI_ARGS';
    let args: string[];
    if (!configuredArgs?.trim()) {
        args = getDefaultVibeCliArgs();
    } else {
        try { args = splitVibeCliArgs(configuredArgs); } catch (error) { throw new Error(`Invalid ${source}: ${(error as Error).message}`); }
        if (args.length === 0) {
            args = getDefaultVibeCliArgs();
        } else if (!hasStructuredOutputArg(args)) {
            const allowNoJson = process.env.VIBE_ALLOW_UNSTRUCTURED === '1' || envVars?.VIBE_ALLOW_UNSTRUCTURED === '1';
            if (!allowNoJson) {
                throw new Error(`${source} does not include --output json. Structured output is required. Add --output json or set VIBE_ALLOW_UNSTRUCTURED=1 to override.`);
            }
            logger.warn({ source, args }, 'VIBE_CLI_ARGS override does not include --output json; structured output parsing may degrade');
        }
    }
    return args;
}

export function buildVibeDockerEnvVars(agentAlias: string, params: { envVars: Record<string, string> | undefined; cleanModelName?: string; mode: 'execute' | 'analysis'; maxTurns: number; runtimeHomePath?: string; repositoryInspection?: boolean }): string[] {
    const { envVars, cleanModelName, mode, maxTurns, runtimeHomePath, repositoryInspection = false } = params;
    const forwardedEnvVars = getForwardedVibeEnvVars(envVars, repositoryInspection);
    for (const envVar of forwardedEnvVars.skipped) logger.warn({ agentAlias, envVar }, 'Skipping invalid Vibe Docker environment variable');
    const dockerEnvArgs = forwardedEnvVars.dockerArgs;
    dockerEnvArgs.push('-e', 'PROPR_AGENT_TYPE=vibe');
    if (cleanModelName) dockerEnvArgs.push('-e', `VIBE_ACTIVE_MODEL=${cleanModelName}`);
    dockerEnvArgs.push('-e', 'VIBE_SOURCE_HOME=/home/node/.vibe');
    if (runtimeHomePath) dockerEnvArgs.push('-e', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home', '-e', 'HOME=/tmp/propr-vibe-home');
    if (mode === 'analysis') {
        const analysisDirs = ['VIBE_READ_ONLY_CONFIG=1', 'XDG_CACHE_HOME=/tmp/propr-vibe-cache', 'XDG_CONFIG_HOME=/tmp/propr-vibe-config', 'XDG_DATA_HOME=/tmp/propr-vibe-data', 'UV_CACHE_DIR=/tmp/propr-uv-cache', 'HOME=/tmp/propr-vibe-home', 'VIBE_RUNTIME_HOME=/tmp/propr-vibe-home', 'XDG_STATE_HOME=/tmp/propr-vibe-state', 'PIP_CACHE_DIR=/tmp/propr-pip-cache', 'PYTHONPYCACHEPREFIX=/tmp/propr-python-cache'];
        for (const dir of analysisDirs) dockerEnvArgs.push('-e', dir);
    }
    if (repositoryInspection) {
        dockerEnvArgs.push('-e', 'PROPR_REPOSITORY_INSPECTION=1');
        dockerEnvArgs.push('-e', `PROPR_REPOSITORY_SCOUT_VIBE_CONFIG=${buildVibeRepositoryScoutConfig()}`);
    }
    dockerEnvArgs.push('-e', `VIBE_MAX_TURNS=${maxTurns}`);
    return dockerEnvArgs;
}

export function resolveVibeCredentialsAndConfig(agentAlias: string, configPathOverride: string, mistralApiKey?: string, envVars?: Record<string, string>): { configPath: string; resolvedApiKey: string | undefined; hasUsableConfig: boolean; configMountArgs: string[] } {
    const configPath = resolveConfigPath(process.env.VIBE_CONFIG_PATH || configPathOverride);
    const resolvedApiKey = mistralApiKey || process.env.MISTRAL_API_KEY?.trim() || envVars?.MISTRAL_API_KEY?.trim();
    const hasUsableConfig = hasUsableVibeConfigDir(configPath, resolvedApiKey);
    if (!resolvedApiKey && !hasUsableConfig) throw new Error(`Vibe agent "${agentAlias}" has no credentials. Set MISTRAL_API_KEY or ensure ${configPath} contains valid Vibe config files.`);
    return { configPath, resolvedApiKey, hasUsableConfig, configMountArgs: hasUsableConfig ? ['-v', `${configPath}:${VIBE_CONTAINER_CONFIG_PATH}:ro`] : [] };
}

export function buildVibePromptMountArgs(promptFilePath: string | undefined, cliArgs: string[]): string[] {
    if (!promptFilePath) return [];
    const hostPromptPath = resolveHostBindPath(promptFilePath);
    const containerPromptPath = '/home/node/propr-prompt.txt';
    cliArgs.push('--prompt-file', containerPromptPath);
    return ['-v', `${hostPromptPath}:${containerPromptPath}:ro`];
}

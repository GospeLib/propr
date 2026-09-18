import type { ClaudeOutput } from './claudeOutputParser.js';
export { parseStreamJsonOutput, UsageLimitError } from './claudeOutputParser.js';
export type { ClaudeOutput, ClaudeOutputResult, ConversationLogEntry, TokenUsage } from './claudeOutputParser.js';
import path from 'path';
import fs from 'fs';
import { Redis } from 'ioredis';
import logger from '../utils/logger.js';
import { generateClaudePrompt, IssueRef, IssueDetails } from './prompts/promptGenerator.js';
import { executeDockerCommand } from './docker/dockerExecutor.js';
import { wrapDockerRunArgsWithRepoSetup } from './docker/repoSetupWrapper.js';
import { createContainerExecutionId } from '../agents/impl/utils/containerExecutionId.js';

const CLAUDE_RUNTIME_HOME = '/home/node/runtime-home';

export interface BuildClaudePromptOptions {
    customPrompt?: string;
    issueRef: IssueRef;
    branchName?: string;
    modelName?: string;
    issueDetails?: IssueDetails;
    baseBranch?: string;
    isRetry?: boolean;
    retryReason?: string;
}

export interface DockerArgsParams {
    worktreePath: string;
    githubToken: string;
    prompt: string;
    promptFilePath?: string;
    modelName?: string;
    issueNumber: number;
    CLAUDE_DOCKER_IMAGE: string;
    CLAUDE_CONFIG_PATH: string;
    CLAUDE_MAX_TURNS: number;
    systemPrompt?: string;
    tools?: string;
    taskId?: string;
    agentAlias?: string;
}

export interface StorePromptOptions {
    claudeOutput: ClaudeOutput;
    prompt: string;
    issueRef: IssueRef;
    model: string;
    isRetry?: boolean;
    retryReason?: string;
}

export function buildClaudePrompt(options: BuildClaudePromptOptions): string {
    const { customPrompt, issueRef, branchName, modelName, issueDetails, baseBranch, isRetry, retryReason } = options;
    const basePrompt = customPrompt || generateClaudePrompt({
        issueRef,
        branchName: branchName ?? null,
        modelName: modelName ?? null,
        issueDetails: issueDetails ?? null,
        baseBranch: baseBranch ?? null
    });
    const prompt = `${basePrompt}

**CRITICAL GIT SAFETY RULES:**
- NEVER run 'rm .git' or delete the .git file/directory
- NEVER run 'git init' in the workspace - this is already a git repository
- If you encounter git errors, report them but DO NOT attempt to reinitialize the repository
- The workspace is a git worktree linked to the main repository
- Only make changes to the specific files mentioned in the issue/request
- If git commands fail, describe the error but do not try destructive recovery methods
- NOTE: You may encounter permission errors when trying to commit - this is expected
- The system will automatically commit your changes after you complete the modifications`;

    logger.debug({
        issueNumber: issueRef.number,
        promptLength: prompt.length,
        hasSafetyRules: prompt.includes('CRITICAL GIT SAFETY RULES'),
        isCustomPrompt: !!customPrompt
    }, 'Generated Claude prompt with safety rules');

    if (isRetry) {
        logger.info({ issueNumber: issueRef.number, retryReason, promptLength: prompt.length }, 'Using enhanced prompt for retry execution');
    }

    return prompt;
}

export async function setWorktreeOwnership(
    worktreePath: string, issueNumber: number,
    owner: { uid: number; gid: number } = { uid: 1000, gid: 1000 },
): Promise<void> {
    try {
        await executeDockerCommand('sudo', ['chown', '-R', `${owner.uid}:${owner.gid}`, worktreePath], { timeout: 10000 });
        logger.debug({ issueNumber, worktreePath, ...owner }, 'Set worktree ownership to the container runtime owner');
    } catch (chownError) {
        const error = chownError as Error;
        logger.warn({ issueNumber, worktreePath, error: error.message }, 'Failed to set worktree ownership - container may have permission issues');
    }
}

export function verifyWorktreeStructure(worktreePath: string, issueNumber: number): string | null {
    const worktreeGitPath = path.join(worktreePath, '.git');
    let worktreeGitContent: string | null = null;

    try {
        if (!fs.existsSync(worktreeGitPath)) {
            logger.warn({ issueNumber, worktreeGitPath }, 'Worktree .git file not found - this may cause issues');
            return null;
        }

        const stats = fs.statSync(worktreeGitPath);
        if (!stats.isFile()) {
            logger.error({ issueNumber, worktreeGitPath, isDirectory: stats.isDirectory() }, 'CRITICAL: Worktree .git is a directory, not a file!');
            return null;
        }

        worktreeGitContent = fs.readFileSync(worktreeGitPath, 'utf8').trim();
        const gitdirMatch = worktreeGitContent.match(/gitdir:\s*(.+)/);
        const mainRepoPath = gitdirMatch ? gitdirMatch[1].trim() : null;

        logger.debug({
            issueNumber,
            worktreeGitPath,
            worktreeGitContent,
            mainRepoPath,
            mainRepoExists: mainRepoPath ? fs.existsSync(mainRepoPath) : false
        }, 'Verified worktree .git file structure');
    } catch (verifyError) {
        const error = verifyError as Error;
        logger.error({ issueNumber, error: error.message }, 'Failed to verify worktree structure');
    }

    return worktreeGitContent;
}

export function verifyWorktreePostExecution(
    worktreePath: string,
    issueNumber: number,
    worktreeGitContent: string | null
): void {
    try {
        const postExecGitPath = path.join(worktreePath, '.git');
        if (!fs.existsSync(postExecGitPath)) return;

        const postStats = fs.statSync(postExecGitPath);
        if (postStats.isDirectory()) {
            logger.error({
                issueNumber,
                worktreePath,
                preExecType: worktreeGitContent ? 'file' : 'unknown',
                postExecType: 'directory'
            }, 'CRITICAL: Worktree .git was converted from file to directory!');

            const gitConfigPath = path.join(postExecGitPath, 'config');
            if (fs.existsSync(gitConfigPath)) {
                const gitConfig = fs.readFileSync(gitConfigPath, 'utf8');
                logger.error({ issueNumber, gitConfigPreview: gitConfig.substring(0, 200) }, 'Found git config - git init was run');
            }
            return;
        }

        const postContent = fs.readFileSync(postExecGitPath, 'utf8').trim();
        if (postContent !== worktreeGitContent) {
            logger.warn({ issueNumber, preContent: worktreeGitContent, postContent }, 'Worktree .git file content changed during execution');
        }
    } catch (postVerifyError) {
        const error = postVerifyError as Error;
        logger.error({ issueNumber, error: error.message }, 'Failed to verify worktree state after execution');
    }
}

export function buildDockerArgs(params: DockerArgsParams): string[] {
    const { worktreePath, githubToken, modelName, issueNumber, CLAUDE_DOCKER_IMAGE, CLAUDE_CONFIG_PATH, CLAUDE_MAX_TURNS, systemPrompt, tools, taskId, agentAlias } = params;

    // Generate human-readable container name with unique suffix
    // TaskId format: {repo}-{issue}-{agent}-{model}-{correlationId}
    // Use the LAST 8 chars of taskId (part of correlationId UUID) for uniqueness
    const shortId = createContainerExecutionId(taskId);
    const containerName = `${agentAlias || 'claude'}-issue-${issueNumber}-${shortId}`;

    // Always use stdin for prompt to avoid E2BIG errors with large prompts
    const dockerArgs: string[] = [
        'run', '--rm',
        '-i', // Allow stdin for piping prompt
        '--name', containerName,
        '--security-opt', 'no-new-privileges',
        '--cap-add', 'CHOWN',
        '--network', 'bridge',
        '--user', '0:0',
        '-v', `${worktreePath}:/home/node/workspace:rw`,
        '-v', '/tmp/git-processor:/tmp/git-processor:rw',
        '-v', '/tmp/claude-logs:/tmp/claude-logs:rw',
        '-v', `${CLAUDE_CONFIG_PATH}:/home/node/.claude:rw`,
        ...(fs.existsSync(path.join(CLAUDE_CONFIG_PATH, 'home', '.claude.json'))
            ? [
                '-v', `${path.join(CLAUDE_CONFIG_PATH, 'home')}:${CLAUDE_RUNTIME_HOME}:rw`,
                '-v', `${CLAUDE_CONFIG_PATH}:${CLAUDE_RUNTIME_HOME}/.claude:rw`,
                '-e', `PROPR_CLAUDE_HOME=${CLAUDE_RUNTIME_HOME}`,
            ]
            : []),
        '-e', `GH_TOKEN=${githubToken}`,
        '-w', '/home/node/workspace',
        CLAUDE_DOCKER_IMAGE,
        'claude', '-p', '-', // Read prompt from stdin
        '--no-session-persistence',
        '--max-turns', CLAUDE_MAX_TURNS.toString(),
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions'
    ];

    if (modelName) {
        const maxTurnsIndex = dockerArgs.indexOf('--max-turns');
        dockerArgs.splice(maxTurnsIndex, 0, '--model', modelName);
        logger.info({ issueNumber, requestedModel: modelName }, 'Using specific model for Claude Code execution');
    } else {
        logger.debug({ issueNumber }, 'No model specified, Claude Code will use default');
    }

    if (systemPrompt !== undefined) {
        dockerArgs.push('--system-prompt', systemPrompt);
        logger.info({ issueNumber, systemPromptLength: systemPrompt.length }, 'Using custom system prompt');
    }

    if (tools !== undefined) {
        dockerArgs.push('--tools', tools);
        logger.info({ issueNumber, tools }, 'Using custom tools configuration');
    }

    logger.info({ issueNumber, hasSystemPrompt: systemPrompt !== undefined, hasTools: tools !== undefined }, 'Docker args built');

    return wrapDockerRunArgsWithRepoSetup(dockerArgs, CLAUDE_DOCKER_IMAGE, 'claude');
}

export async function storePromptInRedis(options: StorePromptOptions): Promise<void> {
    const { claudeOutput, prompt, issueRef, model, isRetry, retryReason } = options;
    if (!claudeOutput.sessionId && !claudeOutput.conversationId) return;

    try {
        const redis = new Redis({
            host: process.env.REDIS_HOST || 'redis',
            port: parseInt(process.env.REDIS_PORT || '6379', 10)
        });

        const promptData = {
            prompt,
            timestamp: new Date().toISOString(),
            issueRef,
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            model,
            isRetry,
            retryReason
        };

        const promptKeys: string[] = [];

        if (claudeOutput.sessionId) {
            const sessionKey = `execution:prompt:session:${claudeOutput.sessionId}`;
            await redis.set(sessionKey, JSON.stringify(promptData), 'EX', 86400 * 30);
            promptKeys.push(sessionKey);
        }

        if (claudeOutput.conversationId) {
            const conversationKey = `execution:prompt:conversation:${claudeOutput.conversationId}`;
            await redis.set(conversationKey, JSON.stringify(promptData), 'EX', 86400 * 30);
            promptKeys.push(conversationKey);
        }

        const issueKey = `execution:prompt:issue:${issueRef.repoOwner}:${issueRef.repoName}:${issueRef.number}:${Date.now()}`;
        await redis.set(issueKey, JSON.stringify(promptData), 'EX', 86400 * 30);
        promptKeys.push(issueKey);

        logger.info({
            issueNumber: issueRef.number,
            sessionId: claudeOutput.sessionId,
            conversationId: claudeOutput.conversationId,
            promptKeys,
            promptLength: prompt.length
        }, 'Stored execution prompt in Redis with unique identifiers');

        await redis.quit();
    } catch (redisError) {
        const error = redisError as Error;
        logger.warn({ issueNumber: issueRef.number, error: error.message }, 'Failed to store execution prompt in Redis - continuing');
    }
}

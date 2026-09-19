export { default as logger, generateCorrelationId, createCorrelatedLogger } from './utils/logger.js';
export { handleError, withErrorHandling, safeAsync, makeIdempotent, categorizeError, ErrorCategories } from './utils/errorHandler.js';
export type { ErrorCategory, ErrorDetails, ErrorHandlerOptions, IssueRef as ErrorIssueRef } from './utils/errorHandler.js';
export { withRetry, retryConfigs, calculateDelay } from './utils/retryHandler.js';
export { clearUltrafixStateForLabelRemoval, withUltrafixLabelTransition } from './utils/ultrafixLabelTransition.js';
export type { UltrafixLabelRemovalResult } from './utils/ultrafixLabelTransition.js';
export type { RetryConfig, RetryOptions } from './utils/retryHandler.js';
export * from './utils/constants.js';
export { recordLLMMetrics, getLLMMetricsSummary, getLLMMetricsByCorrelationId, shouldEnqueueExecutionAnalysis, updateAggregatedMetrics, checkCostThreshold, getTotalMetrics, getModelMetrics } from './utils/llmMetrics.js';
export { persistLlmLog, createLlmLogFromAnalysis, createLlmLogFromAgentExecution, buildTaskWorkRef, buildAnalysisWorkRef, WORK_TYPES } from './utils/llmLogger.js';
export type { LlmLogEntry, WorkReference, WorkType } from './utils/llmLogger.js';
export type { LLMMetricsSummary, LLMMetricsData, RecordMetricsOptions, ClaudeResult as LLMClaudeResult, IssueRef as LLMIssueRef, ModelPricing, ExtractedMetrics, AggregatedMetrics, CostCheckMetrics, PersistMetrics, ConversationDetail, LLMMetricsSummaryResult, ModelMetrics, DailyMetric, HighCostAlert, ConversationStep, TokenUsage, ExecutionType } from './utils/llmMetrics.types.js';
export { WorkerStateManager, getStateManager, closeStateManager, TaskStates } from './utils/workerStateManager.js';
export { taskStateExpectation, MAX_ATOMIC_UPDATE_ATTEMPTS, waitForAtomicUpdateRetry } from './utils/workerStateTransition.js';
export { hashTaskAttemptToken } from './utils/taskAttemptGeneration.js';
export { getEventPublisher, closeEventPublisher, EventPublisher } from './utils/eventPublisher.js';
export type { TaskState, IssueRef, HistoryEntry, LastError, ClaudeResultSummary, PRResult, TaskStateData, TaskStateExpectation, TaskStatePublicationResult, TaskStateUpdateResult, UpdateMetadata, TaskResult, ResumableTaskInfo, NonTerminalTaskScanResult, WorkerStateManagerOptions } from './utils/workerStateManager.types.js';
export { validatePRCreation, generateEnhancedClaudePrompt, validateRepositoryInfo } from './utils/prValidation.js';
export type { PRValidationResult, PRInfo, ValidatePRCreationOptions, CurrentIssueData, GenerateEnhancedClaudePromptOptions, RepoData, RepoValidationResult } from './utils/prValidation.js';
export { IdempotentGitHubOps, IdempotentGitOps } from './utils/idempotentOps.js';
export { estimateTokens, countTokens, getUsageStats, getDetailedUsageStats, getCachePricingMultipliers, calculateCostWithCachePricing } from './utils/tokenCalculation.js';
export type { DetailedUsageStats, CachePricingMultipliers } from './utils/tokenCalculation.js';
export { buildAnalysisSafetySuffix } from './agents/impl/utils/analysisPromptSafety.js';
export { formatResetTime, addModelSpecificDelay, parseResetTimeFromMessage, calculateNextRoundHourPlus2Minutes, formatRetryTime, hoursUntil } from './utils/scheduling.js';
export { filterCommentByAuthor, checkCommentTrigger, checkCommentIgnore } from './utils/commentFilters.js';
export { ensureGitRepository } from './utils/git/gitValidation.js';
export { safeRemoveLabel, safeAddLabel, safeUpdateLabels } from './utils/github/labelOperations.js';
export type { LabelContext, UpdateResults } from './utils/github/labelOperations.js';
export { createLogFiles, generateCompletionComment, redactSecrets } from './utils/github/logFiles.js';
export { formatSubscriptionUsage } from './utils/github/formatSubscriptionUsage.js';
export type { SubscriptionUsageRecord, SubscriptionUsageMetrics } from './utils/github/formatSubscriptionUsage.js';

export { getGitHubInstallationToken, getAuthenticatedOctokit, validateGithubIntakePrerequisites } from './auth/githubAuth.js';
export type { PaginatedOctokitInstance } from './auth/githubAuth.js';
export { buildAuthPayload, generateAuthToken, verifyAuthToken, AUTH_TOKEN_MAX_AGE_MS, AUTH_TOKEN_MAX_CLOCK_SKEW_MS } from './auth/systemTaskAuth.js';
export { consumeExecutionAdmission, createRedisAdmissionStore, readExecutionAdmissionConsumption, pendingExecutionAdmissionKey, requiresEzerExecutionAdmission, inspectWorkerAdmissionReceipt, verifyWorkerAdmissionReceipt } from './admission/ezerExecutionAdmission.js';
export type { CommentAdmissionBinding, AdmissionStore, ExecutionAdmissionClaims, WorkerAdmissionReceipt } from './admission/ezerExecutionAdmission.js';
export { requireStoryPublicationId, requireStoryPublicationPolicyAtRevision, requireStoryPublicationPolicyFromReader, storyPublicationSpecLinkPath, storyPublicationTaskLinkRequired, STORY_PUBLICATION_TASK_ID_PATTERN, STORY_PUBLICATION_TASK_SUFFIX_PATTERN, STORY_PUBLICATION_SPEC_DIRECTORY_PREFIX } from './publication/index.js';
export type { StoryPublicationPolicyInput } from './publication/index.js';

export * from './config/configManager.js';
// Note: loadUltrafixRatingGoal, loadUltrafixMaxCycles, loadUltrafixPauseSeconds, loadPrReviewModel
// are re-exported via configManager.ts (which re-exports from configManagerUltrafix.ts).
// Do NOT add explicit re-exports here — they would conflict with the wildcard export above.
export {
    createPlanIssue,
    getPlanIssuesByDraft,
    getPlanIssuesByDraftPaginated,
    getPlanIssue,
    updatePlanIssue,
    incrementFollowupCount,
    findPlanIssueByRepoAndNumber,
    findPlanIssueByRepoAndPR,
    updatePlanIssueStatus,
    updatePlanIssueTaskId,
    linkPRToPlanIssue,
    updatePlanIssueByPR,
    batchUpdatePlanIssueConfig,
    deletePlanIssue,
    PlanIssueStatus
} from './config/planIssueManager.js';
export type {
    PlanIssue,
    CreatePlanIssueInput,
    UpdatePlanIssueInput,
    GetPlanIssuesOptions,
    PaginatedPlanIssuesResult
} from './config/planIssueManager.js';
export { resolvePlanIssueDefaultSelection } from './config/planIssueDefaults.js';
export type { PlanIssueDefaultSelection } from './config/planIssueDefaultSelection.js';
export { getPlanIssueDefaultSelection } from './config/planIssueDefaultSelection.js';
export type { PlanIssueSelectionAgent } from './config/planIssueDefaultSelection.js';
export { resolveConfiguredModel } from './config/configuredModel.js';
export { resolveModelAlias, getDefaultModel, getPreferredModelForAgent, getModelShortName, getModelName, MODEL_ALIASES, MODEL_SHORT_NAMES, resolveLlmLabel, getOpenRouterId, getAgentTypeFromModel, resolveCustomLabel, getAllCustomLabels, findMatchingModel, resolveReviewModels, ReviewModelResolutionError, NoDefaultModelConfiguredError } from './config/modelAliases.js';
export type { LlmLabelResolution, ReviewAssignment } from './config/modelAliases.js';
export { CLAUDE_MODELS, CODEX_MODELS, ANTIGRAVITY_MODELS, OPENCODE_MODELS, VIBE_MODELS, ALL_MODELS, AGENT_MODELS, AGENT_DISPLAY, AGENT_DISPLAY_ORDER, MODEL_INFO_MAP, AGENT_DEFAULTS, typeBadgeColors } from './config/modelDefinitions.js';
export type { AgentType as ModelAgentType, AgentDisplayInfo, ModelInfo } from './config/modelDefinitions.js';
export { getEffectiveTokenLimit, getModelHardLimit, DEFAULT_CONTEXT_LEVEL, MIN_CONTEXT_LEVEL, MAX_CONTEXT_LEVEL, EFFECTIVE_MAX_RATIO, MODEL_LIMITS } from './config/modelLimits.js';
export type { ContextLevel } from './config/modelLimits.js';

export { db, closeConnection, createKnexConfigForMigrations, runMigrations } from './db/connection.js';
export { applyDatabaseMigrations, type MigrationDatabase, type MigrationGateOptions } from './db/migrationGate.js';

export { getRepoConfigKey, detectDefaultBranch, listRepositoryBranchConfigurations } from './git/branchConfig.js';
export type { BranchConfiguration } from './git/branchConfig.js';
export { createHooklessGit, DISABLED_GIT_HOOKS_PATH } from './git/hooklessGit.js';
export { AI_COMMIT_AUTHOR, commitChanges } from './git/commitOperations.js';
export type { CommitResult } from './git/commitOperations.js';
export { setupAuthenticatedRemote, ensureBranchAndPush, pushBranch, redactAuthenticatedGitUrl } from './git/repoBranching.js';
export { ensureRepoCloned, createWorktreeForIssue, getRepoUrl, fetchLatestChanges } from './git/repoManager.js';
export type { WorktreeResult, WorktreeInfo, FetchLatestChangesOptions, FetchLatestChangesResult } from './git/repoManager.js';
export { cleanupExistingBranch, createWorktreeFromExistingBranch } from './git/worktreeCreation.js';
export { cleanupWorktree, cleanupExpiredWorktrees, getWorktreesBasePath, safePruneWorktrees, setupWorktreePermissions, addToSafeDirectories, verifyWorktreeCreation, setupWorktreeRemote, getWorktreePath } from './git/worktreeOperations.js';
export type { CleanupOptions } from './git/worktreeOperations.js';
export { isGitCorruptionError, GIT_CORRUPTION_PATTERNS, getCorruptionPatternStrings } from './git/gitCorruption.js';
export { mergeBaseIntoBranch } from './git/mergeOperations.js';
export type { MergeOutcome, MergeResult } from './git/mergeOperations.js';

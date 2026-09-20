export {
    issueQueue,
    analysisQueue,
    indexingQueue,
    getIssueQueue,
    getAnalysisQueue,
    getIndexingQueue,
    GITHUB_ISSUE_QUEUE_NAME,
    ANALYSIS_QUEUE_NAME,
    INDEXING_QUEUE_NAME,
    COMMENT_BATCH_DELAY_MS,
    createWorker,
    shutdownQueue
} from './queue/taskQueue.js';
export type {
    IssueJobData,
    CommentJobData,
    TaskImportJobData,
    AnalysisJobData,
    SystemTaskJobData,
    IndexingJobData,
    MergeConflictJobData,
    JobData,
    JobResult,
    ClaudeResult,
    ClaudeResult as QueueClaudeResult,
    AiMetrics,
    WorkerCreateOptions,
    ProcessorFunction,
    UnprocessedComment,
    SystemAction,
    AutoResolveContext
} from './queue/taskQueue.js';

export { areAllChecksPassing, buildRedisRuntimeConfig, closeUltrafixStateRedis, getCurrentPRHead, getCheckRunsStatus, getActiveTasksForPR, hasActiveTasksForPR, type CheckRunsStatus, type ActivePRWork, type ActivePRTask, type ActivePRQueuedJob } from './webhook/checkRunHelpers.js';
export { handleCheckRunEvent, handleStatusEvent, reevaluatePRAutoMerge, setUltrafixCheckRunHook, type StatusEventPayload } from './webhook/checkRunHandler.js';
export * from './webhook/ciFailureFollowup.js';
export { processWebhookEvent, initializeWebhookHandler, SUPPORTED_WEBHOOK_EVENTS } from './webhook/webhookHandler.js';
export type { WebhookEventType, DetectedIssue, IssueProcessor, CommentProcessor, CommentDeletedHandler, CommentEditedHandler, CheckRunProcessor, WebhookHandlerOptions } from './webhook/webhookHandler.js';
export { RoutingWebSocketIntakeService } from './intake/RoutingWebSocketIntakeService.js';
export type { RoutingWebSocketIntakeServiceOptions, RoutingWebSocketStatus, ConnectAccountStatus, MinimalWebSocket, RawData, WebSocketCtor, FetchLike, DeliveryAckBilling, DeliveryAckEvidence, DeliveryAckStatus, DeliveryDisposition } from './intake/RoutingWebSocketIntakeService.js';
// The routing wire-protocol primitives (BoundedDeliverySet, BoundedTokenCache,
// DeliveryTracker, URL/payload/token helpers) are internal to the intake service
// and are intentionally NOT part of the package's public API. Tests import them
// directly from ./intake/routingWebSocketProtocol.js.
export { handleCommentDeleted, handleCommentEdited, processCommentEvent, setUltrafixDeps } from './webhook/commentEventHandler.js';
export { triggerNextPendingIssue } from './webhook/planIssueTrigger.js';
export type { CommentPayload, CommentEventConfig, CommentEventType, UltrafixDeps } from './webhook/commentEventHandler.js';
export { extractLlmFromKeywords, stripKeywordsFromBody, buildCodeContext, isReviewComment, extractLlmFromLabels } from './webhook/commentEventHelpers.js';
// `parseSlashCommand` / `buildCommandMeta` are deliberately NOT re-exported. Nothing outside
// `webhook/commentEventHandler.ts` consumes them, and a public re-export is an import shape that
// a source-scanning structural test cannot reliably see. The types below are re-exported because
// a type can carry no behaviour and therefore no command resolution.
export type { ParsedSlashCommand, SlashCommandName, CommandMeta, ReviewCommandMeta, FixCommandMeta, MergeCommandMeta, UltrafixCommandMeta } from './webhook/slashCommandParser.js';
export { handlePullRequestConflictDetection, handlePushConflictDetection, handleMergeCommand } from './webhook/mergeConflictDetector.js';
export type { ConflictDetectionOutcome, ConflictDetectionResult, HandleMergeCommandOptions } from './webhook/mergeConflictDetector.js';
export {
    determinePRStatusUpdate,
    isTerminalStatus,
    isInProgressStatus,
    TERMINAL_STATUSES
} from './webhook/statusMachine.js';
export type { PlanIssueStatus as StatusMachinePlanIssueStatus } from './webhook/statusMachine.js';

export { getExecutionAnalysis } from './services/analysisService.js';
export { getModelPricing } from './services/pricingService.js';
export { getWorktreeChanges, storeFileChanges, getStoredFileChanges, clearFileChanges, updateFileChangesFromWorktree, getCommitChanges, isValidCommitHash } from './services/worktreeMonitorService.js';
export type { FileChange, FileChangesData } from './services/worktreeMonitorService.js';
export { generateContext, generateAdditionalContext, ContextTokenLimitError, SecurityException } from './services/context/index.js';
export type { ContextGenerationOptions, ContextGenerationResult, SuspiciousFile, AdditionalContextOptions, AdditionalContextResult } from './services/context/index.js';
export { findRelevantFiles } from './services/relevanceService.js';
export type { RelevantFile, RelevanceResult, RelevanceOptions } from './services/relevanceService.js';
export { generatePlan, refinePlan, generateContextPreview, checkoutBranch, PlanningFailedError, BranchNotFoundError, buildFullContext } from './services/taskPlanningService.js';
export type { GeneratePlanOptions, RefinePlanOptions, RefinePlanResult, RefinePlanEstimation, GenerateContextPreviewOptions, PreviewResult, PreviewStats, SmartFileSelection, TaskDraftConfig, Granularity } from './services/taskPlanningService.js';
export { parseExistingContextConfig } from './services/planning/previewUtils.js';
export { pauseDraft, resumeDraft, isDraftPaused, getDraftPauseState } from './services/taskPlanning/draftPauseResume.js';
export type { PauseResumeResult } from './services/taskPlanning/draftPauseResume.js';
export { estimateLlmDuration, estimateUsagePercent } from './utils/llmEstimation.js';
export type { EstimationResult, EstimationOptions } from './utils/llmEstimation.js';
export type { Base64Image, ContextRepository } from './services/planning/planningTypes.js';
export { updateTrace, parseGenerationTrace, buildDraftUpdateTraceSnapshot, sanitizeDraftUpdateStepData } from './services/planning/traceService.js';
export { executeDraft, ensureEpicPR, generateEpicBranchName, isEpicBranch, EPIC_BRANCH_PATTERN } from './services/taskExecutionService.js';
export type { IssueLink, ExecutionResult, EpicPRResult, EnsureEpicPROptions } from './services/taskExecutionService.js';
export { validateAttachmentBaseUrlConfig } from './services/taskExecutionHelpers.js';
export { AttachmentService } from './services/attachmentService.js';
export type { Attachment, MulterFile } from './services/attachmentService.js';
export * from './services/visualPreviewService.js';
export * from './services/visualPreviewOAuthCredentialService.js';
export { PLANNER_SYSTEM_PROMPT, GRANULARITY_INSTRUCTIONS, getPlannerPrompt, REFINER_SYSTEM_PROMPT } from './claude/prompts/plannerPrompts.js';
export type { Plan, PlanItem, RefinementResponse } from './claude/prompts/plannerPrompts.js';
export { parseLlmJson, JsonParseError } from './utils/jsonUtils.js';
export { extractKeywords } from './services/relevance/keywordExtractor.js';
export { mineGitHistory, mineGitHistoryWithLLM, getCommitHistory, formatCommitLog } from './services/relevance/gitMiner.js';
export type { FileScore as GitFileScore, CommitInfo, SemanticMinerFile, SemanticMinerResponse, SemanticMiningOptions } from './services/relevance/gitMiner.js';
export { scorePaths } from './services/relevance/pathScorer.js';
export { indexRepo, getFileSummary, getDirectorySummary, getRepositorySummaries, clearRepositorySummaries, updateRepositoryStatus } from './services/relevance/summaryMiner.js';
export type { FileSummary, DirectorySummary, IndexingOptions } from './services/relevance/summaryMiner.js';
export { scanProcessableGitFiles, shouldProcessFilePath, isProcessableFile } from './services/relevance/summaryFileFilter.js';
export type { GitFileInfo } from './services/relevance/summaryFileFilter.js';
export { DEFAULT_INSTRUCTIONS } from './services/relevance/summaryMinerHelpers.js';
export { buildSummaryContext } from './services/relevance/contextBuilder.js';
export type { ContextBuildOptions, SmartContextResult } from './services/relevance/contextBuilder.js';
export {
  requestIndexingCancellation,
  isIndexingCancelled,
  clearIndexingCancellation,
  IndexingCancelledError,
  initIndexingProgress,
  updateIndexingProgress,
  setTotalBatches,
  getIndexingProgress,
  clearIndexingProgress,
  startDirectoryPhase,
  updateDirectoryProgress,
  publishProgress,
  publishIndexingStatus
} from './services/relevance/indexingCancellation.js';
export type { IndexingProgress } from './services/relevance/indexingCancellation.js';

export {
    toAgentTankAgent,
    toProprAgent,
    normalizeAgentTankStatus,
    normalizeAgentTankAgents
} from './services/agentTankService.js';
export type { AgentStatusResponse } from './services/agentTankService.js';
export type { BuildOpenCodePromptOptions, OpenCodeDockerArgsParams, OpenCodeEvent, ParsedOpenCodeOutput } from './agents/impl/openCodeUtils.js';
export { VibeAgent, parseVibeConversationLog, parseVibeOutput } from './agents/impl/VibeAgent.js';
export type {
    Agent,
    AgentConfig,
    AgentTaskOptions,
    AgentExecutionResult,
    AgentTerminationReason,
    AgentType,
    TokenUsage as AgentTokenUsage,
    AnalysisResult,
    AnalyzeOptions
} from './agents/types.js';
export { CONTAINER_CONFIG_PATHS } from './agents/types.js';
export { DEFAULT_CONFIG_PATHS, resolveConfigPath, getDefaultConfigPath, loadAgents, loadEffectiveAgentBaseImages, migrateAgentConfigs } from './config/configManager.js';

// Agent version management
export * from './agents/version/index.js';

// Repository chat message persistence
export {
    getMessagesForRepository,
    saveMessage,
    deleteMessage,
    clearMessagesForRepository
} from './services/repoChatMessages.js';
export type { ChatMessage, ChatMessageRecord, SaveMessageParams } from './services/repoChatMessages.js';

// Re-export event definitions from shared package for convenience
export {
    TASK_UPDATE,
    DRAFT_UPDATE,
    PLAN_STEP_UPDATE,
    INDEXING_UPDATE,
    REDIS_CHANNELS
} from '@propr/shared';
export type {
    TaskUpdatePayload,
    DraftUpdatePayload,
    PlanStepUpdatePayload,
    IndexingUpdatePayload,
    EventPayload
} from '@propr/shared';

// Repository to-do management
export {
    getCategoriesForRepository,
    createCategory,
    updateCategory,
    deleteCategory,
    batchReorderCategories,
    getTodosForRepository,
    getTodo,
    createTodo,
    updateTodo,
    deleteTodo,
    batchReorderTodos,
    linkTodosToDraft,
    completeTodosForDraft,
    getTodosForDraft
} from './services/repoTodosService.js';
export type {
    RepoTodoCategoryRecord,
    RepoTodoRecord,
    RepoTodoCategory,
    RepoTodo,
    CreateCategoryParams,
    UpdateCategoryParams,
    CreateTodoParams,
    UpdateTodoParams,
    BatchReorderItem
} from './services/repoTodosService.js';

// Authenticated Inbox persistence and keyset pagination
export {
    NotificationService, NotificationEventNotFoundError,
    NotificationValidationError, PushSubscriptionConflictError,
    PushSubscriptionQuotaError, PushSubscriptionRateLimitError,
    MAX_ACTIVE_PUSH_SUBSCRIPTIONS_PER_USER, MAX_STORED_PUSH_SUBSCRIPTIONS_PER_USER,
    MAX_PUSH_SUBSCRIPTION_ENROLLMENTS_PER_WINDOW, PUSH_SUBSCRIPTION_ENROLLMENT_WINDOW_MS,
    PUSH_SUBSCRIPTION_REVOKED_RETENTION_MS, PUSH_SUBSCRIPTION_GC_BATCH_SIZE,
    notificationService, createNotificationEvent, assignNotificationRecipients, listNotifications,
    getUnreadNotificationCount, markNotificationRead, dismissNotification, dismissAllNotifications, dismissNotificationReceipts,
    dismissNotificationsForPullRequest, dismissSupersededPullRequestAttentionNotifications, dismissSystemFailureNotifications,
    getNotificationPreferences, updateNotificationPreferences, updateNotificationPreference, upsertPushSubscription, listPushSubscriptions, revokePushSubscription, revokePushSubscriptionById,
    garbageCollectPushSubscriptions
} from './services/notificationService.js';
export type { NotificationRecipientInput, NotificationRecipient, CreateNotificationEventInput, NotificationListOptions, NotificationServiceOptions } from './services/notificationService.js';
export { DEFAULT_NOTIFICATION_LIST_LIMIT, MAX_NOTIFICATION_LIST_LIMIT, NotificationQueryValidationError, parseNotificationListLimit, encodeNotificationCursor, decodeNotificationCursor } from './services/notificationPagination.js';
export type { NotificationCursor } from './services/notificationPagination.js';

// Repository migration (rename/move detection)
export {
    detectRepositoryRename, migrateRepositoryReferences,
    checkAndMigrateRepository,
    detectRenameFromResponse,
    scheduleRepositoryRenameCheck
} from './services/repositoryMigrationService.js';
export type { RepositoryRenameResult, MigrationResult } from './services/repositoryMigrationService.js';

export { enqueueAdmittedComment } from './admission/admittedComment.js';
export { requireIntegrationPayload, integrationDigest } from './admission/integrationPayload.js';
export type { IntegrationPayload, IntegrationJobData } from './admission/integrationPayload.js';
export { executeIntegration, validateCurrentIntegration } from './admission/integrationExecution.js';
export { EZER_REVIEW_REQUEST, requireReviewRequestMode } from './admission/reviewRequest.js';

export { requireTypedInvestigation, type TypedInvestigationAdmission } from './admission/ezerExecutionAdmission.js';

export { requireTypedArtifactCorrection, type TypedArtifactCorrection } from './admission/ezerExecutionAdmission.js';

export type { StopAdmissionBinding } from './admission/ezerExecutionAdmission.js';
export { requireStoryExecutionContract, type StoryExecutionContract } from './admission/storyExecutionContract.js';
export { requireAuthorizedPublicationMetadata, publicationMetadataDigest, type AuthorizedPublicationMetadata } from './admission/authorizedPublicationMetadata.js';
export { verifyStoryPublication } from './git/storyPublication.js';
export { preserveExecutionCheckpoint, restoreExecutionCheckpoint, executionCheckpointRef, EXECUTION_CHECKPOINT_REF_PREFIX, type ExecutionCheckpointRecord, type ExecutionFailureClassification, type RestoredExecutionCheckpoint } from './git/executionCheckpoint.js';
export { publishPinnedExecutionCheckpoint, pinExecutionCheckpoint, resolveRepositoryGitDir, snapshotWorktreeToLocalRef, readLocalRef, executionCheckpointPinRef, LOCAL_CHECKPOINT_PIN_PREFIX, LOCAL_WORKTREE_SNAPSHOT_PREFIX } from './git/executionCheckpointRetention.js';
export { requireExecutionRecoveryCheckpoint } from './admission/executionRecoveryContext.js';
export { type ExecutionRecoveryCheckpoint, type ExecutionRecoveryContext } from './admission/executionRecoveryContext.js';

import { Knex } from 'knex';

// A consumed owner stop remains terminal when the only later rows are refused automatic retries.
const CURRENT_TASK_HISTORY_ORDER = `ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY
  CASE WHEN state = 'cancelled' AND json_valid(metadata) = 1 THEN
    CASE WHEN json_extract(metadata, '$.cancellationReason') = 'ezer_owner_stop'
      AND json_extract(metadata, '$.controlAdmissionId') IS NOT NULL
      AND json_extract(metadata, '$.controlOperationId') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM task_history later WHERE later.task_id = task_history.task_id
        AND later.timestamp > task_history.timestamp
        AND NOT ((later.state = 'pending' AND later.reason = 'Task created')
          OR (later.state = 'failed' AND later.reason = 'ezer-execution-admission-refused:missing-worker-receipt')))
    THEN 1 ELSE 0 END ELSE 0 END DESC, timestamp DESC) as rn`;


export interface TaskQuery {
  db: Knex;
  status: string;
  repository: string;
  issueNumber?: number;
  limit: number;
  offset: number;
  search?: string;
  forReview?: boolean;
  excludeMerged?: boolean;
}

export async function getTasksFromDb(
  query: TaskQuery
): Promise<{ tasks: unknown[]; total: number; offset: number; limit: number }> {
  const { db, status, repository, issueNumber, limit, offset, search, forReview, excludeMerged } = query;
  const latestHistorySubquery = db('task_history')
    .select(
      'task_id',
      'state',
      'timestamp',
      'reason',
      db.raw(CURRENT_TASK_HISTORY_ORDER)
    )
    .as('h');

  const processingStartSubquery = db('task_history')
    .select('task_id', db.raw('MIN(timestamp) as processing_start_timestamp'))
    .whereIn('state', ['processing', 'claude_execution', 'post_processing'])
    .groupBy('task_id')
    .as('ps');

  const completionSubquery = db('task_history')
    .select('task_id', db.raw('MIN(timestamp) as completion_timestamp'))
    .whereIn('state', ['completed', 'failed', 'cancelled'])
    .groupBy('task_id')
    .as('cs');

  const planIssueStatusSubquery = db('plan_issues')
    .select('task_id', 'status as plan_issue_status')
    .whereNotNull('task_id')
    .as('pi');

  const critiqueScoreSubquerySql = `
    LEFT JOIN (SELECT
      task_id,
      CASE
        WHEN json_valid(analysis_report) = 1
          AND json_extract(analysis_report, '$.report') IS NOT NULL
          AND INSTR(json_extract(analysis_report, '$.report'), '{') > 0
        THEN (
          SELECT
            CASE
              WHEN json_valid(clean_json) = 1
              THEN json_extract(clean_json, '$.implementation_critique_score')
              ELSE NULL
            END
          FROM (
            SELECT RTRIM(
              SUBSTR(
                json_extract(analysis_report, '$.report'),
                INSTR(json_extract(analysis_report, '$.report'), '{')
              ),
              CHAR(10) || CHAR(13) || ' ' || '\`'
            ) as clean_json
          )
        )
        ELSE NULL
      END as critique_score
    FROM llm_executions le1
    WHERE analysis_report IS NOT NULL
      AND json_valid(analysis_report) = 1
      AND json_extract(analysis_report, '$.report') IS NOT NULL
      AND execution_id = (
        SELECT MAX(le2.execution_id)
        FROM llm_executions le2
        WHERE le2.task_id = le1.task_id
          AND le2.analysis_report IS NOT NULL
          AND json_valid(le2.analysis_report) = 1
      )
    ) as cs_score ON cs_score.task_id = t.task_id
  `;

  const baseQuery = db('tasks as t')
    .join(latestHistorySubquery, function() {
      this.on('t.task_id', '=', 'h.task_id').andOn('h.rn', '=', db!.raw('?', [1]));
    })
    .leftJoin(processingStartSubquery, 'ps.task_id', 't.task_id')
    .leftJoin(completionSubquery, 'cs.task_id', 't.task_id')
    .leftJoin(planIssueStatusSubquery, 'pi.task_id', 't.task_id')
    .joinRaw(critiqueScoreSubquerySql);

  if (status && status !== 'all') {
    baseQuery.where('h.state', status);
  }
  if (repository && repository !== 'all') {
    baseQuery.where('t.repository', repository);
  }
  if (issueNumber !== undefined) {
    baseQuery.where('t.issue_number', issueNumber);
  }
  if (search && search.trim() !== '') {
    const searchTerm = `%${search.trim()}%`;
    baseQuery.where(function() {
      this.where('t.repository', 'like', searchTerm)
        .orWhere(db.raw('CAST(t.issue_number AS TEXT)'), 'like', searchTerm)
        .orWhere('t.initial_job_data', 'like', searchTerm);
    });
  }
  if (forReview) {
    baseQuery.whereIn('h.state', ['completed', 'failed']);
  }
  if (excludeMerged) {
    baseQuery.where(function() {
      this.whereNull('pi.plan_issue_status').orWhereNot('pi.plan_issue_status', 'merged');
    });
  }

  const totalResult = await baseQuery.clone().count('* as total').first();
  const total = parseInt(String(totalResult?.total || 0), 10);

  const dbTasks = await baseQuery
    .select('t.*', 'h.state', 'h.timestamp as state_timestamp', 'h.reason as failedReason',
            'ps.processing_start_timestamp', 'cs.completion_timestamp',
            'pi.plan_issue_status', 'cs_score.critique_score')
    .orderBy('t.created_at', 'desc')
    .limit(limit)
    .offset(offset);

  const taskIds = dbTasks.map((row: Record<string, unknown>) => row.task_id as string);
  const correlations = await fetchDurableCorrelations(db, taskIds);
  const tasks = dbTasks.map((row: Record<string, unknown>) => mapDbTaskToResponse(row, correlations.get(row.task_id as string)));
  return { tasks, total, offset, limit };
}

export interface DurableExecutionCorrelation {
  admissionId?: string;
  operationId?: string;
  sessionId?: string;
}

function parseHistoryMetadata(value: unknown): Record<string, unknown> {
  if (!value) return {};
  try {
    return typeof value === 'string' ? JSON.parse(value) : value as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Scans task_history metadata for the given tasks and keeps the latest known
 * value of each correlation field per task. These fields are each written to a
 * single history row (e.g. admissionId/operationId/sessionId land on the
 * claude_execution row), not necessarily the task's current/latest row, so a
 * single-row join would silently drop them once a task moves past that state.
 */
async function fetchDurableCorrelations(db: Knex, taskIds: string[]): Promise<Map<string, DurableExecutionCorrelation>> {
  const correlations = new Map<string, DurableExecutionCorrelation>();
  if (taskIds.length === 0) return correlations;

  const rows = await db('task_history')
    .select('task_id', 'metadata')
    .whereIn('task_id', taskIds)
    .orderBy('timestamp', 'asc');

  for (const row of rows) {
    const metadata = parseHistoryMetadata(row.metadata);
    const current = correlations.get(row.task_id as string) ?? {};
    if (typeof metadata.admissionId === 'string') current.admissionId = metadata.admissionId;
    if (typeof metadata.operationId === 'string') current.operationId = metadata.operationId;
    if (typeof metadata.sessionId === 'string') current.sessionId = metadata.sessionId;
    correlations.set(row.task_id as string, current);
  }
  return correlations;
}

function parseRepositoryParts(repository: unknown): { owner: string | null; name: string | null } {
  if (repository && typeof repository === 'string') {
    const parts = repository.split('/');
    if (parts.length === 2) return { owner: parts[0], name: parts[1] };
  }
  return { owner: null, name: null };
}

function parseInitialJobData(row: Record<string, unknown>): {
  title: string | null; subtitle: string | null; llmProvider: string | null;
  prNumber: number | null; issueNumber: number | null;
} {
  const result = { title: null as string | null, subtitle: null as string | null, llmProvider: null as string | null, prNumber: null as number | null, issueNumber: null as number | null };
  if (!row.initial_job_data) return result;
  try {
    const jobData = typeof row.initial_job_data === 'string' ? JSON.parse(row.initial_job_data) : row.initial_job_data;
    result.title = jobData.title || (jobData.issueRef ? jobData.issueRef.title : null) || null;
    result.subtitle = jobData.subtitle || null;
    result.llmProvider = jobData.agentAlias || null;
    if (jobData.pullRequestNumber) result.prNumber = jobData.pullRequestNumber;
    if (jobData.issueNumber) result.issueNumber = jobData.issueNumber;
  } catch (e) {
    console.error('Failed to parse initial_job_data', e);
  }
  return result;
}

function extractPrNumberFromFinalResult(row: Record<string, unknown>): number | null {
  if (!row.final_result) return null;
  try {
    const finalResult = typeof row.final_result === 'string' ? JSON.parse(row.final_result) : row.final_result;
    return finalResult?.postProcessing?.pr?.number || null;
  } catch {
    return null;
  }
}

function mapDbTaskToResponse(row: Record<string, unknown>, correlation?: DurableExecutionCorrelation): Record<string, unknown> {
  const { owner: repositoryOwner, name: repositoryName } = parseRepositoryParts(row.repository);
  const { title, subtitle, llmProvider, prNumber: jobDataPrNumber, issueNumber: jobDataIssueNumber } = parseInitialJobData(row);
  const prNumber = (row.pr_number as number | null) || jobDataPrNumber || extractPrNumberFromFinalResult(row);
  const linkedIssueNumber = jobDataIssueNumber;
  const critiqueScore = row.critique_score !== null && row.critique_score !== undefined
    ? typeof row.critique_score === 'number' ? row.critique_score : parseFloat(row.critique_score as string)
    : null;

  return {
    id: row.task_id, issueId: row.task_id, repository: row.repository,
    repositoryOwner, repositoryName, issueNumber: row.issue_number,
    prNumber, linkedIssueNumber, title, subtitle, status: row.state,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.state_timestamp as string).toISOString(),
    completedAt: row.completion_timestamp ? new Date(row.completion_timestamp as string).toISOString() : null,
    processedAt: row.processing_start_timestamp ? new Date(row.processing_start_timestamp as string).toISOString() : null,
    failedReason: row.state === 'failed' ? row.failedReason : null,
    progress: (row.state === 'completed' || row.state === 'failed' || row.state === 'cancelled') ? 100 : (row.state === 'processing' ? 50 : 0),
    attemptsMade: 1, modelName: row.model_name, model: row.model_name, llmProvider,
    planIssueStatus: row.plan_issue_status || null,
    critiqueScore: critiqueScore !== null && !isNaN(critiqueScore) ? critiqueScore : null,
    correlationId: (row.correlation_id as string | null) ?? null,
    admissionId: correlation?.admissionId ?? null,
    operationId: correlation?.operationId ?? null,
    sessionId: correlation?.sessionId ?? null,
    commitHash: (row.commit_hash as string | null) ?? null
  };
}

const ADMITTED_PR_COMMENT_TASK = /^pr-comments-batch-ezer-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** These task IDs are created only by the signed PR-comment ingress; their issue number is the PR. */
export function taskFollowupPullRequest(task: {task_id:string;issue_number:number;pr_number?:number|null}): number | undefined {
 const candidate=task.pr_number??(ADMITTED_PR_COMMENT_TASK.test(task.task_id)?task.issue_number:undefined);
 return typeof candidate==='number'&&Number.isSafeInteger(candidate)&&candidate>0?candidate:undefined;
}

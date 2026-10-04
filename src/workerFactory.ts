import type { Job, Worker } from 'bullmq';
import type {
    CommentJobData,
    IssueJobData,
    JobResult,
    MergeConflictJobData,
    SystemTaskJobData,
    TaskImportJobData,
    IntegrationJobData,
} from '@propr/core';

export type MainJobData = import('@propr/core').MilestoneCorrectionJob | import('@propr/core').MilestoneMaintenanceJob | IssueJobData | CommentJobData | TaskImportJobData | SystemTaskJobData | MergeConflictJobData | IntegrationJobData;
export type MainWorker = Worker<MainJobData, JobResult>;

export interface MainJobProcessors {
    processMilestoneCorrection?: (job: Job<import('@propr/core').MilestoneCorrectionJob>) => Promise<JobResult>;
    processMilestoneMaintenance?: (job: Job<import('@propr/core').MilestoneMaintenanceJob>) => Promise<JobResult>;
    processIntegrationJob?: (job: Job<IntegrationJobData>) => Promise<JobResult>;
    processGitHubIssueJob: (job: Job<IssueJobData>) => Promise<JobResult>;
    processPullRequestCommentJob: (job: Job<CommentJobData>) => Promise<JobResult>;
    processTaskImportJob: (job: Job<TaskImportJobData>) => Promise<JobResult>;
    processSystemTaskJob: (job: Job<SystemTaskJobData>) => Promise<JobResult>;
    processMergeConflictJob: (job: Job<MergeConflictJobData>) => Promise<JobResult>;
}

export type MainWorkerFactory = (
    queueName: string,
    processor: (job: Job<MainJobData>) => Promise<JobResult>,
    options: { concurrency: number; autorun: boolean },
) => Promise<MainWorker>;

export function createMainJobProcessor(processors: MainJobProcessors) {
    return async (job: Job<MainJobData>): Promise<JobResult> => {
        switch (job.name) {
            case 'processMilestoneCorrection':
                if (!processors.processMilestoneCorrection) throw Error('Milestone correction processor unavailable');
                return processors.processMilestoneCorrection(job as Job<import('@propr/core').MilestoneCorrectionJob>);
            case 'processMilestoneMaintenance':
                if (!processors.processMilestoneMaintenance) throw Error('Milestone processor unavailable');
                return processors.processMilestoneMaintenance(job as Job<import('@propr/core').MilestoneMaintenanceJob>);
            case 'processIntegration':
                if (!processors.processIntegrationJob) throw new Error('Integration processor is not configured');
                return processors.processIntegrationJob(job as Job<IntegrationJobData>);
            case 'processGitHubIssue':
                return processors.processGitHubIssueJob(job as Job<IssueJobData>);
            case 'processPullRequestComment':
                return processors.processPullRequestCommentJob(job as Job<CommentJobData>);
            case 'processTaskImport':
                return processors.processTaskImportJob(job as Job<TaskImportJobData>);
            case 'processSystemTask':
                return processors.processSystemTaskJob(job as Job<SystemTaskJobData>);
            case 'processMergeConflict':
                return processors.processMergeConflictJob(job as Job<MergeConflictJobData>);
            default:
                throw new Error(`Unknown job type: ${job.name}`);
        }
    };
}

export async function createConfiguredMainWorker(options: {
    queueName: string;
    concurrency: number;
    workerFactory: MainWorkerFactory;
    processors: MainJobProcessors;
    beforeRun?: (worker: MainWorker) => void;
    startPaused?: boolean;
}): Promise<MainWorker> {
    const worker = await options.workerFactory(
        options.queueName,
        createMainJobProcessor(options.processors),
        { concurrency: options.concurrency, autorun: false },
    );
    options.beforeRun?.(worker);
    if (options.startPaused) await worker.pause(true);
    void worker.run().catch(error => worker.emit('error', error));
    return worker;
}

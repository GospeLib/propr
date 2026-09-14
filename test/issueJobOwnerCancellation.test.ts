import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';
const noOp=()=>undefined;
const log={debug:noOp,info:noOp,warn:noOp,error:noOp};
const states={COMPLETED:'completed',FAILED:'failed',CANCELLED:'cancelled',CLAUDE_EXECUTION:'claude_execution',PENDING:'pending',PROCESSING:'processing'};
const git=mock.fn(async(_cmd:string,args:string[])=>({stdout:args[0]==='rev-parse'?'base':'',stderr:''}));
const execFile=Object.assign(()=>undefined,{[promisify.custom]:git});
await mock.module('node:child_process',{namedExports:{execFile}});
const executeTask=mock.fn(async()=>({success:false,error:'stopped',executionTimeMs:1}));
const agent={config:{type:'claude'},executeTask};
const createTaskState=mock.fn(async()=>undefined);
const getTaskCancellation=mock.fn(async()=>({state:'cancelled',metadata:{controlAdmissionId:'actual-stop'}}));
const stateManager={createTaskState,getTaskCancellation,getTaskState:async()=>({state:'cancelled'}),updateTaskState:mock.fn()};
const context={taskId:'same-stopped-task',agentAlias:'default',modelName:'claude-test',stateManager,correlatedLogger:log,correlationId:'correlation',issueRef:{repoOwner:'owner',repoName:'repo',number:1},typedInvestigation:{provider:'claude',deadline:new Date(Date.now()+60_000).toISOString(),outputPath:'report.md'},ezerAdmissionVerified:true};
await mock.module('@propr/core',{namedExports:{
 logger:log,TaskStates:states,AgentRegistry:{getInstance:()=>({getAgentByAlias:()=>agent})},generateClaudePrompt:()=>'',updateFileChangesFromWorktree:noOp,recordLLMMetrics:noOp,resolveAgentTerminationReason:noOp,
 ensureRepoCloned:noOp,getRepoUrl:noOp,safeAddLabel:noOp,safeRemoveLabel:noOp,ensureGitRepository:noOp,UsageLimitError:class extends Error{},validateRepositoryInfo:noOp,addModelSpecificDelay:noOp,withRetry:noOp,retryConfigs:{},updatePlanIssueTaskId:noOp,
}});
await mock.module('../src/jobs/issueJobHelpers.js',{namedExports:{localizeContentImages:async(x:string)=>x,handleUsageLimitError:noOp,handleGenericError:noOp,updateTaskTitleInStorage:noOp,buildFinalResult:noOp}});
await mock.module('../src/jobs/issueJobCallbacks.js',{namedExports:{createSessionIdCallback:noOp,createContainerIdCallback:noOp,deriveVerifiedExecutionCorrelation:noOp,startFileChangesMonitor:()=>async()=>undefined}});
await mock.module('../src/jobs/issueJob/config.js',{namedExports:{redisClient:{}}});
await mock.module('../src/jobs/ezerAdmittedWorkerEnvironment.js',{namedExports:{buildAdmittedWorkerEnvironment:()=>({})}});
const verifyAdmission=mock.fn(async()=>{throw new Error('receipt consumed');});
await mock.module('../src/jobs/ezerExecutionAdmission.js',{namedExports:{verifyConfiguredEzerAdmission:verifyAdmission,inspectConfiguredEzerAdmission:verifyAdmission}});
await mock.module('../src/jobs/issueJobDispatcher.js',{namedExports:{handleDispatch:mock.fn()}});
await mock.module('../src/jobs/issueJobPostProcessing.js',{namedExports:{performFinalValidation:noOp}});
await mock.module('../src/jobs/issueJob/index.js',{namedExports:{initializeJobContext:async()=>context,getAuthenticatedClient:noOp,checkLabelConditions:noOp,ensureProcessingLabel:noOp,executeWorktreeOperations:noOp,markTaskComplete:noOp}});
const {executeAgentAndRecordMetrics}=await import('../src/jobs/issueJob/agent.js');
const {processGitHubIssueJob}=await import('../src/jobs/processGitHubIssueJob.js');
test('actual cancellation wins before missing typed artifact validation',async()=>{
 await assert.rejects(executeAgentAndRecordMetrics({worktreeInfo:{worktreePath:'/unused',branchName:'branch'},issueRef:{repoOwner:'owner',repoName:'repo',number:1},githubToken:{token:'test'},currentIssueData:{data:{body:'',title:'',labels:[]}},issueComments:[]} as never,context as never),/Execution aborted by user request/);
 assert.equal(executeTask.mock.callCount(),1);
 assert.equal(git.mock.callCount(),1,'only initial HEAD read, no cancelled output validation');
});
test('retained owner cancellation suppresses redelivery before pending state or admission',async()=>{
 const discard=mock.fn();
 const result=await processGitHubIssueJob({data:{isChildJob:true},discard} as never);
 assert.deepEqual(result,{status:'cancelled',reason:'user_request'});
 assert.equal(discard.mock.callCount(),1);
 assert.equal(createTaskState.mock.callCount(),0);
 assert.equal(verifyAdmission.mock.callCount(),0);
});
test('ordinary admitted agent receives only the remaining signed execution time',async()=>{
 const budgetMs=60_000;
 const deadline=new Date(Date.now()+budgetMs).toISOString();
 verifyAdmission.mock.mockImplementation(async()=>true);
 const prepared={...context,typedInvestigation:undefined,ezerAdmissionVerified:false,ezerAdmissionPrepared:true,executionDeadline:deadline};
 await assert.rejects(executeAgentAndRecordMetrics({worktreeInfo:{worktreePath:'/unused',branchName:'branch'},issueRef:{repoOwner:'owner',repoName:'repo',number:1},githubToken:{token:'test'},currentIssueData:{data:{body:'',title:'',labels:[]}},issueComments:[]} as never,prepared as never),/Execution aborted by user request/);
 const timeout=(executeTask.mock.calls.at(-1)?.arguments[0] as {timeoutMs?:number}|undefined)?.timeoutMs;
 assert.equal(typeof timeout,'number');
 assert(timeout!>0 && timeout!<=budgetMs);
});
test('a receipt consumed by another worker cannot reach the agent after preparation',async()=>{
 const calls=executeTask.mock.callCount();
 verifyAdmission.mock.mockImplementation(async()=>{throw new Error('missing-worker-receipt');});
 const prepared={...context,typedInvestigation:undefined,ezerAdmissionVerified:false,ezerAdmissionPrepared:true,executionDeadline:new Date(Date.now()+60_000).toISOString()};
 await assert.rejects(executeAgentAndRecordMetrics({worktreeInfo:{worktreePath:'/unused',branchName:'branch'},issueRef:{repoOwner:'owner',repoName:'repo',number:1},githubToken:{token:'test'},currentIssueData:{data:{body:'',title:'',labels:[]}},issueComments:[]} as never,prepared as never),/missing-worker-receipt/);
 assert.equal(executeTask.mock.callCount(),calls);
});

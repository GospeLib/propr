import {createHash} from 'node:crypto';
import {consumeExecutionAdmission,type AdmissionStore,type StopAdmissionBinding} from '@propr/core';
import type {StopTaskExecutionOptions,StopTaskExecutionResult} from './dockerRoutes.js';
const STOP_COMMAND=/^\/ezer stop ([^\s]+)\s*$/;
const STOP_OWNER_ACT_MAX_AGE_MS=300_000;
const STOP_REPOSITORY='GospeLib/main';
const STOP_REASON='ezer_owner_stop';
export interface StopTaskBinding {repository:string;issueNumber:number;}
export interface StopOwnerComment {id:number;body:string;issue_url:string;created_at:string;updated_at:string;user:{id:number;login:string}|null;}
export interface AdmittedStopPorts {
 store:AdmissionStore;signingSecret:string;nowMs?:number;
 readTask(taskId:string):Promise<StopTaskBinding|undefined>;
 readComment(repository:string,commentId:number):Promise<StopOwnerComment>;
 readState(taskId:string):Promise<string|null>;
 stop(taskId:string,options:Omit<StopTaskExecutionOptions,'redisClient'>):Promise<StopTaskExecutionResult>;
}
/** Existing stop handler only; no queue dispatch, owner impersonation or alternate executor. */
export async function stopAdmittedTask(input:{taskId:string;commentId:number;token:string},ports:AdmittedStopPorts){
 if(!input.taskId||!Number.isSafeInteger(input.commentId)||input.commentId<1||!input.token)throw new Error('ezer-stop-refused:invalid-request');
 const task=await ports.readTask(input.taskId);if(!task)throw new Error('ezer-stop-refused:task-not-found');
 if(task.repository!==STOP_REPOSITORY)throw new Error('ezer-stop-refused:repository-not-approved');
 const comment=await ports.readComment(task.repository,input.commentId);
 const unit=STOP_COMMAND.exec(comment.body.trim())?.[1],created=Date.parse(comment.created_at),now=ports.nowMs??Date.now();
 if(!Number.isFinite(created)||created>now||now-created>STOP_OWNER_ACT_MAX_AGE_MS)throw new Error('ezer-stop-refused:owner-comment-expired');
 if(!unit||comment.id!==input.commentId||!comment.user||comment.created_at!==comment.updated_at||
 comment.issue_url!==`https://api.github.com/repos/${task.repository}/issues/${task.issueNumber}`)throw new Error('ezer-stop-refused:owner-comment-changed');
 const raw=await ports.readState(input.taskId);if(!raw)throw new Error('ezer-stop-refused:execution-not-running');
 const state=JSON.parse(raw) as {history?:Array<{state:string;metadata?:Record<string,unknown>}>};
 const current=state.history?.at(-1),meta=current?.metadata;
 if(current?.state!=='claude_execution'||typeof meta?.admissionId!=='string'||typeof meta.operationId!=='string'||typeof meta.containerId!=='string')throw new Error('ezer-stop-refused:execution-not-running');
 const control:StopAdmissionBinding={kind:'stop',taskId:input.taskId,unitId:unit,executionAdmissionId:meta.admissionId,
 executionOperationId:meta.operationId,containerId:meta.containerId,ownerAccountId:String(comment.user.id),commentId:comment.id,
 bodyDigest:`sha256:${createHash('sha256').update(comment.body).digest('hex')}`};
 const admitted=await consumeExecutionAdmission({token:input.token,signingSecret:ports.signingSecret,store:ports.store,nowMs:ports.nowMs,
 expected:{repository:task.repository,issueNumber:task.issueNumber,control}});
 // This receipt is consumed here and is categorically refused by the worker receipt verifier.
 if(!await ports.store.take(admitted.receipt.receiptKey))throw new Error('ezer-stop-refused:missing-control-receipt');
 const result=await ports.stop(input.taskId,{requestedBy:comment.user.login,reason:`Owner stop comment ${comment.id}; Ezer admission ${admitted.claims.admissionId}.`,
 cancellationReason:STOP_REASON,controlAdmission:{admissionId:admitted.claims.admissionId,operationId:admitted.claims.operationId},expectedExecution:{admissionId:meta.admissionId,operationId:meta.operationId,containerId:meta.containerId}});
 return {...result,admissionId:admitted.claims.admissionId,operationId:admitted.claims.operationId,commentId:comment.id};
}

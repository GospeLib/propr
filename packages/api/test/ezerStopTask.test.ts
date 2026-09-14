import {createHmac,createHash} from 'node:crypto';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {db,consumeExecutionAdmission,verifyWorkerAdmissionReceipt} from '@propr/core';
import {stopAdmittedTask} from '../routes/ezerStopTask.js';
import {isEzerInternalEligibleRoute} from '../ezerInternalAuth.js';
after(async()=>db.destroy());
const SECRET='test-only-stop-signing-secret-longer-than32';
function fixture(){
 const now=Date.now(),body='/ezer stop EP-test-S01';
 const control={kind:'stop' as const,taskId:'task-a',executionAdmissionId:'execution-a',executionOperationId:'operation-a',containerId:'container-a',unitId:'EP-test-S01',ownerAccountId:'123',commentId:42,bodyDigest:`sha256:${createHash('sha256').update(body).digest('hex')}`};
 const claims={version:1 as const,admissionId:'stop-admission',operationId:'stop-operation',storyId:'EP-test-S01',featureThread:'EP-test',epicId:'EP-test',repository:'GospeLib/main',target:'stage',scope:['file.md'],authorityRevision:'a'.repeat(40),authorityDigest:'sha256:'+ 'b'.repeat(64),issueNumber:7,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),control};
 const encoded=Buffer.from(JSON.stringify(claims)).toString('base64url'),token=encoded+'.'+createHmac('sha256',SECRET).update(encoded).digest('base64url');
 const values=new Map<string,string>();
 const store={consumeAndIssue:async(a:string,b:string,v:string)=>{if(values.has(a))return false;values.set(a,v);values.set(b,v);return true;},get:async(k:string)=>values.get(k)??null,take:async(k:string)=>{const v=values.get(k)??null;values.delete(k);return v;}};
 const stops:any[]=[];let userId=123,started=true;
 const ports={store,signingSecret:SECRET,readTask:async()=>({repository:'GospeLib/main',issueNumber:7}),readComment:async()=>({id:42,body,issue_url:'https://api.github.com/repos/GospeLib/main/issues/7',created_at:new Date(now-1000).toISOString(),updated_at:new Date(now-1000).toISOString(),user:{id:userId,login:'owner'}}),readState:async()=>JSON.stringify({history:[{state:started?'claude_execution':'processing',metadata:{admissionId:'execution-a',operationId:'operation-a',containerId:'container-a'}}]}),stop:async(taskId:string,options:any)=>{stops.push({taskId,options});return {success:true,taskId,containerStopped:true,removedQueuedJobs:0,message:'stopped'};}};
 return {token,ports,control,stops,setUser:(v:number)=>userId=v,setStarted:(v:boolean)=>started=v};
}
test('requires exact actual owner comment and current execution before existing stop helper',async()=>{
 const f=fixture();f.setUser(456);await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/wrong-stop-control/);assert.equal(f.stops.length,0);
 f.setUser(123);f.setStarted(false);await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/execution-not-running/);assert.equal(f.stops.length,0);
 f.setStarted(true);await assert.rejects(()=>stopAdmittedTask({taskId:'other-task',commentId:42,token:f.token},f.ports),/wrong-stop-control/);assert.equal(f.stops.length,0);
 const result=await stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports);assert.equal(result.containerStopped,true);assert.equal(f.stops.length,1);assert.deepEqual(f.stops[0].options.expectedExecution,{admissionId:'execution-a',operationId:'operation-a',containerId:'container-a'});
 await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/replayed-admission/);assert.equal(f.stops.length,1);
});
test('stop authority cannot be consumed as product execution or start a worker; only the approved exact route is allowlisted',async()=>{
 const f=fixture();await assert.rejects(()=>consumeExecutionAdmission({token:f.token,signingSecret:SECRET,store:f.ports.store,expected:{repository:'GospeLib/main',issueNumber:7}}),/wrong-stop-control/);
 const {receipt}=await consumeExecutionAdmission({token:f.token,signingSecret:SECRET,store:f.ports.store,expected:{repository:'GospeLib/main',issueNumber:7,control:f.control}});
 await assert.rejects(()=>verifyWorkerAdmissionReceipt({receipt,store:f.ports.store,expected:{repository:'GospeLib/main',issueNumber:7,target:'stage'}}),/stop-control-cannot-start-worker/);
 assert.equal(isEzerInternalEligibleRoute('POST','/task/task-a/stop'),true);
});

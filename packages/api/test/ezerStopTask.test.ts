import {createHmac,createHash} from 'node:crypto';
import {test,after} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {Redis} from 'ioredis';
import assert from 'node:assert/strict';
import {db,consumeExecutionAdmission,verifyWorkerAdmissionReceipt,createRedisAdmissionStore,type AdmissionStore} from '@propr/core';
import {stopAdmittedTask} from '../routes/ezerStopTask.js';
import {stopTaskExecution} from '../routes/dockerRoutes.js';
import {makeFakeRedis,makeFakeQueue} from './stopTaskFixtures.js';
import {isEzerInternalEligibleRoute} from '../ezerInternalAuth.js';
import type {AdmittedStopPorts} from '../routes/index.js';
after(async()=>db.destroy());
const SECRET='test-only-stop-signing-secret-longer-than32';
const MAIN_REPOSITORY='GospeLib/main';
const SECONDARY_REPOSITORY='GospeLib/propr';
const UNSERVED_REPOSITORY='GospeLib/unserved';
async function fixture(repository=MAIN_REPOSITORY,requestRepository=repository,storeOverride?:AdmissionStore,executionLifetimeMs=60_000){
 const now=Date.now(),body='/ezer stop EP-test-S01';
 const control={kind:'stop' as const,taskId:'task-a',executionAdmissionId:'execution-a',executionOperationId:'operation-a',containerId:'container-a',unitId:'EP-test-S01',ownerAccountId:'123',commentId:42,bodyDigest:`sha256:${createHash('sha256').update(body).digest('hex')}`};
 const claims={version:1 as const,admissionId:'stop-admission',operationId:'stop-operation',storyId:'EP-test-S01',featureThread:'EP-test',epicId:'EP-test',repository:requestRepository,target:'stage',scope:['file.md'],authorityRevision:'a'.repeat(40),authorityDigest:'sha256:'+ 'b'.repeat(64),issueNumber:7,issuedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString(),control};
 const sign=(value:unknown)=>{const encoded=Buffer.from(JSON.stringify(value)).toString('base64url');return encoded+'.'+createHmac('sha256',SECRET).update(encoded).digest('base64url');};
 const token=sign(claims);
 const values=new Map<string,string>();
 const store=storeOverride??{consumeAndIssue:async(a:string,b:string,v:string)=>{if(values.has(a))return false;values.set(a,v);values.set(b,v);return true;},get:async(k:string)=>values.get(k)??null,take:async(k:string)=>{const v=values.get(k)??null;values.delete(k);return v;}};
 const {receipt}=await consumeExecutionAdmission({token:sign({...claims,repository,admissionId:'execution-a',operationId:'operation-a',control:undefined,expiresAt:new Date(now+executionLifetimeMs).toISOString()}),signingSecret:SECRET,store,expected:{repository,issueNumber:7}});
 await verifyWorkerAdmissionReceipt({receipt,store,expected:{repository,issueNumber:7,target:'stage'}});
 const stops:Array<{taskId:string;options:Parameters<AdmittedStopPorts['stop']>[1]}>=[];let userId=123,started=true;
 const ports={store,signingSecret:SECRET,readServedRepositories:async()=>[MAIN_REPOSITORY,SECONDARY_REPOSITORY],readTask:async()=>({repository,issueNumber:7}),readComment:async()=>({id:42,body,issue_url:`https://api.github.com/repos/${repository}/issues/7`,created_at:new Date(now-1000).toISOString(),updated_at:new Date(now-1000).toISOString(),user:{id:userId,login:'owner'}}),readState:async()=>JSON.stringify({history:[{state:started?'claude_execution':'processing',metadata:{admissionId:'execution-a',operationId:'operation-a',containerId:'container-a'}}]}),stop:async(taskId:string,options:Parameters<AdmittedStopPorts['stop']>[1])=>{stops.push({taskId,options});return {success:true,taskId,containerStopped:true,removedQueuedJobs:0,message:'stopped'};}};
 return {now,claims,sign,token,ports,control,stops,values,receipt,setUser:(v:number)=>userId=v,setStarted:(v:boolean)=>started=v};
}
test('requires exact actual owner comment and current execution before existing stop helper',async()=>{
 const f=await fixture();f.setUser(456);await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/wrong-stop-control/);assert.equal(f.stops.length,0);
 f.setUser(123);f.setStarted(false);await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/execution-not-running/);assert.equal(f.stops.length,0);
 f.setStarted(true);await assert.rejects(()=>stopAdmittedTask({taskId:'other-task',commentId:42,token:f.token},f.ports),/wrong-stop-control/);assert.equal(f.stops.length,0);
 const result=await stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports);assert.equal(result.containerStopped,true);assert.equal(f.stops.length,1);assert.deepEqual(f.stops[0].options.expectedExecution,{admissionId:'execution-a',operationId:'operation-a',containerId:'container-a'});
 await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/replayed-admission/);assert.equal(f.stops.length,1);
});
test('stop authority cannot be consumed as product execution or start a worker; only the approved exact route is allowlisted',async()=>{
 const f=await fixture();await assert.rejects(()=>consumeExecutionAdmission({token:f.token,signingSecret:SECRET,store:f.ports.store,expected:{repository:'GospeLib/main',issueNumber:7}}),/wrong-stop-control/);
 const {receipt}=await consumeExecutionAdmission({token:f.token,signingSecret:SECRET,store:f.ports.store,expected:{repository:'GospeLib/main',issueNumber:7,control:f.control}});
 await assert.rejects(()=>verifyWorkerAdmissionReceipt({receipt,store:f.ports.store,expected:{repository:'GospeLib/main',issueNumber:7,target:'stage'}}),/stop-control-cannot-start-worker/);
 assert.equal(isEzerInternalEligibleRoute('POST','/task/task-a/stop'),true);
});

for(const repository of [MAIN_REPOSITORY,SECONDARY_REPOSITORY]){
 test(`stops the admitted ${repository} execution through the real stop helper`,async()=>{
  const f=await fixture(repository);
  const redis=makeFakeRedis({'worker:state:task-a':await f.ports.readState()});
  const stopped:string[]=[],cancelled:unknown[]=[];
  f.ports.stop=async(taskId,options)=>stopTaskExecution(taskId,{...options,redisClient:redis,
   getQueue:async()=>makeFakeQueue([]),stopContainer:async id=>{stopped.push(id);return {success:true};},
   markCancelled:async(...args)=>{cancelled.push(args);}});
  const result=await stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports);
  assert.deepEqual(result,{success:true,taskId:'task-a',containerStopped:true,removedQueuedJobs:0,
   abortSignalled:false,cancellationRecorded:true,message:'Execution stopped. The Docker container has been terminated.',admissionId:'stop-admission',operationId:'stop-operation',commentId:42});
  assert.deepEqual(stopped,['container-a']);assert.equal(cancelled.length,1);
  assert.equal(await f.ports.store.get(f.receipt.receiptKey),null,'worker receipt was already spent');
 });
}
test('refuses a signed stop naming a different repository than the admitted execution',async()=>{
 const f=await fixture(SECONDARY_REPOSITORY,MAIN_REPOSITORY);
 await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/wrong-repository/);
 assert.equal(f.stops.length,0);
});
test('refuses an admitted repository that ProPR does not serve',async()=>{
 const f=await fixture(UNSERVED_REPOSITORY);
 await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/repository-not-approved/);
 assert.equal(f.stops.length,0);
});
test('requires the trusted admission to match the task repository and issue',async()=>{
 for(const task of [{repository:MAIN_REPOSITORY,issueNumber:7},{repository:SECONDARY_REPOSITORY,issueNumber:8}]){
  const f=await fixture(SECONDARY_REPOSITORY);f.ports.readTask=async()=>task;
  await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/execution-task-mismatch/);
  assert.equal(f.stops.length,0);
 }
});
test('missing, malformed, control, or differently bound trusted records cannot authorize a stop',async()=>{
 const key='ezer:execution-admission:consumed:execution-a';
 for(const change of [undefined,'{','null',JSON.stringify({admissionId:'execution-a',operationId:'other',repository:SECONDARY_REPOSITORY,issueNumber:7}),JSON.stringify({admissionId:'execution-a',operationId:'operation-a',repository:SECONDARY_REPOSITORY,issueNumber:7,control:{kind:'stop'}})]){
  const f=await fixture(SECONDARY_REPOSITORY);f.values.delete(key);if(change!==undefined)f.values.set(key,change);
  await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/execution-admission/);
  assert.equal(f.stops.length,0);
 }
});
test('secondary-repository stop still requires an unchanged fresh comment on its own issue',async()=>{
 const changedComments=[{issue_url:'https://api.github.com/repos/GospeLib/main/issues/7'},{issue_url:'https://api.github.com/repos/GospeLib/propr/issues/8'},
  {created_at:new Date(0).toISOString()},{updated_at:new Date(0).toISOString()},{id:43},{body:'/ezer stop other-unit'},{user:{id:456,login:'impostor'}}];
 for(const changed of changedComments){
  const f=await fixture(SECONDARY_REPOSITORY),comment=await f.ports.readComment();
  f.ports.readComment=async()=>({...comment,...changed});
  await assert.rejects(()=>stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports),/owner-comment|wrong-stop-control/);
  assert.equal(f.stops.length,0);
 }
});

test('retained admission authorizes a ceiling stop after the execution lease expires without extending worker authority',async()=>{
 const redis=new Redis({host:process.env.REDIS_HOST??'127.0.0.1',port:Number(process.env.REDIS_PORT??'6379')});
 const lifetimeMs=1000,expiryMarginMs=100,minimumRetentionSeconds=23*60*60;
 const retainedKey='test:stop:retained',workerKey='test:stop:worker';
 try{
  const store=createRedisAdmissionStore(redis);
  assert.equal(await store.consumeAndIssue(retainedKey,workerKey,'evidence',1),true);
  assert.ok(await redis.ttl(workerKey)<=1);
  const f=await fixture(SECONDARY_REPOSITORY,SECONDARY_REPOSITORY,store,lifetimeMs);
  await delay(lifetimeMs+expiryMarginMs);
  assert.equal(await store.get(f.receipt.receiptKey),null);
  assert.equal(await store.get(workerKey),null);
  assert.equal(await store.get(retainedKey),'evidence');
  assert.ok(await redis.ttl('ezer:execution-admission:consumed:execution-a')>minimumRetentionSeconds);
  await assert.rejects(()=>verifyWorkerAdmissionReceipt({receipt:f.receipt,store,expected:{repository:SECONDARY_REPOSITORY,issueNumber:7,target:'stage'}}),/missing-worker-receipt/);
  const result=await stopAdmittedTask({taskId:'task-a',commentId:42,token:f.token},f.ports);
  assert.equal(result.containerStopped,true);assert.equal(f.stops.length,1);
 }finally{redis.disconnect();}
});

const TWO_HOURS_MS=2*60*60*1000;
const COMMENT_MAX_AGE_MS=300_000;
const ACCEPTANCE_SKEW_MS=30_000;
const ONE_MILLISECOND=1;
const STOP_REQUEST={taskId:'task-a',commentId:42};
async function acceptanceFixture(acceptanceOffsetMs=-TWO_HOURS_MS,commentAgeMs=1000){
 const f=await fixture();
 const accepted=f.now+acceptanceOffsetMs,created=new Date(accepted-commentAgeMs).toISOString();
 const comment=await f.ports.readComment();
 f.ports.readComment=async()=>({...comment,created_at:created,updated_at:created});
 const ownerActAcceptedAt=new Date(accepted).toISOString();
 return {...f,ports:{...f.ports,nowMs:f.now},ownerActAcceptedAt,
  signedClaims:{...f.claims,control:{...f.control,ownerActAcceptedAt}}};
}
test('signed acceptance allows delivery two hours later, persists the time, and remains single-use',async()=>{
 const f=await acceptanceFixture(),token=f.sign(f.signedClaims);
 const result=await stopAdmittedTask({...STOP_REQUEST,token},f.ports);
 assert.equal(result.containerStopped,true);assert.equal(f.stops.length,1);
 const consumed=JSON.parse((await f.ports.store.get('ezer:execution-admission:consumed:stop-admission'))!);
 assert.equal(consumed.control.ownerActAcceptedAt,f.ownerActAcceptedAt);
 await assert.rejects(()=>stopAdmittedTask({...STOP_REQUEST,token},f.ports),/replayed-admission/);
 assert.equal(f.stops.length,1);
});
test('adding or changing acceptance without re-signing fails signature verification',async()=>{
 const f=await acceptanceFixture();
 for(const original of [f.token,f.sign(f.signedClaims)]){
  const [payload,signature]=original.split('.');
  const forged=JSON.parse(Buffer.from(payload,'base64url').toString());
  forged.control.ownerActAcceptedAt=new Date(f.now).toISOString();
  const token=Buffer.from(JSON.stringify(forged)).toString('base64url')+'.'+signature;
  await assert.rejects(()=>stopAdmittedTask({...STOP_REQUEST,token},f.ports),/bad-signature/);
 }
 assert.equal(f.stops.length,0);assert.equal(await f.ports.store.get('ezer:execution-admission:consumed:stop-admission'),null);
});
test('unsigned request acceptance cannot revive an expired legacy comment',async()=>{
 const f=await acceptanceFixture();
 const request={...STOP_REQUEST,token:f.token,ownerActAcceptedAt:f.ownerActAcceptedAt,control:{ownerActAcceptedAt:f.ownerActAcceptedAt}};
 await assert.rejects(()=>stopAdmittedTask(request,f.ports),/owner-comment-expired/);
 assert.equal(f.stops.length,0);
});
test('future acceptance beyond clock skew is rejected without consuming admission',async()=>{
 const f=await acceptanceFixture(ACCEPTANCE_SKEW_MS+ONE_MILLISECOND);
 const token=f.sign(f.signedClaims);
 await assert.rejects(()=>stopAdmittedTask({...STOP_REQUEST,token},f.ports),/owner-acceptance-in-future/);
 assert.equal(f.stops.length,0);assert.equal(await f.ports.store.get('ezer:execution-admission:consumed:stop-admission'),null);
 // The same admission remains usable once the clock catches up.
 f.ports.nowMs+=ONE_MILLISECOND;
 assert.equal((await stopAdmittedTask({...STOP_REQUEST,token},f.ports)).containerStopped,true);
});
test('acceptance has no age ceiling and preserves the exact five-minute comment boundary',async()=>{
 const oldAcceptanceMs=-365*24*TWO_HOURS_MS;
 const f=await acceptanceFixture(oldAcceptanceMs,COMMENT_MAX_AGE_MS);
 assert.equal((await stopAdmittedTask({...STOP_REQUEST,token:f.sign(f.signedClaims)},f.ports)).containerStopped,true);
});
for(const age of [COMMENT_MAX_AGE_MS+ONE_MILLISECOND,-ONE_MILLISECOND]){
 test(`comment age at acceptance ${age}ms is refused before consumption`,async()=>{
  const f=await acceptanceFixture(-TWO_HOURS_MS,age);
  await assert.rejects(()=>stopAdmittedTask({...STOP_REQUEST,token:f.sign(f.signedClaims)},f.ports),/owner-comment-expired/);
  assert.equal(f.stops.length,0);assert.equal(await f.ports.store.get('ezer:execution-admission:consumed:stop-admission'),null);
 });
}
for(const age of [COMMENT_MAX_AGE_MS,COMMENT_MAX_AGE_MS+ONE_MILLISECOND,-ONE_MILLISECOND]){
 test(`absent acceptance preserves legacy processing-time boundary at ${age}ms`,async()=>{
  const f=await acceptanceFixture(0,age);
  const invoke=()=>stopAdmittedTask({...STOP_REQUEST,token:f.token},f.ports);
  if(age===COMMENT_MAX_AGE_MS)assert.equal((await invoke()).containerStopped,true);
  else {await assert.rejects(invoke,/owner-comment-expired/);assert.equal(f.stops.length,0);}
 });
}
for(const ownerActAcceptedAt of [null,42,'invalid-date']){
 test(`malformed signed acceptance ${ownerActAcceptedAt} is rejected`,async()=>{
  const f=await acceptanceFixture();
  const token=f.sign({...f.signedClaims,control:{...f.control,ownerActAcceptedAt}});
  await assert.rejects(()=>stopAdmittedTask({...STOP_REQUEST,token},f.ports),/invalid-stop-acceptance-time/);
  assert.equal(f.stops.length,0);
 });
}
test('signed acceptance still binds owner, issue, body, and execution',async()=>{
 for(const changed of [{ownerAccountId:'456'},{bodyDigest:'sha256:forged'},{containerId:'other'},{executionAdmissionId:'other'},{executionOperationId:'other'}]){
  const f=await acceptanceFixture();
  const token=f.sign({...f.signedClaims,control:{...f.signedClaims.control,...changed}});
  await assert.rejects(()=>stopAdmittedTask({...STOP_REQUEST,token},f.ports),/wrong-stop-control/);
  assert.equal(f.stops.length,0);
 }
 const f=await acceptanceFixture();
 const token=f.sign({...f.signedClaims,issueNumber:8});
 await assert.rejects(()=>stopAdmittedTask({...STOP_REQUEST,token},f.ports),/wrong-issue/);
 assert.equal(f.stops.length,0);
});

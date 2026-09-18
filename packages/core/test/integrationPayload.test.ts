import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {requireIntegrationPayload,integrationDigest} from '../src/admission/integrationPayload.js';
import {consumeExecutionAdmission,verifyWorkerAdmissionReceipt} from '../src/admission/ezerExecutionAdmission.js';
const SHA='a'.repeat(40),DIGEST=`sha256:${'b'.repeat(64)}`,EPIC='EP-integration-fixture';
const SECRET='integration-test-secret-at-least-32-bytes';
function payload(){return{epicId:EPIC,repository:'GospeLib/main',featureBranch:'task/integration-fixture',baseSha:SHA,
 children:[{unitId:`${EPIC}-S01`,repository:'GospeLib/main',prNumber:9001,headSha:SHA}],authorityRevision:SHA,unitDigest:DIGEST,manifestDigest:DIGEST,contractDigest:DIGEST,
 manifestApprovalEventId:'approval',permittedScope:{mergeEnumeratedChildHeadsOnly:true,additionalFileEdits:false,stageMerge:false,acceptTestResults:false,approveManifest:false},capstoneChecks:['fixture']};}
test('requires the complete exact digest-bound pre-merge payload',()=>{const p=payload();assert.deepEqual(requireIntegrationPayload(p,integrationDigest(p)),p);assert.throws(()=>requireIntegrationPayload(p,DIGEST));});
for(const branch of ['stage','main','master','../stage','refs/heads/feature','feature//x','feature/'])test(`refuses unsafe integration branch ${branch}`,()=>{const p={...payload(),featureBranch:branch};assert.throws(()=>requireIntegrationPayload(p,integrationDigest(p)),/INVALID/);});
for(const number of [2319,2320])test(`never reuses original no-merge fixture PR ${number}`,()=>{const p=payload();p.children[0].prNumber=number;assert.throws(()=>requireIntegrationPayload(p,integrationDigest(p)),/INVALID/);});
test('rejects duplicate children, foreign repositories and widened integration scope even with matching hashes',()=>{
 const original=payload();for(const p of [{...original,children:[...original.children,...original.children]},{...original,repository:'other/repo'},
 {...original,permittedScope:{...original.permittedScope,stageMerge:true}},{...original,permittedScope:{...original.permittedScope,additionalFileEdits:true}}])assert.throws(()=>requireIntegrationPayload(p,integrationDigest(p)),/INVALID/);
});
function admission(){
 const p=payload(),digest=integrationDigest(p),values=new Map<string,string>();
 const claims={version:1,admissionId:'admission',operationId:'operation',storyId:`${EPIC}:integration:${digest}`,featureThread:EPIC,epicId:EPIC,repository:p.repository,target:p.featureBranch,
 scope:p.children.map(c=>`${c.repository}#${c.prNumber}@${c.headSha}`),authorityRevision:SHA,authorityDigest:digest,issueNumber:9001,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()};
 const encoded=Buffer.from(JSON.stringify(claims)).toString('base64url'),token=`${encoded}.${createHmac('sha256',SECRET).update(encoded).digest('base64url')}`;
 const store={get:async(key:string)=>values.get(key)??null,take:async(key:string)=>{const v=values.get(key)??null;values.delete(key);return v;},consumeAndIssue:async(k:string,r:string,v:string)=>{if(values.has(k))return false;values.set(k,v);values.set(r,v);return true;}};
 return{p,digest,token,store};
}
test('one signed integration receipt cannot start an ordinary worker or be consumed twice',async()=>{
 const f=admission(),expected={repository:f.p.repository,issueNumber:9001};
 const admitted=await consumeExecutionAdmission({token:f.token,signingSecret:SECRET,store:f.store,expected});
 await assert.rejects(()=>verifyWorkerAdmissionReceipt({receipt:admitted.receipt,expected:{...expected,target:f.p.featureBranch},store:f.store}),/integration-worker-binding-changed/);
 await assert.rejects(()=>consumeExecutionAdmission({token:f.token,signingSecret:SECRET,store:f.store,expected}),/replayed-admission/);
});
test('the exact integration worker consumes only its exact digest and target once',async()=>{
 const f=admission(),expected={repository:f.p.repository,issueNumber:9001};
 const admitted=await consumeExecutionAdmission({token:f.token,signingSecret:SECRET,store:f.store,expected});
 await verifyWorkerAdmissionReceipt({receipt:admitted.receipt,expected:{...expected,target:f.p.featureBranch},expectedIntegrationDigest:f.digest,store:f.store});
 await assert.rejects(()=>verifyWorkerAdmissionReceipt({receipt:admitted.receipt,expected:{...expected,target:f.p.featureBranch},expectedIntegrationDigest:f.digest,store:f.store}),/missing-worker-receipt/);
});

import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
let calls=0;
mock.module('../src/index.js',{namedExports:{consumeExecutionAdmission:()=>{calls++;throw Error('unexpected');},createRedisAdmissionStore:()=>{},pendingExecutionAdmissionKey:()=>'',getAuthenticatedOctokit:()=>{calls++;throw Error('unexpected');},issueQueue:{},generateCorrelationId:()=>'',extractLlmFromLabels:()=>'',logger:{}}});
const {enqueueAdmittedComment}=await import('../src/admission/admittedComment.js');
for(const body of ['/ezer pause typed-work:fixture','/ezer resume typed-work:fixture stale','/ezer stop typed-work:fixture','/ezer stop','/ezer accept-review-stop malformed'])test(`rejects reserved control before GitHub or admission use: ${body}`,async()=>{await assert.rejects(()=>enqueueAdmittedComment({repository:'GospeLib/main',prNumber:2338,commentId:1,body,admissionId:'test'}),/ezer-comment-refused:reserved-owner-control/);assert.equal(calls,0);});

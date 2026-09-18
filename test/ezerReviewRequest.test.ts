import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireReviewRequestMode } from '../packages/core/src/admission/reviewRequest.js';
const admissionId = '7b2a8c82-cd1a-4b89-8f83-465c29cf3a98';
const request = { admissionId, body: `/ezer review ${admissionId}\nModel: gpt-5.6-sol\nRead only`, mode: 'review', models: ['gpt-5.6-sol'], instructions: 'Read only' };
test('signed review cannot become a write-capable correction or change models/instructions', () => {
  requireReviewRequestMode(request);
  for (const change of [{mode:'default'}, {models:['claude']}, {instructions:'Modify files'}, {admissionId:'other'}]) assert.throws(()=>requireReviewRequestMode({...request,...change}),/ezer-review-refused/);
});
test('ordinary correction cannot masquerade as review', () => {
  assert.throws(()=>requireReviewRequestMode({...request,body:'/ezer Fix the completion sentence'}),/ezer-review-refused/);
  requireReviewRequestMode({...request,body:'/ezer Fix the completion sentence',mode:'default'});
});

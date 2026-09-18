import assert from 'node:assert/strict';
import {test} from 'node:test';
import {taskFollowupPullRequest} from '../routes/taskHelpers.js';
const task_id='pr-comments-batch-ezer-13c8dcee-fca6-487d-a436-ce3e0e52eae4';
test('uses persisted PR for original issue output',()=>assert.equal(taskFollowupPullRequest({task_id:'original',issue_number:2337,pr_number:2338}),2338));
test('resolves the signed PR-comment task own PR after correction',()=>assert.equal(taskFollowupPullRequest({task_id,issue_number:2338,pr_number:null}),2338));
for(const invalid of ['original','pr-comments-batch-ezer-forged','pr-comments-batch-ezer-'])test(`refuses unbound issue fallback ${invalid}`,()=>assert.equal(taskFollowupPullRequest({task_id:invalid,issue_number:2337}),undefined));
test('refuses invalid PR numbers',()=>assert.equal(taskFollowupPullRequest({task_id,issue_number:0}),undefined));

import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {simpleGit} from 'simple-git';
import {mergeIntegrationHeads} from '../src/admission/integrationExecution.js';
import type {IntegrationPayload} from '../src/admission/integrationPayload.js';
import {closeConnection} from '../src/index.js';
after(async()=>{await closeConnection();});
test('real Git merges only exact child heads in a detached worktree and leaves stage unchanged',async()=>{
 const root=await mkdtemp(join(tmpdir(),'propr-integration-proof-')),git=simpleGit(root);
 await git.raw(['init','--initial-branch=stage']);await git.addConfig('user.name','Delegated integration test');await git.addConfig('user.email','integration-test@example.invalid');
 await writeFile(join(root,'base.txt'),'base\n');await git.add(['base.txt']);await git.commit('test: fixture base');const base=(await git.revparse(['HEAD'])).trim();
 const children=[];
 for(const [index,file] of ['foundation.txt','dependent.txt'].entries()){
  await git.checkout(['-b',`fixture-${index}`,base]);await writeFile(join(root,file),`${file}\n`);await git.add([file]);await git.commit(`test: ${file}`);
  children.push({unitId:`EP-integration-fixture-S0${index+1}`,repository:'GospeLib/main',prNumber:9001+index,headSha:(await git.revparse(['HEAD'])).trim()});
 }
 await git.checkout('stage');const p={baseSha:base,children} as IntegrationPayload;
 const result=await mergeIntegrationHeads(root,p);
 assert.equal((await git.revparse(['HEAD'])).trim(),base);assert.equal((await git.branch()).current,'stage');
 assert.equal(await readFile(join(result.worktree,'foundation.txt'),'utf8'),'foundation.txt\n');
 assert.equal(await readFile(join(result.worktree,'dependent.txt'),'utf8'),'dependent.txt\n');
 assert.deepEqual((await result.git.diff(['--name-only',base,result.headSha])).trim().split('\n'),['dependent.txt','foundation.txt']);
 assert.equal((await result.git.status()).isClean(),true);
 for(const child of children)await result.git.raw(['merge-base','--is-ancestor',child.headSha,result.headSha]);
 assert.equal((await result.git.raw(['symbolic-ref','-q','HEAD']).catch(()=>'')),'');
});

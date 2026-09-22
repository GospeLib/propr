import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { Redis } from 'ioredis';
import { getAuthenticatedOctokit, ensureRepoCloned, getRepoUrl, AI_COMMIT_AUTHOR, redactAuthenticatedGitUrl } from '../index.js';
import { createRedisAdmissionStore, verifyWorkerAdmissionReceipt } from './ezerExecutionAdmission.js';
import { requireIntegrationPayload, type IntegrationJobData, type IntegrationPayload } from './integrationPayload.js';
const CALLBACK_PATH = '/internal/integration-authority';
const SIGNATURE = 'x-ezer-integration-signature';
const TIMEOUT_MS = 30_000;
const STAGE = 'stage';
const PREFIX = 'ezer-integration-';
export async function mergeIntegrationHeads(clone:string,p:IntegrationPayload) {
  const rootGit=simpleGit(clone),worktree=await mkdtemp(join(tmpdir(),PREFIX));
  await rootGit.raw(['worktree','add','--detach',worktree,p.baseSha]);
  const git=simpleGit(worktree);
  for(const child of p.children) {
    await git.raw(['merge-base','--is-ancestor',p.baseSha,child.headSha]);
    await git.raw(['-c',`user.name=${AI_COMMIT_AUTHOR.name}`,'-c',`user.email=${AI_COMMIT_AUTHOR.email}`,'merge','--no-ff','--no-edit',child.headSha]);
  }
  return {git,worktree,headSha:(await git.revparse(['HEAD'])).trim()};
}
export async function validateCurrentIntegration(data: Pick<IntegrationJobData,'executionDigest'|'operationId'>, fetchImpl = fetch) {
  // Ezer's own base URL. Named EZER_OWNER_RELAY_BASE_URL until S28, when the owner-event relay
  // this shared a variable with was retired; the callback itself is unchanged.
  const base = new URL(process.env.EZER_API_BASE_URL ?? '');
  if (base.username || base.password || !['http:','https:'].includes(base.protocol)) throw Error('INTEGRATION_CALLBACK_CONFIG_INVALID');
  const secret = process.env.EZER_INTERNAL_API_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32) throw Error('INTEGRATION_CALLBACK_SECRET_REQUIRED');
  const body = JSON.stringify({executionDigest:data.executionDigest,operationId:data.operationId});
  const response = await fetchImpl(new URL(CALLBACK_PATH, base), { method:'POST', redirect:'error',
    headers:{'content-type':'application/json',[SIGNATURE]:`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`},
    body, signal:AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw Error(`INTEGRATION_AUTHORITY_REVALIDATION_${response.status}`);
  const result = await response.json() as {valid?:unknown;executionDigest?:unknown;operationId?:unknown};
  if (result.valid !== true || result.executionDigest !== data.executionDigest || result.operationId !== data.operationId)
    throw Error('INTEGRATION_AUTHORITY_REVALIDATION_CHANGED');
}
export async function executeIntegration(data: IntegrationJobData) {
  const p = requireIntegrationPayload(data.payload,data.executionDigest);
  if (Date.parse(data.expiresAt) <= Date.now()) throw Error('INTEGRATION_EXECUTION_EXPIRED');
  const redis = new Redis({host:process.env.REDIS_HOST || '127.0.0.1',port:Number(process.env.REDIS_PORT || '6379')});
  const [owner,repo] = p.repository.split('/');
  const api = await getAuthenticatedOctokit();
  const fresh = async () => {
    if (Date.parse(data.expiresAt) <= Date.now()) throw Error('INTEGRATION_EXECUTION_EXPIRED');
    await validateCurrentIntegration(data);
    for (const child of p.children) {
      const {data:pr} = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}',{owner,repo,pull_number:child.prNumber});
      if (pr.head.sha !== child.headSha || pr.head.repo?.full_name !== p.repository || pr.base.repo.full_name !== p.repository || pr.state !== 'open' || pr.merged)
        throw Error('INTEGRATION_CHILD_HEAD_CHANGED');
    }
  };
  try {
    await verifyWorkerAdmissionReceipt({receipt:data.executionAdmissionReceipt,expected:{repository:p.repository,issueNumber:p.children[0].prNumber,target:p.featureBranch},
      expectedIntegrationDigest:data.executionDigest,store:createRedisAdmissionStore(redis)});
    await fresh();
    try { await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}',{owner,repo,ref:`heads/${p.featureBranch}`}); throw Error('INTEGRATION_BRANCH_ALREADY_EXISTS'); }
    catch(error) { if ((error as {status?:number}).status !== 404) throw error; }
    const auth = await api.auth({type:'installation'}) as {token:string};
    const clone = await ensureRepoCloned({repoUrl:getRepoUrl({repoOwner:owner,repoName:repo}),owner,repoName:repo,authToken:auth.token,baseBranch:STAGE});
    const rootGit = simpleGit(clone);
    await rootGit.raw(['fetch','origin',p.baseSha,...p.children.map(c => c.headSha)]);
    const {git,worktree,headSha}=await mergeIntegrationHeads(clone,p);
    await fresh();
    if ((await git.raw(['ls-remote','--heads','origin',`refs/heads/${p.featureBranch}`])).trim()) throw Error('INTEGRATION_BRANCH_ALREADY_EXISTS');
    // Explicit destination, no force, no stage update, and no arbitrary content changes.
    await git.push(['origin',`${headSha}:refs/heads/${p.featureBranch}`]);
    const {data:remote} = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}',{owner,repo,ref:`heads/${p.featureBranch}`});
    if (remote.object.sha !== headSha) throw Error('INTEGRATION_REMOTE_HEAD_CHANGED');
    await fresh();
    const marker = `<!-- ezer-integration:${data.executionDigest} -->`;
    const {data:prior} = await api.request('GET /repos/{owner}/{repo}/pulls',{owner,repo,state:'all',head:`${owner}:${p.featureBranch}`,base:STAGE});
    if (prior.length) throw Error('INTEGRATION_PR_ALREADY_EXISTS');
    const {data:pr} = await api.request('POST /repos/{owner}/{repo}/pulls',{owner,repo,head:p.featureBranch,base:STAGE,
      title:`${p.epicId}: pre-merge integration fixture`,body:`${marker}\n\nAssistant-executed pre-merge integration only. Manifest ${p.manifestDigest}; contract ${p.contractDigest}.\n\n${JSON.stringify(p.children)}\n\nNo test acceptance, manifest approval or merge to stage is authorized.`});
    return {status:'complete',repository:p.repository,headSha,prNumber:pr.number,url:pr.html_url,executionDigest:data.executionDigest,
      operationId:data.operationId,admissionId:data.admissionId,stageMerge:false,worktree};
  } catch(error) {
    throw Error(redactAuthenticatedGitUrl((error as Error).message));
  } finally { redis.disconnect(); }
}

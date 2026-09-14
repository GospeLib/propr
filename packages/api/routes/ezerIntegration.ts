import type { Request, Response } from 'express';
import { Redis } from 'ioredis';
import { issueQueue, requireIntegrationPayload, consumeExecutionAdmission, createRedisAdmissionStore, pendingExecutionAdmissionKey, validateCurrentIntegration } from '@propr/core';
import { verifyEzerInternalRequest } from '../ezerInternalAuth.js';
const PREFIX = 'ezer-integration-';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const id = (digest:string) => `${PREFIX}${digest.slice('sha256:'.length)}`;
export async function postEzerIntegration(req:Request,res:Response) {
  if (!verifyEzerInternalRequest(req)) { res.status(403).json({error:'INTEGRATION_INTERNAL_AUTH_REQUIRED'}); return; }
  const redis = new Redis({host:process.env.REDIS_HOST || '127.0.0.1',port:Number(process.env.REDIS_PORT || '6379')});
  try {
    const input = req.body, p = requireIntegrationPayload(input?.payload,input?.executionDigest);
    if (input.admissionId !== input.operationId || !/^[a-f0-9-]{36}$/.test(input.operationId) || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())
      throw Error('INTEGRATION_REQUEST_INVALID');
    const prior = await issueQueue.getJob(id(input.executionDigest));
    if (prior) {
      if ((prior.data as any).operationId !== input.operationId || (prior.data as any).executionDigest !== input.executionDigest) throw Error('INTEGRATION_REPLAY_CHANGED');
      res.json({taskId:prior.id,operationId:input.operationId,executionDigest:input.executionDigest}); return;
    }
    await validateCurrentIntegration(input);
    const store = createRedisAdmissionStore(redis), token = await store.get(pendingExecutionAdmissionKey(p.repository,p.children[0].prNumber));
    if (!token) throw Error('INTEGRATION_PENDING_ADMISSION_REQUIRED');
    const {claims,receipt} = await consumeExecutionAdmission({token,store,signingSecret:process.env.EZER_ADMISSION_HMAC_SECRET || '',expected:{repository:p.repository,issueNumber:p.children[0].prNumber}});
    if (claims.admissionId !== input.admissionId || claims.operationId !== input.operationId || claims.epicId !== p.epicId ||
      claims.storyId !== `${p.epicId}:integration:${input.executionDigest}` || claims.authorityDigest !== input.executionDigest ||
      claims.authorityRevision !== p.authorityRevision || claims.target !== p.featureBranch || claims.control || claims.comment || claims.typedWork || claims.artifactCorrection ||
      JSON.stringify(claims.scope) !== JSON.stringify(p.children.map(c => `${c.repository}#${c.prNumber}@${c.headSha}`))) throw Error('INTEGRATION_ADMISSION_BINDING_CHANGED');
    const job = await issueQueue.add('processIntegration',{payload:p,executionDigest:input.executionDigest,operationId:input.operationId,admissionId:input.admissionId,
      issuedAt:claims.issuedAt,expiresAt:claims.expiresAt,executionAdmissionReceipt:receipt},{jobId:id(input.executionDigest),attempts:1,removeOnComplete:false,removeOnFail:false});
    res.status(202).json({taskId:job.id,operationId:input.operationId,executionDigest:input.executionDigest});
  } catch(error) { res.status(409).json({error:(error as Error).message}); }
  finally { redis.disconnect(); }
}
export async function getEzerIntegration(req:Request,res:Response) {
  if (!verifyEzerInternalRequest(req)) { res.status(403).json({error:'INTEGRATION_INTERNAL_AUTH_REQUIRED'}); return; }
  const digest = `sha256:${req.params.digest}`;
  if (!DIGEST.test(digest)) { res.status(400).json({error:'INTEGRATION_DIGEST_INVALID'}); return; }
  const job = await issueQueue.getJob(id(digest));
  if (!job) { res.status(404).json({error:'INTEGRATION_TASK_NOT_FOUND'}); return; }
  const data = job.data as any;
  res.json({taskId:job.id,executionDigest:digest,operationId:data.operationId,state:await job.getState(),result:job.returnvalue,failedReason:job.failedReason});
}

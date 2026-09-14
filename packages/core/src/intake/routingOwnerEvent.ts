/** Narrow owner-approved relay carriage; no fabricated GitHub signature or direct dispatch. */
import {createHmac} from 'node:crypto';
import {makeIdempotent} from '../utils/errorHandler.js';
import type {PaginatedOctokitInstance} from '../auth/githubAuth.js';
const OWNER_RELAY_PATH='/webhooks/propr-owner-event';
const OWNER_RELAY_REPOSITORY='GospeLib/product-hub';
const OWNER_RELAY_INSTALLATION='161226896';
const OWNER_RELAY_TIMEOUT_MS=30_000;
const OWNER_RELAY_SECRET_MIN_LENGTH=32;
const OWNER_COMMAND=/^\/ezer accept-review-stop (stop:[a-f0-9]+) ([a-f0-9]{40}) (sha256:[a-f0-9]{64}) ([0-9]+)$/;
const STOP_REPOSITORY='GospeLib/main';
const MANIFEST_COMMAND=/^\/ezer approve (sha256:[a-f0-9]{64}) ([a-f0-9]{40})$/;
const RETRY_COMMAND=/^\/ezer retry (EP-[a-zA-Z0-9-]+-S[0-9]+) ([1-9][0-9]*)$/;
const PAUSE_COMMAND=/^\/ezer pause ([a-zA-Z0-9:_-]+)$/;
const RESUME_COMMAND=/^\/ezer resume ([a-zA-Z0-9:_-]+) ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const ROUTE_COMMAND=/^\/ezer use ([^\s]+) ([a-zA-Z0-9:_-]+)$/;
const ROUTE_COMMAND_PREFIX=/^\/ezer use(?:\s|$)/i;
const PAUSE_COMMAND_PREFIX=/^\/ezer (?:pause|resume)(?:\s|$)/i;
const PLAN_COMMAND_PREFIX=/^\/ezer (?:approve|retry)(?:\s|$)/;
const STOP_COMMAND=/^\/ezer stop ([^\s]+)$/;
const OWNER_COMMAND_PREFIX=/^\/ezer accept-review-stop(?:\s|$)/;
const COMMENT_PAGE_SIZE=100;
interface Options{enabled:boolean;stopEnabled?:boolean;planControlEnabled?:boolean;pauseEnabled?:boolean;routeEnabled?:boolean;baseUrl:string;secret:string;fetchImpl?:typeof fetch;now?:()=>Date;replyMalformed?:(event:Record<string,unknown>,deliveryId:string)=>Promise<void>;}
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
/** Ordinary issue feedback, not owner authentication or execution. Never guesses missing binding bytes. */
export async function replyMalformedOwnerCommand(event:Record<string,unknown>,deliveryId:string,providedApi?:Pick<PaginatedOctokitInstance,'request'|'paginate'>):Promise<void>{
 const comment=object(event.comment),issue=object(event.issue),actor=object(comment.user);
 if(!Number.isSafeInteger(comment.id)||!Number.isSafeInteger(issue.number)||typeof comment.body!=='string'||actor.type!=='User')throw new Error('OWNER_COMMAND_REPLY_UNBOUND');
 const api=providedApi??await(await import('../auth/githubAuth.js')).getAuthenticatedOctokit();
 const routeControl=ROUTE_COMMAND_PREFIX.test(comment.body.trim());
 const pauseControl=PAUSE_COMMAND_PREFIX.test(comment.body.trim());
 const wrongStopSurface=STOP_COMMAND.test(comment.body.trim())&&Boolean(issue.pull_request);
 const repository=(wrongStopSurface||pauseControl||routeControl)?STOP_REPOSITORY:OWNER_RELAY_REPOSITORY;
 const [owner,repo]=repository.split('/');
 const {data:actual}=await api.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}',{owner,repo,comment_id:Number(comment.id)});
 if(actual.body!==comment.body||actual.user?.id!==actor.id||actual.created_at!==comment.created_at||actual.updated_at!==comment.updated_at||actual.created_at!==actual.updated_at||actual.issue_url!==`https://api.github.com/repos/${repository}/issues/${issue.number}`)throw new Error('OWNER_COMMAND_REPLY_COMMENT_CHANGED');
 if(wrongStopSurface){const {data:target}=await api.request('GET /repos/{owner}/{repo}/issues/{issue_number}',{owner,repo,issue_number:Number(issue.number)});if(!target.pull_request)throw new Error('OWNER_COMMAND_REPLY_TARGET_CHANGED');}
 const marker=`<!-- idempotency-key: ezer-invalid-${routeControl?'unit-route':pauseControl?'unit-pause':wrongStopSurface?'running-stop':'review-stop'}-${comment.id} -->`;
 const body=routeControl?`Could not apply the route requested in comment ${comment.id}: CHANGE_ROUTE_COMMAND_NOT_ADMITTED.\n\nUse the exact command from Ezer on the canonical unit issue, with ChangeRoute enabled. A route selects one currently configured agent/model for the next unprepared admission. It does not change running work, scope or budget. No route or execution was requested by this refusal.\n\n${marker}`:pauseControl?`Could not apply the unit pause/resume requested in comment ${comment.id}: UNIT_PAUSE_COMMAND_NOT_ADMITTED.\n\nUse the current Ezer pause/resume command on the original execution issue, with the capability enabled and exact canonical unit ID; resume also requires the full current pause-event ID. PR comments cannot authorize this control or a repository correction. Pause lets the current worker finish under its original deadline and holds canonical continuation; resume releases only that recorded hold. No pause, resume or execution was requested by this refusal.\n\n${marker}`:wrongStopSurface?`Could not stop work requested in comment ${comment.id}: STOP_COMMAND_REQUIRES_EXECUTION_ISSUE.\n\nThis is a result pull request. Use Ezer's current running-work stop command on the original execution issue while that exact task is still running. Completed work cannot be cancelled. This PR comment cannot authorize a stop or repository correction. This refusal performs no stop and requests no execution. Check the originating Ezer lifecycle for the task's actual result.\n\n${marker}`:`Could not accept the review checkpoint requested in comment ${comment.id}: INVALID_REVIEW_STOP_COMMAND.\n\nPost a fresh, unedited comment using the complete command from Ezer's planning review status on one line. It must contain the exact stop ID, 40-character revision, sha256 digest with all 64 hexadecimal characters, and review comment ID, separated by single spaces. No review stop was accepted; no approval or execution occurred.\n\n${marker}`;
 const reply=makeIdempotent(
  ()=>api.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments',{owner,repo,issue_number:Number(issue.number),body}),
  async()=>{const comments=await api.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments',{owner,repo,issue_number:Number(issue.number),per_page:COMMENT_PAGE_SIZE});return comments.some(x=>x.user?.type==='Bot'&&x.body?.includes(marker));},
  `invalid_owner_command_${deliveryId}`,
 );
 // Failed readback or ambiguous POST propagates to existing delivery retry; no blind POST loop.
 await reply();
}
export async function forwardRoutingOwnerEvent(payload:unknown,eventType:string,deliveryId:string,installationId:unknown,options:Options={enabled:process.env.EZER_OWNER_RELAY_ENABLED==='true',stopEnabled:process.env.EZER_OWNER_STOP_ENABLED==='true',planControlEnabled:process.env.EZER_OWNER_PLAN_CONTROL_ENABLED==='true',pauseEnabled:process.env.EZER_OWNER_PAUSE_ENABLED==='true',routeEnabled:process.env.EZER_OWNER_ROUTE_ENABLED==='true',baseUrl:process.env.EZER_OWNER_RELAY_BASE_URL??'',secret:process.env.EZER_INTERNAL_API_SECRET??''}):Promise<boolean>{
 const event=object(payload),comment=object(event.comment),repository=object(event.repository),installation=object(event.installation);
 if(eventType!=='issue_comment'||typeof comment.body!=='string')return false;
 const body=comment.body.trim(),isStop=STOP_COMMAND.test(body),isManifest=MANIFEST_COMMAND.test(body),isRetry=RETRY_COMMAND.test(body),isPlanControl=PLAN_COMMAND_PREFIX.test(body),isPauseControl=PAUSE_COMMAND_PREFIX.test(body),isRouteControl=ROUTE_COMMAND_PREFIX.test(body);
 if(!isStop&&!isPlanControl&&!isPauseControl&&!isRouteControl&&!OWNER_COMMAND_PREFIX.test(body))return false;
 if(isRouteControl){
  if(event.action!=='created'||repository.full_name!==STOP_REPOSITORY||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)throw new Error('OWNER_RELAY_DELIVERY_NOT_BOUND');
  if(!options.enabled||!options.routeEnabled||!ROUTE_COMMAND.test(body)||object(event.issue).pull_request){await(options.replyMalformed??replyMalformedOwnerCommand)(event,deliveryId);return true;}
 }
 if(isPauseControl){
  if(event.action!=='created'||repository.full_name!==STOP_REPOSITORY||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)throw new Error('OWNER_RELAY_DELIVERY_NOT_BOUND');
  if(!options.enabled||!options.pauseEnabled||(!PAUSE_COMMAND.test(body)&&!RESUME_COMMAND.test(body))||object(event.issue).pull_request){await(options.replyMalformed??replyMalformedOwnerCommand)(event,deliveryId);return true;}
 }
 if(isPlanControl&&!options.planControlEnabled)throw new Error('OWNER_PLAN_CONTROL_RELAY_NOT_ENABLED');
 if(isPlanControl&&!isManifest&&!isRetry)throw new Error('OWNER_PLAN_CONTROL_COMMAND_INVALID');
 if(isStop&&!options.stopEnabled)throw new Error('OWNER_STOP_RELAY_NOT_ENABLED');
 if(!options.enabled)throw new Error('OWNER_RELAY_NOT_ENABLED');
 if(event.action!=='created'||repository.full_name!==((isStop||isRetry||isPauseControl||isRouteControl)?STOP_REPOSITORY:OWNER_RELAY_REPOSITORY)||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)throw new Error('OWNER_RELAY_DELIVERY_NOT_BOUND');
 if(isRetry&&object(event.issue).pull_request)throw new Error('OWNER_RETRY_ISSUE_REQUIRED');
 if(isManifest&&!object(event.issue).pull_request)throw new Error('OWNER_MANIFEST_CONTRACT_PR_REQUIRED');
 if(isStop&&object(event.issue).pull_request){await(options.replyMalformed??replyMalformedOwnerCommand)(event,deliveryId);return true;}
 if(!isStop&&!isPlanControl&&!isPauseControl&&!isRouteControl&&!OWNER_COMMAND.test(body)){await(options.replyMalformed??replyMalformedOwnerCommand)(event,deliveryId);return true;}
 if(options.secret.length<OWNER_RELAY_SECRET_MIN_LENGTH||!options.baseUrl)throw new Error('OWNER_RELAY_CONFIGURATION_MISSING');
 const envelope={kind:'propr-relay-owner-event',version:1,deliveryId,eventType,installationId:String(installationId),issuedAt:(options.now?.()??new Date()).toISOString(),payload:event};
 const raw=JSON.stringify(envelope);
 const response=await(options.fetchImpl??fetch)(`${options.baseUrl.replace(/\/+$/,'')}${OWNER_RELAY_PATH}`,{method:'POST',headers:{'content-type':'application/json','x-ezer-relay-signature':`sha256=${createHmac('sha256',options.secret).update(raw).digest('hex')}`},body:raw,signal:AbortSignal.timeout(OWNER_RELAY_TIMEOUT_MS)});
 if(!response.ok)throw new Error(`OWNER_RELAY_HTTP_${response.status}`);
 const receipt=object(await response.json());
 if(receipt.accepted!==true)throw new Error('OWNER_RELAY_OPERATION_NOT_ACCEPTED');
 return true;
}

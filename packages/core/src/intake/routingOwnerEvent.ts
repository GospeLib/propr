/** Narrow owner-approved relay carriage; no fabricated GitHub signature or direct dispatch. */
import {createHmac} from 'node:crypto';
import {makeIdempotent} from '../utils/errorHandler.js';
import {filterCommentByAuthor} from '../utils/commentFilters.js';
import log from '../utils/logger.js';
import type {PaginatedOctokitInstance} from '../auth/githubAuth.js';
const OWNER_RELAY_PATH='/webhooks/propr-owner-event';
const OWNER_RELAY_REPOSITORY='GospeLib/product-hub';
const OWNER_RELAY_INSTALLATION='161226896';
const OWNER_RELAY_TIMEOUT_MS=30_000;
const OWNER_RELAY_SECRET_MIN_LENGTH=32;
const OWNER_COMMAND=/^\/ezer accept-review-stop (stop:[a-f0-9]+) ([a-f0-9]{40}) (sha256:[a-f0-9]{64}) ([0-9]+)$/;
const STOP_REPOSITORY='GospeLib/main';
const MANIFEST_COMMAND=/^\/ezer approve (sha256:[a-f0-9]{64}) ([a-f0-9]{40})$/;
/** An Ezer delivery unit: an approved story, or one of its repository lanes `<story>-T<nn>`. */
const DELIVERY_UNIT_ID_SOURCE='EP-[a-zA-Z0-9-]+-S[0-9]+(?:-T[0-9]+)?';
const RETRY_COMMAND=new RegExp(`^/ezer retry (${DELIVERY_UNIT_ID_SOURCE}) ([1-9][0-9]*)$`);
const PAUSE_COMMAND=/^\/ezer pause ([a-zA-Z0-9:_-]+)$/;
const RESUME_COMMAND=/^\/ezer resume ([a-zA-Z0-9:_-]+) ([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const ROUTE_COMMAND=/^\/ezer use ([^\s]+) ([a-zA-Z0-9:_-]+)$/;
const READ_COMMAND=/^\/ezer (help|status)$/;
const READ_COMMAND_PREFIX=/^\/ezer (?:help|status)(?:\s|$)/i;
const ROUTE_COMMAND_PREFIX=/^\/ezer use(?:\s|$)/i;
const PAUSE_COMMAND_PREFIX=/^\/ezer (?:pause|resume)(?:\s|$)/i;
const PLAN_COMMAND_PREFIX=/^\/ezer (?:approve|retry)(?:\s|$)/;
const STOP_COMMAND=/^\/ezer stop ([^\s]+)$/;
const OWNER_COMMAND_PREFIX=/^\/ezer accept-review-stop(?:\s|$)/;
/** Any comment addressed to Ezer, whatever follows the address. */
const EZER_ADDRESS_PREFIX=/^\/ezer(?:\s|$)/i;
/** The only two surfaces an owner command is ever carried from. */
const OWNER_SURFACE_REPOSITORIES=new Set([STOP_REPOSITORY,OWNER_RELAY_REPOSITORY]);
const COMMENT_PAGE_SIZE=100;
const READ_SESSION_NAMESPACE='github-issue';
/** The owner's stable numeric GitHub user ID; a login can be renamed or reused, an ID cannot. */
const OWNER_AUTHOR_ID_PATTERN=/^[0-9]+$/;
interface Options{enabled:boolean;stopEnabled?:boolean;planControlEnabled?:boolean;pauseEnabled?:boolean;routeEnabled?:boolean;readEnabled?:boolean;baseUrl:string;secret:string;ownerUserId?:string;fetchImpl?:typeof fetch;now?:()=>Date;replyMalformed?:(event:Record<string,unknown>,deliveryId:string)=>Promise<void>;onReadback?:(result:Record<string,unknown>)=>Promise<void>;}
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
/**
 * Authorship policy for anything ProPR itself writes back on an `/ezer` comment. Two gates, both
 * required: the configured owner's stable GitHub user ID, and `filterCommentByAuthor` — the same
 * whitelist/blacklist/bot policy every normal intake surface (webhook comment handler, PR and issue
 * pollers) applies before acting on a comment. Fail-closed: no configured owner ID, no reply.
 */
function ownerAuthored(comment:Record<string,unknown>,ownerUserId:string):boolean{
 const actor=object(comment.user);
 if(!OWNER_AUTHOR_ID_PATTERN.test(ownerUserId))return false;
 if(actor.type!=='User'||!Number.isSafeInteger(actor.id)||String(actor.id)!==ownerUserId)return false;
 return typeof actor.login==='string'&&actor.login.length>0&&!filterCommentByAuthor(actor.login,actor.type,null).shouldFilter;
}
function configuredOwnerUserId(options:Options):string{return options.ownerUserId??process.env.EZER_OWNER_GITHUB_USER_ID??'';}
async function relay(event:Record<string,unknown>,eventType:string,deliveryId:string,installationId:unknown,options:Options):Promise<Record<string,unknown>>{
 if(options.secret.length<OWNER_RELAY_SECRET_MIN_LENGTH||!options.baseUrl)throw new Error('OWNER_RELAY_CONFIGURATION_MISSING');
 const raw=JSON.stringify({kind:'propr-relay-owner-event',version:1,deliveryId,eventType,installationId:String(installationId),issuedAt:(options.now?.()??new Date()).toISOString(),payload:event});
 const response=await(options.fetchImpl??fetch)(`${options.baseUrl.replace(/\/+$/,'')}${OWNER_RELAY_PATH}`,{method:'POST',headers:{'content-type':'application/json','x-ezer-relay-signature':`sha256=${createHmac('sha256',options.secret).update(raw).digest('hex')}`},body:raw,signal:AbortSignal.timeout(OWNER_RELAY_TIMEOUT_MS),redirect:'error'});
 if(!response.ok)throw new Error(`OWNER_RELAY_HTTP_${response.status}`);
 const receipt=object(await response.json());
 if(receipt.accepted!==true)throw new Error('OWNER_RELAY_OPERATION_NOT_ACCEPTED');
 return receipt;
}
/** Ordinary issue feedback, not owner authentication or execution. Never guesses missing binding bytes. */
export async function replyMalformedOwnerCommand(event:Record<string,unknown>,deliveryId:string,providedApi?:Pick<PaginatedOctokitInstance,'request'|'paginate'>):Promise<void>{
 const comment=object(event.comment),issue=object(event.issue),actor=object(comment.user);
 if(!Number.isSafeInteger(comment.id)||!Number.isSafeInteger(issue.number)||typeof comment.body!=='string'||actor.type!=='User')throw new Error('OWNER_COMMAND_REPLY_UNBOUND');
 // Author policy before any GitHub read or write: an unauthorised commenter must cost no API
 // call at all. Callers gate first, so reaching this is a caller bug, not attacker-reachable.
 if(!ownerAuthored(comment,process.env.EZER_OWNER_GITHUB_USER_ID??''))throw new Error('OWNER_COMMAND_REPLY_NOT_AUTHORIZED');
 // Each refusal class is keyed on an EXACT command shape, so a recognised verb carrying wrong
 // arguments is not mistaken for that command and answered with its message on its repository.
 const trimmed=comment.body.trim();
 const routeControl=ROUTE_COMMAND.test(trimmed);
 const pauseControl=PAUSE_COMMAND.test(trimmed)||RESUME_COMMAND.test(trimmed);
 const wrongStopSurface=STOP_COMMAND.test(trimmed)&&Boolean(issue.pull_request);
 const checkpointControl=OWNER_COMMAND_PREFIX.test(trimmed)&&!OWNER_COMMAND.test(trimmed);
 // An EXACT read command that could not be bound to a planning issue — the wrong surface, not
 // the wrong words. Told apart from `unrecognized` so the owner is not answered "this matches no
 // Ezer command" about a command that plainly is one.
 const readControl=READ_COMMAND.test(trimmed);
 // Anything else addressed to Ezer — free prose, or a recognised verb with wrong arguments.
 const unrecognized=!readControl&&!routeControl&&!pauseControl&&!wrongStopSurface&&!checkpointControl;
 // Answered on the comment's own surface whenever the event carries one (the owner wrote it
 // there), never on a repository inferred from a command it does not contain.
 const eventRepository=String(object(event.repository).full_name??'');
 if(eventRepository?!OWNER_SURFACE_REPOSITORIES.has(eventRepository):unrecognized)throw new Error('OWNER_COMMAND_REPLY_UNBOUND');
 const repository=eventRepository||((readControl||wrongStopSurface||pauseControl||routeControl)?STOP_REPOSITORY:OWNER_RELAY_REPOSITORY);
 const api=providedApi??await(await import('../auth/githubAuth.js')).getAuthenticatedOctokit();
 const [owner,repo]=repository.split('/');
 const {data:actual}=await api.request('GET /repos/{owner}/{repo}/issues/comments/{comment_id}',{owner,repo,comment_id:Number(comment.id)});
 if(actual.body!==comment.body||actual.user?.id!==actor.id||actual.created_at!==comment.created_at||actual.updated_at!==comment.updated_at||actual.created_at!==actual.updated_at||actual.issue_url!==`https://api.github.com/repos/${repository}/issues/${issue.number}`)throw new Error('OWNER_COMMAND_REPLY_COMMENT_CHANGED');
 if(wrongStopSurface){const {data:target}=await api.request('GET /repos/{owner}/{repo}/issues/{issue_number}',{owner,repo,issue_number:Number(issue.number)});if(!target.pull_request)throw new Error('OWNER_COMMAND_REPLY_TARGET_CHANGED');}
 const marker=`<!-- idempotency-key: ezer-invalid-${unrecognized?'unknown-command':readControl?'unit-read':routeControl?'unit-route':pauseControl?'unit-pause':wrongStopSurface?'running-stop':'review-stop'}-${comment.id} -->`;
 const body=readControl?`Could not answer the read requested in comment ${comment.id}: READ_COMMAND_NOT_ADMITTED.\n\nPost \`/ezer help\` or \`/ezer status\` on an Ezer planning issue in ${STOP_REPOSITORY} — not on a pull request — with the read capability enabled. A read reports what Ezer already holds; it plans, approves, starts and changes nothing, and this refusal read nothing and requested no execution.\n\n${marker}`:unrecognized?`Could not act on comment ${comment.id}: EZER_COMMAND_NOT_RECOGNIZED.\n\nComments beginning with \`/ezer\` are read as commands, not as instructions in prose. This comment matches no Ezer command, so nothing was planned, approved, paused, routed, retried or stopped, and no work was started or changed by it. Post \`/ezer help\` on a planning issue for the exact commands and their arguments. To direct new work, take it through the normal planning lifecycle rather than a free-text comment.\n\n${marker}`:routeControl?`Could not apply the route requested in comment ${comment.id}: CHANGE_ROUTE_COMMAND_NOT_ADMITTED.\n\nUse the exact command from Ezer on the canonical unit issue, with ChangeRoute enabled. A route selects one currently configured agent/model for the next unprepared admission. It does not change running work, scope or budget. No route or execution was requested by this refusal.\n\n${marker}`:pauseControl?`Could not apply the unit pause/resume requested in comment ${comment.id}: UNIT_PAUSE_COMMAND_NOT_ADMITTED.\n\nUse the current Ezer pause/resume command on the original execution issue, with the capability enabled and exact canonical unit ID; resume also requires the full current pause-event ID. PR comments cannot authorize this control or a repository correction. Pause lets the current worker finish under its original deadline and holds canonical continuation; resume releases only that recorded hold. No pause, resume or execution was requested by this refusal.\n\n${marker}`:wrongStopSurface?`Could not stop work requested in comment ${comment.id}: STOP_COMMAND_REQUIRES_EXECUTION_ISSUE.\n\nThis is a result pull request. Use Ezer's current running-work stop command on the original execution issue while that exact task is still running. Completed work cannot be cancelled. This PR comment cannot authorize a stop or repository correction. This refusal performs no stop and requests no execution. Check the originating Ezer lifecycle for the task's actual result.\n\n${marker}`:`Could not accept the review checkpoint requested in comment ${comment.id}: INVALID_REVIEW_STOP_COMMAND.\n\nPost a fresh, unedited comment using the complete command from Ezer's planning review status on one line. It must contain the exact stop ID, 40-character revision, sha256 digest with all 64 hexadecimal characters, and review comment ID, separated by single spaces. No review stop was accepted; no approval or execution occurred.\n\n${marker}`;
 const reply=makeIdempotent(
  ()=>api.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments',{owner,repo,issue_number:Number(issue.number),body}),
  async()=>{const comments=await api.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments',{owner,repo,issue_number:Number(issue.number),per_page:COMMENT_PAGE_SIZE});return comments.some(x=>x.user?.type==='Bot'&&x.body?.includes(marker));},
  `invalid_owner_command_${deliveryId}`,
 );
 // Failed readback or ambiguous POST propagates to existing delivery retry; no blind POST loop.
 await reply();
}
export async function forwardRoutingOwnerEvent(payload:unknown,eventType:string,deliveryId:string,installationId:unknown,options:Options={enabled:process.env.EZER_OWNER_RELAY_ENABLED==='true',stopEnabled:process.env.EZER_OWNER_STOP_ENABLED==='true',planControlEnabled:process.env.EZER_OWNER_PLAN_CONTROL_ENABLED==='true',pauseEnabled:process.env.EZER_OWNER_PAUSE_ENABLED==='true',routeEnabled:process.env.EZER_OWNER_ROUTE_ENABLED==='true',readEnabled:process.env.EZER_OWNER_READ_ENABLED==='true',baseUrl:process.env.EZER_OWNER_RELAY_BASE_URL??'',secret:process.env.EZER_INTERNAL_API_SECRET??''}):Promise<boolean>{
 const event=object(payload),comment=object(event.comment),repository=object(event.repository),installation=object(event.installation);
 if(eventType!=='issue_comment'||typeof comment.body!=='string')return false;
 const body=comment.body.trim(),isStop=STOP_COMMAND.test(body),isManifest=MANIFEST_COMMAND.test(body),isRetry=RETRY_COMMAND.test(body),isPlanControl=PLAN_COMMAND_PREFIX.test(body),isPauseControl=PAUSE_COMMAND_PREFIX.test(body),isRouteControl=ROUTE_COMMAND_PREFIX.test(body);
 // Not addressed to Ezer at all: an ordinary comment, handled by the normal path.
 if(!EZER_ADDRESS_PREFIX.test(body))return false;
 const ownerUserId=configuredOwnerUserId(options),authorized=ownerAuthored(comment,ownerUserId);
 const boundDelivery=event.action==='created'&&OWNER_SURFACE_REPOSITORIES.has(String(repository.full_name))&&String(installationId)===OWNER_RELAY_INSTALLATION&&String(installation.id)===OWNER_RELAY_INSTALLATION;
 // An exact command is the only thing ever admitted or relayed. Everything else addressed to
 // Ezer — a recognised verb with wrong arguments just as much as free prose — is answered once
 // with bounded idempotent feedback and ACKed, never thrown, so a permanently invalid comment
 // can never drive endless relay redelivery.
 const isExactCommand=READ_COMMAND.test(body)||isStop||isManifest||isRetry||PAUSE_COMMAND.test(body)||RESUME_COMMAND.test(body)||ROUTE_COMMAND.test(body)||OWNER_COMMAND.test(body);
 if(!isExactCommand){
  // An unbound, relay-disabled or unauthorised delivery falls through to ordinary handling
  // rather than throwing, so stray `/ezer` chatter can never withhold an ACK, and a comment
  // from anyone but the owner costs no GitHub read and no bot reply at all.
  if(!options.enabled||!boundDelivery||!authorized)return false;
  await(options.replyMalformed??replyMalformedOwnerCommand)(event,deliveryId);
  return true;
 }
 // An exact command whose capability is off, or which names the wrong surface, is refused the
 // same bounded way — but only for the owner, and only on a surface Ezer answers on; anyone or
 // anywhere else falls through to ordinary handling, which ACKs rather than withholding.
 const refuse=async():Promise<boolean>=>{if(!authorized||!OWNER_SURFACE_REPOSITORIES.has(String(repository.full_name)))return false;await(options.replyMalformed??replyMalformedOwnerCommand)(event,deliveryId);return true;};
 if(READ_COMMAND_PREFIX.test(body)){
  // TRANSIENT, so still thrown: a capability an operator turns on makes the SAME redelivery
  // succeed, which is exactly what withholding the ACK is for.
  if(!options.enabled||!options.readEnabled)throw Error('OWNER_READ_RELAY_NOT_ENABLED');
  const command=READ_COMMAND.exec(body);
  // PERMANENTLY UNBINDABLE, so never thrown. Every condition here is a property of the delivered
  // payload itself — action, surface repository, issue-vs-PR, installation — so redelivery
  // carries identical bytes and can never satisfy it. Throwing withheld the ACK and had the
  // relay redeliver one permanently unbindable comment forever; that is the failure class
  // 7382569b closed for malformed commands, and a read command on a PR surface was still in it.
  // Answered once, bounded and idempotent, on the comment's own surface, then ACKed. Everything
  // below that could succeed later — the relay POST, a receipt that does not correlate — still
  // throws and is retried.
  if(!command||event.action!=='created'||repository.full_name!==STOP_REPOSITORY||object(event.issue).pull_request||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)return refuse();
  const receipt=await relay(event,eventType,deliveryId,installationId,options),correlation=object(receipt.correlation),result=object(receipt.result),links=object(result.links),issue=object(event.issue);
  const sessionId=`${READ_SESSION_NAMESPACE}:${repository.id}:${issue.id}`;
  if(!Number.isSafeInteger(repository.id)||!Number.isSafeInteger(issue.id)||typeof receipt.operationId!=='string'||correlation.operationId!==receipt.operationId||result.operationId!==receipt.operationId||correlation.repository!==STOP_REPOSITORY||correlation.issueNumber!==issue.number||correlation.commentId!==comment.id||correlation.sessionId!==sessionId||links.sessionId!==sessionId||result.state!=='SUCCEEDED'||links.command!==command[1]||typeof links.text!=='string')throw Error('OWNER_READ_REPLY_NOT_BOUND');
  if(options.onReadback)await options.onReadback(receipt);else log.info({deliveryId,readback:receipt},'Ezer authenticated native read settled');
  return true;
 }
 if(isRouteControl){
  if(event.action!=='created'||repository.full_name!==STOP_REPOSITORY||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)throw new Error('OWNER_RELAY_DELIVERY_NOT_BOUND');
  if(!options.enabled||!options.routeEnabled||object(event.issue).pull_request)return refuse();
 }
 if(isPauseControl){
  if(event.action!=='created'||repository.full_name!==STOP_REPOSITORY||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)throw new Error('OWNER_RELAY_DELIVERY_NOT_BOUND');
  if(!options.enabled||!options.pauseEnabled||object(event.issue).pull_request)return refuse();
 }
 if(isPlanControl&&!options.planControlEnabled)throw new Error('OWNER_PLAN_CONTROL_RELAY_NOT_ENABLED');
 if(isStop&&!options.stopEnabled)throw new Error('OWNER_STOP_RELAY_NOT_ENABLED');
 if(!options.enabled)throw new Error('OWNER_RELAY_NOT_ENABLED');
 if(event.action!=='created'||repository.full_name!==((isStop||isRetry||isPauseControl||isRouteControl)?STOP_REPOSITORY:OWNER_RELAY_REPOSITORY)||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)throw new Error('OWNER_RELAY_DELIVERY_NOT_BOUND');
 if(isRetry&&object(event.issue).pull_request)throw new Error('OWNER_RETRY_ISSUE_REQUIRED');
 if(isManifest&&!object(event.issue).pull_request)throw new Error('OWNER_MANIFEST_CONTRACT_PR_REQUIRED');
 if(isStop&&object(event.issue).pull_request)return refuse();
 await relay(event,eventType,deliveryId,installationId,options);
 return true;
}

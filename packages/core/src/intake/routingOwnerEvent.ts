/** Narrow owner-approved relay carriage; no fabricated GitHub signature or direct dispatch. */
import {createHmac} from 'node:crypto';
import {makeIdempotent} from '../utils/errorHandler.js';
import {filterCommentByAuthor} from '../utils/commentFilters.js';
import log from '../utils/logger.js';
import type {PaginatedOctokitInstance} from '../auth/githubAuth.js';
import type {DeliveryDisposition} from './routingWebSocketProtocol.js';
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
/**
 * `/ezer` is a PUBLICLY REACHABLE namespace: anyone with a GitHub account can post a comment
 * containing it on a watched pull request or issue. Everything addressed to Ezer is therefore
 * owned by THIS intake path and never handed to the ordinary comment dispatcher, which accepts
 * ordinary human authors and can enqueue work. A delivery this path refuses terminally is ACKed
 * with an explicit `ignored` status — not thrown (which withholds the ACK and lets an outsider
 * force endless redelivery) and not returned as unhandled (which would fall through to that
 * dispatcher). Neither consumes a seat.
 */
const EZER_NOT_OWNER_DISPOSITION:DeliveryDisposition=Object.freeze({status:'ignored',reason:'user_not_allowed',billing:Object.freeze({seatConsumed:false})});
/** Owner-authored, but on a delivery this path can neither admit nor answer; see above. */
const EZER_COMMAND_NOT_ADMITTED_DISPOSITION:DeliveryDisposition=Object.freeze({status:'ignored',reason:'ezer_command_not_admitted',billing:Object.freeze({seatConsumed:false})});
export {EZER_NOT_OWNER_DISPOSITION,EZER_COMMAND_NOT_ADMITTED_DISPOSITION};
/**
 * THE `/ezer` AUTHORIZATION CHOKEPOINT.
 *
 * `/ezer` is a publicly reachable namespace: any GitHub user can post a comment containing it on
 * any pull request or issue in a watched repository. Three consecutive reviews found the same
 * authorization bypass through three different reachable paths, because each fix was installed at
 * ONE call site rather than at the boundary every path shares:
 *
 *   1. the exact owner commands reached `relay()` unauthenticated  — fixed at `forwardRoutingOwnerEvent`;
 *   2. `pull_request_review_comment` skipped that gate entirely     — fixed by keying it on "carries a comment body";
 *   3. `direct_webhook` never invokes that gate at all             — fixed HERE.
 *
 * This function is that shared boundary's decision. It is invoked as the FIRST decision of
 * `processCommentEvent` (packages/core/src/webhook/commentEventHandler.ts) — the single function
 * in the codebase that runs `parseSlashCommand`, and therefore the ONLY place the production
 * parser's `/ezer` → `/fix` alias can be reached. Every intake mode (routing WebSocket, direct
 * webhook), every process (daemon, API), every synthetic/system re-entry and every future caller
 * reaches the slash dispatcher through that one function, so gating it there dominates all of them
 * instead of guarding them one at a time.
 *
 * Fail closed, on the STABLE NUMERIC GitHub user id only — a login or display name is spoofable and
 * is never the identity gate. With no configured owner id, nothing addressed to Ezer is admitted.
 *
 * @returns `null` when the comment may continue down the ordinary path — either it is not addressed
 * to Ezer at all, or it is and the configured owner wrote it (authorization passed; the Ezer-specific
 * handling downstream, including the cryptographically bound signed-review admission, is unchanged).
 * Otherwise the terminal {@link EZER_NOT_OWNER_DISPOSITION}: ACKed `ignored`, no seat consumed, no
 * fall-through to the dispatcher, and no withheld ACK an outsider could use to force redelivery.
 */
export function claimEzerAddressedComment(comment:unknown):DeliveryDisposition|null{
 const claim=classifyEzerAddressedComment(comment,process.env.EZER_OWNER_GITHUB_USER_ID??'');
 if(!claim.addressed)return null;
 return claim.ownerAuthored?null:EZER_NOT_OWNER_DISPOSITION;
}
/**
 * Shared classification behind BOTH the refusal and the resolution, so the two can never drift.
 * PRIVATE — not exported. The `ownerUserId` parameter is a test-only dependency-injection seam;
 * both exported entry points ({@link claimEzerAddressedComment},
 * {@link resolveOwnerEzerCommandBody}) always read the configured owner from
 * `process.env.EZER_OWNER_GITHUB_USER_ID` themselves and never forward a caller-supplied value,
 * so no importer of this module can redefine who the owner is.
 */
function classifyEzerAddressedComment(comment:unknown,ownerUserId:string):{addressed:false}|{addressed:true;ownerAuthored:boolean;body:string}{
 const candidate=object(comment);
 if(typeof candidate.body!=='string')return{addressed:false};
 if(!EZER_ADDRESS_PREFIX.test(candidate.body.trim()))return{addressed:false};
 return{addressed:true,ownerAuthored:ownerAuthored(candidate,ownerUserId),body:candidate.body};
}
/**
 * The command line exactly as the slash parser must see it, with the leading `/ezer` token
 * rewritten to `/fix` — the one and only place the `/ezer` address acquires a command meaning.
 *
 * This resolution used to live in the generally-exported slash parser as a `COMMAND_ALIASES`
 * entry, which meant ANY consumer of that parser — a namespace import, a dynamic `import()`, a
 * CommonJS property read, a new file under an unscanned root — acquired the `/ezer` -> `/fix`
 * mapping for free, authorized or not. Reachability of the alias then depended on a structural
 * test noticing every new import shape, which is exactly the coverage assumption that produced
 * three consecutive authorization bypasses. Here it instead depends on passing authorization:
 * a comment that is not owner-authored gets `null` and therefore no command at all, however it
 * reached this code.
 *
 * Case-sensitive on the `/ezer` token and applied only to the first line, reproducing byte for
 * byte what the old alias table matched, so the owner's command parses exactly as before.
 *
 * @returns the rewritten body when the configured owner addressed Ezer, otherwise `null`.
 */
export function resolveOwnerEzerCommandBody(comment:unknown):string|null{
 const claim=classifyEzerAddressedComment(comment,process.env.EZER_OWNER_GITHUB_USER_ID??'');
 if(!claim.addressed||!claim.ownerAuthored)return null;
 const firstNewline=claim.body.indexOf('\n');
 const firstLine=firstNewline===-1?claim.body:claim.body.slice(0,firstNewline);
 if(!EZER_COMMAND_TOKEN.test(firstLine))return null;
 return firstLine.replace(EZER_COMMAND_TOKEN,'$1/fix')+(firstNewline===-1?'':claim.body.slice(firstNewline));
}
/** The leading `/ezer` token on the command line, case-sensitive exactly as the old alias key was. */
const EZER_COMMAND_TOKEN=/^(\s*)\/ezer(?=\s|$)/;
/**
 * The only comment event type an owner command is ever carried from. ProPR's intake supports
 * exactly two comment-bearing GitHub events — `issue_comment` and `pull_request_review_comment`
 * (see SUPPORTED_WEBHOOK_EVENTS in ../webhook/webhookHandler.ts) — and the ordinary dispatcher's
 * slash parser aliases `/ezer` to `/fix` on BOTH. Every owner command binds to a planning issue
 * or a contract pull request delivered as `issue_comment`; a review comment can carry none of
 * them, but it must still be CLAIMED here rather than returned unhandled.
 */
const OWNER_COMMAND_EVENT_TYPE='issue_comment';
/**
 * Reply-helper refusals that are permanent for a given delivery: the comment was edited or
 * removed after it was delivered, its target is not what the delivered bytes said, or the reply
 * could never be bound at all. GitHub never un-edits a comment, so an identical redelivery hits
 * the identical refusal — ACK terminally instead of looping. Anything else the helper throws (a
 * GitHub read or write failure, an ambiguous POST) still propagates and is retried.
 */
const TERMINAL_REPLY_FAILURES=new Set(['OWNER_COMMAND_REPLY_UNBOUND','OWNER_COMMAND_REPLY_NOT_AUTHORIZED','OWNER_COMMAND_REPLY_COMMENT_CHANGED','OWNER_COMMAND_REPLY_TARGET_CHANGED']);
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
 // An EXACT plan control on the wrong surface: `retry` belongs on an execution issue and
 // `approve` on a contract pull request. Told apart from `unrecognized` for the same reason as
 // `readControl` — the owner is not told a real command matches nothing.
 const wrongPlanSurface=(RETRY_COMMAND.test(trimmed)&&Boolean(issue.pull_request))||(MANIFEST_COMMAND.test(trimmed)&&!issue.pull_request);
 const checkpointControl=OWNER_COMMAND_PREFIX.test(trimmed)&&!OWNER_COMMAND.test(trimmed);
 // An EXACT read command that could not be bound to a planning issue — the wrong surface, not
 // the wrong words. Told apart from `unrecognized` so the owner is not answered "this matches no
 // Ezer command" about a command that plainly is one.
 const readControl=READ_COMMAND.test(trimmed);
 // Anything else addressed to Ezer — free prose, or a recognised verb with wrong arguments.
 const unrecognized=!readControl&&!routeControl&&!pauseControl&&!wrongStopSurface&&!wrongPlanSurface&&!checkpointControl;
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
 const marker=`<!-- idempotency-key: ezer-invalid-${unrecognized?'unknown-command':readControl?'unit-read':routeControl?'unit-route':pauseControl?'unit-pause':wrongPlanSurface?'unit-plan':wrongStopSurface?'running-stop':'review-stop'}-${comment.id} -->`;
 const body=readControl?`Could not answer the read requested in comment ${comment.id}: READ_COMMAND_NOT_ADMITTED.\n\nPost \`/ezer help\` or \`/ezer status\` on an Ezer planning issue in ${STOP_REPOSITORY} — not on a pull request — with the read capability enabled. A read reports what Ezer already holds; it plans, approves, starts and changes nothing, and this refusal read nothing and requested no execution.\n\n${marker}`:unrecognized?`Could not act on comment ${comment.id}: EZER_COMMAND_NOT_RECOGNIZED.\n\nComments beginning with \`/ezer\` are read as commands, not as instructions in prose. This comment matches no Ezer command, so nothing was planned, approved, paused, routed, retried or stopped, and no work was started or changed by it. Post \`/ezer help\` on a planning issue for the exact commands and their arguments. To direct new work, take it through the normal planning lifecycle rather than a free-text comment.\n\n${marker}`:routeControl?`Could not apply the route requested in comment ${comment.id}: CHANGE_ROUTE_COMMAND_NOT_ADMITTED.\n\nUse the exact command from Ezer on the canonical unit issue, with ChangeRoute enabled. A route selects one currently configured agent/model for the next unprepared admission. It does not change running work, scope or budget. No route or execution was requested by this refusal.\n\n${marker}`:pauseControl?`Could not apply the unit pause/resume requested in comment ${comment.id}: UNIT_PAUSE_COMMAND_NOT_ADMITTED.\n\nUse the current Ezer pause/resume command on the original execution issue, with the capability enabled and exact canonical unit ID; resume also requires the full current pause-event ID. PR comments cannot authorize this control or a repository correction. Pause lets the current worker finish under its original deadline and holds canonical continuation; resume releases only that recorded hold. No pause, resume or execution was requested by this refusal.\n\n${marker}`:wrongPlanSurface?`Could not apply the plan control requested in comment ${comment.id}: PLAN_CONTROL_COMMAND_WRONG_SURFACE.\n\nPost \`/ezer retry\` on the original execution issue, and \`/ezer approve\` on the contract pull request it was requested from. This comment names the other surface, so nothing was retried, approved, started or changed by it, and no execution was requested by this refusal.\n\n${marker}`:wrongStopSurface?`Could not stop work requested in comment ${comment.id}: STOP_COMMAND_REQUIRES_EXECUTION_ISSUE.\n\nThis is a result pull request. Use Ezer's current running-work stop command on the original execution issue while that exact task is still running. Completed work cannot be cancelled. This PR comment cannot authorize a stop or repository correction. This refusal performs no stop and requests no execution. Check the originating Ezer lifecycle for the task's actual result.\n\n${marker}`:`Could not accept the review checkpoint requested in comment ${comment.id}: INVALID_REVIEW_STOP_COMMAND.\n\nPost a fresh, unedited comment using the complete command from Ezer's planning review status on one line. It must contain the exact stop ID, 40-character revision, sha256 digest with all 64 hexadecimal characters, and review comment ID, separated by single spaces. No review stop was accepted; no approval or execution occurred.\n\n${marker}`;
 const reply=makeIdempotent(
  ()=>api.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments',{owner,repo,issue_number:Number(issue.number),body}),
  async()=>{const comments=await api.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments',{owner,repo,issue_number:Number(issue.number),per_page:COMMENT_PAGE_SIZE});return comments.some(x=>x.user?.type==='Bot'&&x.body?.includes(marker));},
  `invalid_owner_command_${deliveryId}`,
 );
 // Failed readback or ambiguous POST propagates to existing delivery retry; no blind POST loop.
 await reply();
}
export async function forwardRoutingOwnerEvent(payload:unknown,eventType:string,deliveryId:string,installationId:unknown,options:Options={enabled:process.env.EZER_OWNER_RELAY_ENABLED==='true',stopEnabled:process.env.EZER_OWNER_STOP_ENABLED==='true',planControlEnabled:process.env.EZER_OWNER_PLAN_CONTROL_ENABLED==='true',pauseEnabled:process.env.EZER_OWNER_PAUSE_ENABLED==='true',routeEnabled:process.env.EZER_OWNER_ROUTE_ENABLED==='true',readEnabled:process.env.EZER_OWNER_READ_ENABLED==='true',baseUrl:process.env.EZER_OWNER_RELAY_BASE_URL??'',secret:process.env.EZER_INTERNAL_API_SECRET??''}):Promise<boolean|DeliveryDisposition>{
 const event=object(payload),comment=object(event.comment),repository=object(event.repository),installation=object(event.installation),issue=object(event.issue);
 // Claimed on EVERY comment-bearing delivery, whatever the event type. Gating this path on
 // `issue_comment` handed every `/ezer` PULL REQUEST REVIEW comment straight to the ordinary
 // dispatcher, whose slash parser aliases `/ezer` to `/fix` — so with the default (unprotected)
 // admission configuration a stranger's review comment could invalidate automatic work and
 // enqueue a fix job without ever passing `ownerAuthored`. Anything carrying a comment body is
 // inspected here instead, and nothing addressed to Ezer is ever returned unhandled.
 if(typeof comment.body!=='string')return false;
 const body=comment.body.trim();
 // Not addressed to Ezer at all: an ordinary comment, handled by the normal path.
 if(!EZER_ADDRESS_PREFIX.test(body))return false;
 // FAIL CLOSED FIRST, before every capability check and before any relay call: only the
 // configured owner's stable numeric GitHub user ID may be acted on. A login or display name is
 // spoofable and is never the identity gate. Anyone else's `/ezer` comment stops dead here — no
 // relay, no GitHub read, no bot reply, and no fall-through to the ordinary comment dispatcher —
 // and is ACKed `ignored`, so a stranger can neither consume work nor loop the delivery.
 if(!ownerAuthored(comment,configuredOwnerUserId(options)))return EZER_NOT_OWNER_DISPOSITION;
 // Owner-authored, but on a comment surface from which no owner command is ever carried. The
 // event type is a property of the delivered bytes, so redelivery cannot change it: ACK
 // terminally, with no reply and no fall-through.
 if(eventType!==OWNER_COMMAND_EVENT_TYPE)return EZER_COMMAND_NOT_ADMITTED_DISPOSITION;
 const isStop=STOP_COMMAND.test(body),isManifest=MANIFEST_COMMAND.test(body),isRetry=RETRY_COMMAND.test(body),isPlanControl=PLAN_COMMAND_PREFIX.test(body),isPauseControl=PAUSE_COMMAND_PREFIX.test(body),isRouteControl=ROUTE_COMMAND_PREFIX.test(body);
 const boundDelivery=event.action==='created'&&OWNER_SURFACE_REPOSITORIES.has(String(repository.full_name))&&String(installationId)===OWNER_RELAY_INSTALLATION&&String(installation.id)===OWNER_RELAY_INSTALLATION;
 /**
  * The single terminal refusal for an owner-authored delivery this path can neither admit nor
  * relay. Bounded idempotent feedback is attempted only where a reply can ACTUALLY be bound: a
  * `created` delivery, on a surface Ezer answers on, from the expected installation. Every one of
  * those is a property of the DELIVERED BYTES, so an identical redelivery can never satisfy it —
  * throwing withheld the ACK and had the relay redeliver the same permanently unbindable comment
  * forever. Where the reply cannot be bound the delivery is ACKed `ignored` without any GitHub
  * call at all, and a reply the helper itself refuses permanently (an edited or removed comment,
  * a changed target, an unbindable shape) is ACKed the same way rather than retried. Neither
  * outcome consumes a seat, and neither ever falls through to the ordinary comment dispatcher.
  */
 const answer=async():Promise<boolean|DeliveryDisposition>=>{
  if(!boundDelivery)return EZER_COMMAND_NOT_ADMITTED_DISPOSITION;
  try{await(options.replyMalformed??replyMalformedOwnerCommand)(event,deliveryId);}
  catch(error){if(TERMINAL_REPLY_FAILURES.has((error as Error).message))return EZER_COMMAND_NOT_ADMITTED_DISPOSITION;throw error;}
  return true;
 };
 // An exact command is the only thing ever admitted or relayed. Everything else addressed to
 // Ezer — a recognised verb with wrong arguments just as much as free prose — is answered once
 // with bounded idempotent feedback and ACKed, never thrown, so a permanently invalid comment
 // can never drive endless relay redelivery.
 const isExactCommand=READ_COMMAND.test(body)||isStop||isManifest||isRetry||PAUSE_COMMAND.test(body)||RESUME_COMMAND.test(body)||ROUTE_COMMAND.test(body)||OWNER_COMMAND.test(body);
 if(!isExactCommand){
  // A relay-disabled delivery is consumed terminally rather than thrown, so stray `/ezer`
  // chatter can never withhold an ACK — and rather than fallen through, so it can never reach
  // the ordinary comment dispatcher either.
  if(!options.enabled)return EZER_COMMAND_NOT_ADMITTED_DISPOSITION;
  return answer();
 }
 if(READ_COMMAND_PREFIX.test(body)){
  // TRANSIENT, so still thrown: a capability an operator turns on makes the SAME redelivery
  // succeed, which is exactly what withholding the ACK is for.
  if(!options.enabled||!options.readEnabled)throw Error('OWNER_READ_RELAY_NOT_ENABLED');
  const command=READ_COMMAND.exec(body);
  // PERMANENTLY UNBINDABLE, so never thrown. Every condition here is a property of the delivered
  // payload itself — action, surface repository, issue-vs-PR, installation, and the numeric
  // repository/issue identities the read session is keyed on — so redelivery carries identical
  // bytes and can never satisfy it. Answered once, bounded and idempotent, on the comment's own
  // surface, then ACKed. Everything below that could succeed later — the relay POST, a receipt
  // that does not correlate — still throws and is retried.
  if(!command||event.action!=='created'||repository.full_name!==STOP_REPOSITORY||issue.pull_request||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION||!Number.isSafeInteger(repository.id)||!Number.isSafeInteger(issue.id))return answer();
  const receipt=await relay(event,eventType,deliveryId,installationId,options),correlation=object(receipt.correlation),result=object(receipt.result),links=object(result.links);
  const sessionId=`${READ_SESSION_NAMESPACE}:${repository.id}:${issue.id}`;
  if(typeof receipt.operationId!=='string'||correlation.operationId!==receipt.operationId||result.operationId!==receipt.operationId||correlation.repository!==STOP_REPOSITORY||correlation.issueNumber!==issue.number||correlation.commentId!==comment.id||correlation.sessionId!==sessionId||links.sessionId!==sessionId||result.state!=='SUCCEEDED'||links.command!==command[1]||typeof links.text!=='string')throw Error('OWNER_READ_REPLY_NOT_BOUND');
  if(options.onReadback)await options.onReadback(receipt);else log.info({deliveryId,readback:receipt},'Ezer authenticated native read settled');
  return true;
 }
 // Wrong action, wrong repository, wrong installation: all properties of the delivered bytes, so
 // all terminal rather than thrown. `answer()` decides whether the owner can be told.
 if(isRouteControl){
  if(event.action!=='created'||repository.full_name!==STOP_REPOSITORY||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)return answer();
  if(!options.enabled||!options.routeEnabled||issue.pull_request)return answer();
 }
 if(isPauseControl){
  if(event.action!=='created'||repository.full_name!==STOP_REPOSITORY||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)return answer();
  if(!options.enabled||!options.pauseEnabled||issue.pull_request)return answer();
 }
 // MUTABLE CONFIGURATION, so still thrown: an operator flipping the flag makes the identical
 // redelivery succeed.
 if(isPlanControl&&!options.planControlEnabled)throw new Error('OWNER_PLAN_CONTROL_RELAY_NOT_ENABLED');
 if(isStop&&!options.stopEnabled)throw new Error('OWNER_STOP_RELAY_NOT_ENABLED');
 if(!options.enabled)throw new Error('OWNER_RELAY_NOT_ENABLED');
 if(event.action!=='created'||repository.full_name!==((isStop||isRetry||isPauseControl||isRouteControl)?STOP_REPOSITORY:OWNER_RELAY_REPOSITORY)||String(installationId)!==OWNER_RELAY_INSTALLATION||String(installation.id)!==OWNER_RELAY_INSTALLATION)return answer();
 // Issue-vs-PR is likewise fixed in the delivered bytes: a retry belongs on an execution issue,
 // a manifest approval on the contract pull request, a stop on the execution issue.
 if(isRetry&&issue.pull_request)return answer();
 if(isManifest&&!issue.pull_request)return answer();
 if(isStop&&issue.pull_request)return answer();
 await relay(event,eventType,deliveryId,installationId,options);
 return true;
}

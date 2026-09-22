/** The `/ezer` authorization chokepoint: who may address Ezer, and how that address resolves. */
import {filterCommentByAuthor} from '../utils/commentFilters.js';
import type {DeliveryDisposition} from './routingWebSocketProtocol.js';
/** Any comment addressed to Ezer, whatever follows the address. */
const EZER_ADDRESS_PREFIX=/^\/ezer(?:\s|$)/i;
/** The owner's stable numeric GitHub user ID; a login can be renamed or reused, an ID cannot. */
const OWNER_AUTHOR_ID_PATTERN=/^[0-9]+$/;
/**
 * WHAT THIS FILE NO LONGER DOES, AND WHY.
 *
 * It used to carry the owner's `/ezer` comments to Ezer itself: ProPR received the GitHub
 * webhooks through the routing relay, and `forwardRoutingOwnerEvent` posted an attested copy of
 * each owner comment to Ezer's `/webhooks/propr-owner-event`. That inverted the two services —
 * Ezer is the facade over ProPR, not something ProPR calls — and it existed only because Ezer had
 * no ingress of its own.
 *
 * Ezer now receives every GitHub webhook and hands ProPR the deliveries through ProPR's ordinary
 * `/webhook` intake (GospeLib/main, EP-ezer-follow-ups-S28), so the owner's comments reach Ezer
 * first-hand, signed by GitHub. The carriage, its attestation, its per-act switches and the bot
 * reply it posted for a malformed command are gone with it.
 *
 * WHAT STAYS IS THE AUTHORIZATION BOUNDARY, which was never about the relay: `/ezer` is a
 * publicly reachable namespace, and the ordinary dispatcher's slash parser aliases `/ezer` to
 * `/fix`. Three consecutive reviews found the same bypass through three different call sites, so
 * the decision lives here, at the boundary they share, and is invoked as the first decision of
 * `processCommentEvent`.
 */
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

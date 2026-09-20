import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {forwardRoutingOwnerEvent,replyMalformedOwnerCommand,EZER_NOT_OWNER_DISPOSITION,EZER_COMMAND_NOT_ADMITTED_DISPOSITION} from '../src/intake/routingOwnerEvent.js';
import type {PaginatedOctokitInstance} from '../src/auth/githubAuth.js';
const secret='owner-relay-test-secret-at-least-32-bytes',deliveryId='real-routing-delivery-1234',installationId='161226896';
const ownerUserId='7',ownerAuthor={id:7,type:'User',login:'ezer-owner'};
process.env.EZER_OWNER_GITHUB_USER_ID=ownerUserId;
test('native read relay validates correlated settlement and never writes a GitHub reply',async()=>{
 const payload={...fixture(),repository:{id:10,full_name:'GospeLib/main'},issue:{id:20,number:90},comment:{id:66,body:'/ezer help',user:{...ownerAuthor}}};
 let writes=0,readbacks=0;
 const options={enabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{writes++;},onReadback:async(value:Record<string,unknown>)=>{readbacks++;assert.equal(value.operationId,'read-operation');},fetchImpl:async()=>Response.json({accepted:true,operationId:'read-operation',correlation:{repository:'GospeLib/main',issueNumber:90,commentId:66,operationId:'read-operation',sessionId:'github-issue:10:20'},result:{operationId:'read-operation',state:'SUCCEEDED',links:{command:'help',text:'Commands you can invoke:',sessionId:'github-issue:10:20'}}})};
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);
 assert.equal(writes,0);assert.equal(readbacks,1);
 await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,readEnabled:false}),/OWNER_READ_RELAY_NOT_ENABLED/);
 await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,fetchImpl:async()=>Response.json({accepted:true})}),/OWNER_READ_REPLY_NOT_BOUND/);
 const good=await(await options.fetchImpl()).json();
 for(const changes of [{sessionId:'github-issue:10:21'},{commentId:67},{issueNumber:91},{repository:'other/repo'},{operationId:'other-operation'}]){
  await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,fetchImpl:async()=>Response.json({...good,correlation:{...good.correlation,...changes}})}),/OWNER_READ_REPLY_NOT_BOUND/);
 }
 assert.equal(writes,0);
});
for(const [mode,payloadOf] of [
 ['a PR surface',()=>({...fixture(),repository:{id:10,full_name:'GospeLib/main'},issue:{id:20,number:2338,pull_request:{url:'pr'}},comment:{id:66,body:'/ezer help',user:{...ownerAuthor}}})],
 ['the wrong owner repository',()=>({...fixture(),repository:{id:10,full_name:'GospeLib/product-hub'},issue:{id:20,number:90},comment:{id:66,body:'/ezer status',user:{...ownerAuthor}}})],
] as const)test(`a read command on ${mode} is answered once and ACKed, never redelivered forever`,async()=>{
 const payload=payloadOf();let replies=0;
 const options={enabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,
  replyMalformed:async(event:Record<string,unknown>)=>{assert.deepEqual(event,payload);replies++;},
  fetchImpl:async()=>{throw new Error('a permanently unbindable read must never reach the owner relay');}};
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);
 assert.equal(replies,1);
});
test('a read command on a surface Ezer does not answer on is ACKed terminally, never dispatched or looped',async()=>{
 const payload={...fixture(),repository:{id:10,full_name:'someone-else/repo'},issue:{id:20,number:90},comment:{id:66,body:'/ezer help',user:{...ownerAuthor}}};
 let replies=0;
 assert.deepEqual(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{enabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,
  replyMalformed:async()=>{replies++;},fetchImpl:async()=>{throw new Error('must not forward');}}),EZER_COMMAND_NOT_ADMITTED_DISPOSITION);
 assert.equal(replies,0);
});
test('an edited read delivery is ACKed terminally without ever calling the reply helper',async()=>{
 // The PRODUCTION reply helper is deliberately left in place (no `replyMalformed` stub): it
 // re-reads the comment and throws OWNER_COMMAND_REPLY_COMMENT_CHANGED for anything whose
 // `updated_at` has moved, which withheld the ACK and looped this delivery forever. Reaching it
 // at all would also need GitHub credentials this test does not provide, so a passing assertion
 // here proves it is never reached.
 const payload={...fixture(),action:'edited',repository:{id:10,full_name:'GospeLib/main'},issue:{id:20,number:90},
  comment:{id:66,body:'/ezer help',created_at:'2026-09-20T02:30:50Z',updated_at:'2026-09-20T03:11:00Z',user:{...ownerAuthor}}};
 const outcome=await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{enabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,
  fetchImpl:async()=>{throw new Error('a permanently unbindable read must never reach the owner relay');}});
 assert.deepEqual(outcome,EZER_COMMAND_NOT_ADMITTED_DISPOSITION);
 assert.equal(typeof outcome==='object'&&outcome.status,'ignored');
});
test('the production reply helper really does refuse an edited comment',async()=>{
 // The invariant the branch above exists for, asserted against the real helper rather than a stub.
 const comment={id:66,body:'/ezer help',created_at:'2026-09-20T02:30:50Z',updated_at:'2026-09-20T03:11:00Z',issue_url:'https://api.github.com/repos/GospeLib/main/issues/90',user:{...ownerAuthor}};
 const event={comment,issue:{number:90},repository:{full_name:'GospeLib/main'}};
 let posts=0;
 const api={request:async(route:string)=>{if(route.startsWith('GET'))return{data:comment};posts++;return{data:{id:99}};},paginate:async()=>[]} as unknown as Pick<PaginatedOctokitInstance,'request'|'paginate'>;
 await assert.rejects(()=>replyMalformedOwnerCommand(event,deliveryId,api),/OWNER_COMMAND_REPLY_COMMENT_CHANGED/);
 assert.equal(posts,0);
});
test('a transient read failure still withholds the ACK so the same delivery is retried',async()=>{
 const payload={...fixture(),repository:{id:10,full_name:'GospeLib/main'},issue:{id:20,number:90},comment:{id:66,body:'/ezer help',user:{...ownerAuthor}}};
 let replies=0,sends=0;
 const options={enabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;}};
 // The relay itself failing is transient: the identical delivery can succeed on redelivery.
 await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,fetchImpl:async()=>{sends++;return new Response('{}',{status:503});}}),/OWNER_RELAY_HTTP_503/);
 // So is a capability an operator can turn on.
 await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,readEnabled:false,fetchImpl:async()=>{sends++;return Response.json({accepted:true});}}),/OWNER_READ_RELAY_NOT_ENABLED/);
 assert.equal(sends,1);assert.equal(replies,0);
});
test('unbound-read feedback names the read refusal on its own surface and is idempotent',async()=>{
 const comment={id:4242,body:'/ezer help',created_at:'2026-09-20T02:30:50Z',updated_at:'2026-09-20T02:30:50Z',issue_url:'https://api.github.com/repos/GospeLib/main/issues/2338',user:{...ownerAuthor}};
 const event={comment,issue:{number:2338,pull_request:{url:'pr'}},repository:{full_name:'GospeLib/main'}};
 const comments:Array<{body:string;user:{type:string}}>=[];let posts=0;
 const api={request:async(route:string,input:Record<string,unknown>)=>{assert.equal(input.repo,'main');if(route.startsWith('GET'))return{data:route.includes('comments/')?comment:{pull_request:{url:'pr'}}};posts++;comments.push({body:String(input.body),user:{type:'Bot'}});return{data:{id:99}};},paginate:async()=>comments} as unknown as Pick<PaginatedOctokitInstance,'request'|'paginate'>;
 await replyMalformedOwnerCommand(event,deliveryId,api);await replyMalformedOwnerCommand(event,deliveryId,api);
 assert.equal(posts,1);
 assert.match(comments[0].body,/READ_COMMAND_NOT_ADMITTED/);
 assert.match(comments[0].body,/not on a pull request/);
 assert.match(comments[0].body,/ezer-invalid-unit-read-4242/);
});
function fixture(){return{action:'created',installation:{id:161226896},repository:{full_name:'GospeLib/product-hub'},comment:{body:`/ezer accept-review-stop stop:abcd ${'a'.repeat(40)} sha256:${'b'.repeat(64)} 55`,user:{...ownerAuthor}}};}
test('forwards original authenticated delivery metadata and exact payload with explicit attestation only',async()=>{
 const payload=fixture();let calls=0;
 const result=await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{enabled:true,baseUrl:'http://ezer:8791',secret,now:()=>new Date('2026-09-13T18:00:00Z'),fetchImpl:async(url,init)=>{
  calls++;assert.equal(url,'http://ezer:8791/webhooks/propr-owner-event');const raw=String(init?.body),headers=init?.headers as Record<string,string>;
  assert.equal(headers['x-ezer-relay-signature'],`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`);assert.equal(headers.authorization,undefined);assert.equal(headers['x-hub-signature-256'],undefined);
  const body=JSON.parse(raw);assert.equal(body.deliveryId,deliveryId);assert.equal(body.installationId,installationId);assert.deepEqual(body.payload,payload);assert.equal(body.kind,'propr-relay-owner-event');assert.equal(body.installationToken,undefined);return new Response(JSON.stringify({accepted:true}));
 }});assert.equal(result,true);assert.equal(calls,1);
});
for(const mode of ['disabled','installation','repository','edited','missing-config','refused'])test(`refuses ${mode} without normal execution fallback`,async()=>{
 const payload=fixture();if(mode==='repository')payload.repository.full_name='GospeLib/main';if(mode==='edited')payload.action='edited';let calls=0;
 await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,mode==='installation'?'other':installationId,{enabled:mode!=='disabled',baseUrl:'http://ezer:8791',secret:mode==='missing-config'?'':secret,fetchImpl:async()=>{calls++;return new Response('{}',{status:403});}}),/OWNER_RELAY_/);
 assert.equal(calls,mode==='refused'?1:0);
});
test('ordinary events and unapproved control kinds are never sent to owner relay',async()=>{
 const payload=fixture();let replies=0;
 const options={enabled:true,baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;},fetchImpl:async()=>{throw new Error('must not forward');}};
 // Addressed to Ezer but not a command: answered, never admitted.
 for(const body of ['/ezer StopUnit','/ezer ApproveManifest']){payload.comment.body=body;assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);}
 assert.equal(replies,2);
 // Not addressed to Ezer: ordinary handling, no reply.
 payload.comment.body='ordinary comment';
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),false);
 assert.equal(replies,2);
});
test('an owner comment addressed to Ezer that is not a command is answered instead of dropped',async()=>{
 const payload={...fixture(),repository:{full_name:'GospeLib/main'},issue:{number:2387,pull_request:{url:'pr'}}};
 payload.comment.body='/ezer S02 is not wired up. Finish the transport: mount the projector on ProPR\'s authenticated Socket.IO channel.';
 let replies=0;
 const options={enabled:true,stopEnabled:true,planControlEnabled:true,pauseEnabled:true,routeEnabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,
  replyMalformed:async(event:Record<string,unknown>)=>{assert.deepEqual(event,payload);replies++;},
  fetchImpl:async()=>{throw new Error('free text must never reach the owner relay');}};
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);
 assert.equal(replies,1);
});
for(const mode of ['relay-disabled','wrong-installation','wrong-repository','edited'] as const)test(`an unrecognized /ezer comment on a ${mode} delivery is ACKed terminally without reply, throw, or ordinary dispatch`,async()=>{
 const payload=fixture();payload.comment.body='/ezer please finish S02';
 if(mode==='wrong-repository')payload.repository.full_name='someone-else/repo';
 if(mode==='edited')payload.action='edited';
 let replies=0;
 const handled=await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,mode==='wrong-installation'?'999':installationId,
  {enabled:mode!=='relay-disabled',baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;},fetchImpl:async()=>{throw new Error('must not forward');}});
 // Truthy, so RoutingWebSocketIntakeService ACKs it and never calls the ordinary comment dispatcher.
 assert.deepEqual(handled,EZER_COMMAND_NOT_ADMITTED_DISPOSITION);assert.equal(replies,0);
});
test('unrecognized-command feedback answers on the comment\'s own surface and is idempotent',async()=>{
 const comment={id:5747057704,body:'/ezer S02 is not wired up.',created_at:'2026-09-20T02:30:50Z',updated_at:'2026-09-20T02:30:50Z',issue_url:'https://api.github.com/repos/GospeLib/main/issues/2387',user:{id:7,type:'User',login:'ezer-owner'}};
 const event={comment,issue:{number:2387,pull_request:{url:'pr'}},repository:{full_name:'GospeLib/main'}};
 const comments:Array<{body:string;user:{type:string}}>=[];let posts=0;
 const api={request:async(route:string,input:Record<string,unknown>)=>{assert.equal(input.repo,'main');if(route.startsWith('GET'))return{data:comment};posts++;comments.push({body:String(input.body),user:{type:'Bot'}});return{data:{id:99}};},paginate:async()=>comments} as unknown as Pick<PaginatedOctokitInstance,'request'|'paginate'>;
 await replyMalformedOwnerCommand(event,deliveryId,api);await replyMalformedOwnerCommand(event,deliveryId,api);
 assert.equal(posts,1);
 assert.match(comments[0].body,/EZER_COMMAND_NOT_RECOGNIZED/);
 assert.match(comments[0].body,/\/ezer help/);
 assert.match(comments[0].body,/no work was started or changed/);
 assert.match(comments[0].body,/ezer-invalid-unknown-command-5747057704/);
});
test('unrecognized-command feedback refuses a surface that is not an owner command surface',async()=>{
 const comment={id:1,body:'/ezer do the thing',created_at:'t',updated_at:'t',issue_url:'https://api.github.com/repos/someone-else/repo/issues/1',user:{id:7,type:'User',login:'ezer-owner'}};
 const event={comment,issue:{number:1},repository:{full_name:'someone-else/repo'}};
 let posts=0;
 const api={request:async()=>{posts++;return{data:comment};},paginate:async()=>[]} as unknown as Pick<PaginatedOctokitInstance,'request'|'paginate'>;
 await assert.rejects(()=>replyMalformedOwnerCommand(event,deliveryId,api),/OWNER_COMMAND_REPLY_UNBOUND/);
 assert.equal(posts,0);
});
test('malformed checkpoint command receives an ordinary rejection, never owner admission',async()=>{
 const payload=fixture();payload.comment.body=`/ezer accept-review-stop stop:abcd ${'a'.repeat(40)} sha256:${'b'.repeat(63)}\r\n  55`;
 let replies=0;
 const handled=await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{enabled:true,baseUrl:'http://ezer:8791',secret,
  replyMalformed:async(event)=>{assert.deepEqual(event,payload);replies++;},fetchImpl:async()=>{throw new Error('malformed command must never reach owner relay');}});
 assert.equal(handled,true);assert.equal(replies,1);
});
function malformedReplyFixture(){
 const comment={id:42,body:'/ezer accept-review-stop truncated',created_at:'2026-09-13T18:00:00Z',updated_at:'2026-09-13T18:00:00Z',issue_url:'https://api.github.com/repos/GospeLib/product-hub/issues/90',user:{id:7,type:'User',login:'ezer-owner'}};
 const event={comment,issue:{number:90}};const comments:Array<{body:string;user:{type:string}}>=[];let posts=0,unreadable=false,changed=false,ambiguous=false;
 const api={request:async(route:string,input?:Record<string,unknown>)=>{if(route.startsWith('GET'))return{data:{...comment,...(changed?{body:'changed'}:{})}};posts++;comments.push({body:String(input?.body),user:{type:'Bot'}});if(ambiguous)throw new Error('lost response');return{data:{id:99}};},paginate:async()=>{if(unreadable)throw new Error('read unavailable');return comments;}} as unknown as Pick<PaginatedOctokitInstance,'request'|'paginate'>;
 return{event,api,comments,get posts(){return posts;},setUnreadable(){unreadable=true;},setChanged(){changed=true;},setAmbiguous(){ambiguous=true;}};
}
test('ordinary malformed feedback is idempotent on actual comment marker and tells owner the next action',async()=>{
 const f=malformedReplyFixture();await replyMalformedOwnerCommand(f.event,deliveryId,f.api);await replyMalformedOwnerCommand(f.event,deliveryId,f.api);
 assert.equal(f.posts,1);assert.match(f.comments[0].body,/INVALID_REVIEW_STOP_COMMAND/);assert.match(f.comments[0].body,/64 hexadecimal/);assert.match(f.comments[0].body,/No review stop was accepted/);
});
for(const mode of ['unreadable','changed'] as const)test(`malformed feedback refuses ${mode} state before posting`,async()=>{
 const f=malformedReplyFixture();if(mode==='unreadable')f.setUnreadable();else f.setChanged();await assert.rejects(()=>replyMalformedOwnerCommand(f.event,deliveryId,f.api));assert.equal(f.posts,0);
});
test('ambiguous reply failure is not blindly retried; redelivery reads the existing marker',async()=>{
 const f=malformedReplyFixture();f.setAmbiguous();await assert.rejects(()=>replyMalformedOwnerCommand(f.event,deliveryId,f.api),/lost response/);assert.equal(f.posts,1);
 await replyMalformedOwnerCommand(f.event,deliveryId,f.api);assert.equal(f.posts,1);
});

test('approved StopUnit carriage is exact main created-comment only and disabled independently',async()=>{
 const payload=fixture();payload.repository.full_name='GospeLib/main';payload.comment.body='/ezer stop typed-work:actual-item';let sent=0;
 const options={enabled:true,stopEnabled:true,baseUrl:'http://ezer:8791',secret,fetchImpl:async()=>{sent++;return new Response(JSON.stringify({accepted:true}));}};
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);assert.equal(sent,1);
 await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,stopEnabled:false}),/OWNER_STOP_RELAY_NOT_ENABLED/);
 payload.repository.full_name='GospeLib/product-hub';await assert.rejects(()=>forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),/DELIVERY_NOT_BOUND/);assert.equal(sent,1);
});

test('a valid stop command on a result PR receives ordinary refusal and never reaches execution admission',async()=>{
 const payload={...fixture(),repository:{full_name:'GospeLib/main'},issue:{number:2338,pull_request:{url:'https://api.github.com/repos/GospeLib/main/pulls/2338'}}};payload.comment.body='/ezer stop typed-work:actual-item';let replies=0;
 const handled=await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{enabled:true,stopEnabled:true,baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;},fetchImpl:async()=>{throw Error('must not admit');}});assert.equal(handled,true);assert.equal(replies,1);
});
test('wrong-surface stop feedback verifies the actual PR and is idempotent',async()=>{
 const comment={id:42,body:'/ezer stop typed-work:item',created_at:'2026-09-13T18:00:00Z',updated_at:'2026-09-13T18:00:00Z',issue_url:'https://api.github.com/repos/GospeLib/main/issues/2338',user:{id:7,type:'User',login:'ezer-owner'}};
 const event={comment,issue:{number:2338,pull_request:{url:'pr'}}};const comments:any[]=[];let posts=0;
 const api={request:async(route:string,input:any)=>{assert.equal(input.repo,'main');if(route.startsWith('GET'))return{data:route.includes('comments/')?comment:{pull_request:{url:'pr'}}};posts++;comments.push({body:input.body,user:{type:'Bot'}});return{data:{id:99}};},paginate:async()=>comments} as any;
 await replyMalformedOwnerCommand(event,deliveryId,api);await replyMalformedOwnerCommand(event,deliveryId,api);assert.equal(posts,1);assert.match(comments[0].body,/STOP_COMMAND_REQUIRES_EXECUTION_ISSUE/);assert.match(comments[0].body,/Completed work cannot be cancelled/);
});

test('the separately approved manifest/retry extension forwards exact created controls and preserves scope',async()=>{
 let sends=0;const options={enabled:true,planControlEnabled:true,baseUrl:'http://ezer:8791',secret,fetchImpl:async()=>{sends++;return new Response(JSON.stringify({accepted:true}));}};
 const manifest=fixture();manifest.comment.body='/ezer approve sha256:'+'b'.repeat(64)+' '+'a'.repeat(40);manifest.issue={...manifest.issue,pull_request:{url:'pr'}} as any;
 assert.equal(await forwardRoutingOwnerEvent(manifest,'issue_comment',deliveryId,installationId,options),true);
 await assert.rejects(()=>forwardRoutingOwnerEvent(manifest,'issue_comment',deliveryId,installationId,{...options,planControlEnabled:false}),/OWNER_PLAN_CONTROL_RELAY_NOT_ENABLED/);
 const retry=fixture();retry.repository.full_name='GospeLib/main';retry.comment.body='/ezer retry EP-real-S01 2';
 assert.equal(await forwardRoutingOwnerEvent(retry,'issue_comment',deliveryId,installationId,options),true);
 const lane=fixture();lane.repository.full_name='GospeLib/main';lane.comment.body='/ezer retry EP-real-S02-T02 2';
 assert.equal(await forwardRoutingOwnerEvent(lane,'issue_comment',deliveryId,installationId,options),true);assert.equal(sends,3);
 (retry as any).issue={number:90,pull_request:{url:'pr'}};await assert.rejects(()=>forwardRoutingOwnerEvent(retry,'issue_comment',deliveryId,installationId,options),/OWNER_RETRY_ISSUE_REQUIRED/);assert.equal(sends,3);
});

test('pause/resume require their disabled-by-default flag and never fall through on malformed or PR commands',async()=>{
 const pauseId='11111111-1111-4111-8111-111111111111';let sends=0,replies=0;
 const options={enabled:true,pauseEnabled:true,baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;},fetchImpl:async()=>{sends++;return new Response(JSON.stringify({accepted:true}));}};
 for(const body of ['/ezer pause typed-work:item',`/ezer resume typed-work:item ${pauseId}`]){
  const payload={...fixture(),repository:{full_name:'GospeLib/main'},issue:{number:90},comment:{body,user:{...ownerAuthor}}};
  assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);
  assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,pauseEnabled:false}),true);
  (payload.issue as any).pull_request={url:'pr'};assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);
 }
 const malformed={...fixture(),repository:{full_name:'GospeLib/main'},comment:{body:'/ezer resume typed-work:item missing-pause',user:{...ownerAuthor}}};
 assert.equal(await forwardRoutingOwnerEvent(malformed,'issue_comment',deliveryId,installationId,options),true);assert.equal(sends,2);assert.equal(replies,5);
});

test('explicit route forwarding is independently disabled and never falls through as PR correction',async()=>{
 const payload=fixture();payload.repository.full_name='GospeLib/main';payload.comment.body='/ezer use local:gpt-5.6-sol EP-test-S01';let sent=0,replies=0;
 const options={enabled:true,baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;},fetchImpl:async()=>{sent++;return new Response(JSON.stringify({accepted:true}));}};
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);assert.equal(replies,1);assert.equal(sent,0);
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,routeEnabled:true}),true);assert.equal(sent,1);
 (payload as any).issue={number:90,pull_request:{url:'pr'}};await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{...options,routeEnabled:true});assert.equal(sent,1);assert.equal(replies,2);
});

test('a non-owner human addressing Ezer gets no reply, costs no GitHub call, and is never dispatched',async()=>{
 const payload=fixture();payload.comment.body='/ezer please ship S02';payload.comment.user={id:8,type:'User',login:'stranger'};
 let replies=0,calls=0;
 const options={enabled:true,stopEnabled:true,planControlEnabled:true,pauseEnabled:true,routeEnabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,
  replyMalformed:async()=>{replies++;},fetchImpl:async()=>{calls++;throw new Error('must not forward');}};
 assert.deepEqual(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),EZER_NOT_OWNER_DISPOSITION);
 assert.equal(replies,0);assert.equal(calls,0);
 // A bot, an app impersonating the owner's id, and an owner-shaped id that is not the owner.
 for(const user of [{id:7,type:'Bot',login:'ezer-owner[bot]'},{id:'7',type:'User',login:'ezer-owner'},{id:70,type:'User',login:'ezer-owner'}]){
  payload.comment.user=user as unknown as typeof payload.comment.user;
  assert.deepEqual(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),EZER_NOT_OWNER_DISPOSITION);
 }
 assert.equal(replies,0);assert.equal(calls,0);
});
test('the owner id alone is not enough: normal intake author policy still filters the reply',async()=>{
 const payload=fixture();payload.comment.body='/ezer please ship S02';
 let replies=0;
 const options={enabled:true,baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;},fetchImpl:async()=>{throw new Error('must not forward');}};
 process.env.GITHUB_USER_WHITELIST='someone-else';
 try{assert.deepEqual(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),EZER_NOT_OWNER_DISPOSITION);}
 finally{delete process.env.GITHUB_USER_WHITELIST;}
 assert.equal(replies,0);
 process.env.GITHUB_USER_BLACKLIST='ezer-owner';
 try{assert.deepEqual(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),EZER_NOT_OWNER_DISPOSITION);}
 finally{delete process.env.GITHUB_USER_BLACKLIST;}
 assert.equal(replies,0);
 // Same delivery, unfiltered author: answered.
 assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);
 assert.equal(replies,1);
});
test('no configured owner id means no reply at all, never a reply to anyone',async()=>{
 const payload=fixture();payload.comment.body='/ezer please ship S02';let replies=0;
 const options={enabled:true,ownerUserId:'',baseUrl:'http://ezer:8791',secret,replyMalformed:async()=>{replies++;},fetchImpl:async()=>{throw new Error('must not forward');}};
 assert.deepEqual(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),EZER_NOT_OWNER_DISPOSITION);
 assert.equal(replies,0);
});
for(const body of ['/ezer help please','/ezer status now','/ezer approve please','/ezer approve sha256:bad abc','/ezer retry EP-real-S01','/ezer retry EP-real-S01 zero','/ezer stop','/ezer stop one two','/ezer pause','/ezer resume typed-work:item bad-uuid','/ezer use local:model','/ezer accept-review-stop stop:abcd'])
 test(`an addressed-but-invalid command is answered and ACKed, never thrown: ${body}`,async()=>{
  const payload={...fixture(),repository:{full_name:'GospeLib/main'},issue:{number:90}};payload.comment.body=body;
  let replies=0;
  const options={enabled:true,stopEnabled:true,planControlEnabled:true,pauseEnabled:true,routeEnabled:true,readEnabled:true,baseUrl:'http://ezer:8791',secret,
   replyMalformed:async(event:Record<string,unknown>)=>{assert.deepEqual(event,payload);replies++;},
   fetchImpl:async()=>{throw new Error('an invalid command must never reach the owner relay');}};
  assert.equal(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,options),true);
  assert.equal(replies,1);
 });
test('an invalid plan-control comment is answered on its own surface, not on the manifest repository',async()=>{
 const comment={id:77,body:'/ezer approve please',created_at:'2026-09-20T02:30:50Z',updated_at:'2026-09-20T02:30:50Z',issue_url:'https://api.github.com/repos/GospeLib/main/issues/2387',user:{...ownerAuthor}};
 const event={comment,issue:{number:2387},repository:{full_name:'GospeLib/main'}};
 const comments:Array<{body:string;user:{type:string}}>=[];let posts=0;
 const api={request:async(route:string,input:Record<string,unknown>)=>{assert.equal(input.repo,'main');if(route.startsWith('GET'))return{data:comment};posts++;comments.push({body:String(input.body),user:{type:'Bot'}});return{data:{id:99}};},paginate:async()=>comments} as unknown as Pick<PaginatedOctokitInstance,'request'|'paginate'>;
 await replyMalformedOwnerCommand(event,deliveryId,api);
 assert.equal(posts,1);
 assert.match(comments[0].body,/EZER_COMMAND_NOT_RECOGNIZED/);
 assert.match(comments[0].body,/ezer-invalid-unknown-command-77/);
});
test('the reply helper refuses an unauthorised author before any GitHub call',async()=>{
 const comment={id:78,body:'/ezer do the thing',created_at:'t',updated_at:'t',issue_url:'https://api.github.com/repos/GospeLib/main/issues/1',user:{id:8,type:'User',login:'stranger'}};
 const event={comment,issue:{number:1},repository:{full_name:'GospeLib/main'}};
 let calls=0;
 const api={request:async()=>{calls++;return{data:comment};},paginate:async()=>{calls++;return[];}} as unknown as Pick<PaginatedOctokitInstance,'request'|'paginate'>;
 await assert.rejects(()=>replyMalformedOwnerCommand(event,deliveryId,api),/OWNER_COMMAND_REPLY_NOT_AUTHORIZED/);
 assert.equal(calls,0);
});

// Hostile intake: `/ezer` is publicly reachable, so EVERY exact command is exercised with an
// author who is not the owner. Authorization must fail closed before any capability check and
// before any relay call — and must neither reply, nor relay, nor throw (a throw withholds the
// ACK and lets an outsider force indefinite redelivery), nor return unhandled (which hands the
// comment to the ordinary comment dispatcher, which accepts ordinary human authors).
const EXACT_COMMANDS=[
 ['read help','/ezer help','GospeLib/main',{number:90}],
 ['read status','/ezer status','GospeLib/main',{number:90}],
 ['stop','/ezer stop typed-work:actual-item','GospeLib/main',{number:90}],
 ['approve','/ezer approve sha256:'+'b'.repeat(64)+' '+'a'.repeat(40),'GospeLib/product-hub',{number:90,pull_request:{url:'pr'}}],
 ['retry','/ezer retry EP-real-S01 2','GospeLib/main',{number:90}],
 ['retry lane','/ezer retry EP-real-S02-T02 2','GospeLib/main',{number:90}],
 ['pause','/ezer pause typed-work:item','GospeLib/main',{number:90}],
 ['resume','/ezer resume typed-work:item 11111111-1111-4111-8111-111111111111','GospeLib/main',{number:90}],
 ['route','/ezer use local:gpt-5.6-sol EP-test-S01','GospeLib/main',{number:90}],
 ['checkpoint',`/ezer accept-review-stop stop:abcd ${'a'.repeat(40)} sha256:${'b'.repeat(64)} 55`,'GospeLib/product-hub',{number:90,pull_request:{url:'pr'}}],
] as const;
const NON_OWNER_AUTHORS=[
 ['a stranger',{id:8,type:'User',login:'stranger'}],
 ['a bot wearing the owner login',{id:7,type:'Bot',login:'ezer-owner[bot]'}],
 ['a string-typed owner id',{id:'7',type:'User',login:'ezer-owner'}],
 ['an owner-shaped id that is not the owner',{id:70,type:'User',login:'ezer-owner'}],
] as const;
for(const [name,body,repo,issue] of EXACT_COMMANDS)for(const [who,user] of NON_OWNER_AUTHORS)
 for(const capabilities of ['enabled','disabled'] as const)
  test(`an exact ${name} command from ${who} is refused before any capability check or relay (capabilities ${capabilities})`,async()=>{
   const payload={...fixture(),repository:{id:10,full_name:repo},issue:{id:20,...issue},comment:{id:66,body,user:{...user}}};
   let replies=0,calls=0,readbacks=0;
   const on=capabilities==='enabled';
   const outcome=await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{
    enabled:on,stopEnabled:on,planControlEnabled:on,pauseEnabled:on,routeEnabled:on,readEnabled:on,
    baseUrl:'http://ezer:8791',secret,
    replyMalformed:async()=>{replies++;},onReadback:async()=>{readbacks++;},
    fetchImpl:async()=>{calls++;throw new Error('a non-owner command must never reach the owner relay');}});
   assert.deepEqual(outcome,EZER_NOT_OWNER_DISPOSITION);
   assert.equal(replies,0);assert.equal(calls,0);assert.equal(readbacks,0);
  });
test('a non-owner exact command is refused even with no configured owner id at all',async()=>{
 for(const [,body,repo,issue] of EXACT_COMMANDS){
  const payload={...fixture(),repository:{id:10,full_name:repo},issue:{id:20,...issue},comment:{id:66,body,user:{id:8,type:'User',login:'stranger'}}};
  assert.deepEqual(await forwardRoutingOwnerEvent(payload,'issue_comment',deliveryId,installationId,{enabled:true,stopEnabled:true,planControlEnabled:true,pauseEnabled:true,routeEnabled:true,readEnabled:true,ownerUserId:'',baseUrl:'http://ezer:8791',secret,
   fetchImpl:async()=>{throw new Error('must not forward');}}),EZER_NOT_OWNER_DISPOSITION);
 }
});

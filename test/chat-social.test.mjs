import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication } from '../server/app.mjs';
import { openDatabase,readConfig } from '../server/core.mjs';
import { setAdmin } from '../server/auth.mjs';

test('social, invitations, AstrBot personas and scoped persistent memories',{timeout:90000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'hoshifuru-social-')),dbPath=join(dir,'chat.sqlite'),password=randomBytes(18).toString('hex'),packets=[];
 const personas=new Map([['fish',{id:'fish',name:'大肥鱼',description:'服务器人格',systemPrompt:'权威设定',beginDialogs:[],firstMessage:'你好',exampleDialogue:'',extensions:{},enabled:true,version:'v1',avatar:false}]]);
 let serial=1,available=true,agentListingAvailable=true;const revocations=[];const mock=createServer(async(req,res)=>{
  const admin=req.headers.authorization==='Bearer admin-connector-token';const parts=[];for await(const c of req)parts.push(c);const body=parts.length?JSON.parse(Buffer.concat(parts)):{};
  const send=(v,s=200)=>{res.writeHead(s,{'Content-Type':'application/json'}).end(JSON.stringify(v));};
  if(!available)return send({error:{message:'unavailable'}},503);
  if(req.url.startsWith('/v2/personas')&&!admin)return send({error:{message:'forbidden'}},403);
  if(req.url==='/v2/agents')return agentListingAvailable ? send({items:[...personas.values()],defaultId:'fish'}) : send({error:{message:'列表暂不可用'}},503);
  if(req.url==='/v2/personas'&&req.method==='GET')return send({items:[...personas.values()]});
  if(req.url==='/v2/personas'&&req.method==='POST'){const p={...body,version:'v'+(++serial)};personas.set(p.id,p);return send({item:p});}
  if(req.url.startsWith('/v2/personas/')){const id=decodeURIComponent(req.url.slice(13)),p=personas.get(id);if(req.method==='GET')return send({item:p});if(req.headers['if-match']!==p?.version)return send({error:{message:'version conflict'}},409);const next={...body,id,version:'v'+(++serial)};personas.set(id,next);return send({item:next});}
  if(req.url==='/v2/scopes/revoke'){revocations.push(body);return send({ok:true});}
  if(req.url==='/v2/chat'){packets.push(body);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({delta:'群内回复 '+body.messages.at(-1).senderId,conversationId:'conv-'+body.scope.threadId,umo:'scope-'+body.scope.threadId})+'\n\n');await new Promise(r=>setTimeout(r,40));res.end('data: [DONE]\n\n');return;}
  send({item:null});
 });mock.listen(0,'127.0.0.1');await once(mock,'listening');
 let db=openDatabase(dbPath);await setAdmin(db,'owner',password);db.close();
 const config={...readConfig({envFile:false}),dbPath,host:'127.0.0.1',baseUrl:'',secureCookie:false,seedDemo:false,ipGeoEnabled:false,astrbot:{baseUrl:'http://127.0.0.1:'+mock.address().port,chatToken:'chat-connector-token',adminToken:'admin-connector-token'}};
 let server,base;async function start(){server=await createApplication(config);server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;}async function stop(){server.closeAllConnections();await new Promise(done=>server.close(done));}
 t.after(async()=>{if(server.listening)await stop();mock.closeAllConnections();await new Promise(done=>mock.close(done));await rm(dir,{recursive:true,force:true});});await start();
 async function req(path,{as,method='GET',json,key=randomUUID()}={}){const r=await fetch(base+path,{method,headers:{...(as?{Cookie:as.cookie,'X-CSRF-Token':as.csrf}:{}),'Idempotency-Key':key,...(json===undefined?{}:{'Content-Type':'application/json'})},body:json===undefined?undefined:JSON.stringify(json)});return{status:r.status,value:await r.json()};}
 async function login(username){const r=await req('/api/chat/login',{method:'POST',json:{username,password}});assert.equal(r.status,200);const a={cookie:r.value? r.value.cookie:undefined,csrf:r.value.csrf};const response=await fetch(base+'/api/chat/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});const data=await response.json();a.cookie=response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');a.csrf=data.csrf;a.session=(await req('/api/chat/session',{as:a})).value;return a;}
 const owner=await login('owner');for(const username of['alice','bob'])assert.equal((await req('/api/admin/accounts',{as:owner,method:'POST',json:{username,password}})).status,201);const alice=await login('alice'),bob=await login('bob');
 async function thread(as,kind='group',members=[]){const r=await req('/api/chat/threads',{as,method:'POST',json:{kind,members,title:'群-'+randomUUID()}});assert.equal(r.status,201,JSON.stringify(r.value));return r.value.item;}
 async function invite(as,g,target){const r=await req('/api/chat/threads/'+g.id+'/invitations',{as,method:'POST',json:{target:target.session.key}});assert.equal(r.status,201,JSON.stringify(r.value));return r.value.item;}
 async function accept(as,i){const r=await req('/api/chat/invitations/'+i.id+'/accept',{as,method:'POST'});assert.equal(r.status,200,JSON.stringify(r.value));}
 async function send(as,g,text,key=randomUUID()){const r=await req('/api/chat/threads/'+g.id+'/messages',{as,method:'POST',json:{text},key});assert.ok([200,201].includes(r.status),JSON.stringify(r.value));return r;}
 async function waitReplies(g,count){for(let i=0;i<80;i++){const value=(await req('/api/chat/threads/'+g.id,{as:owner})).value;if(value.messages.filter(m=>m.role==='assistant'&&m.status==='complete').length>=count)return value;await new Promise(r=>setTimeout(r,50));}throw Error('AI reply timeout');}
 await t.test('stable ID search, duplicate/crossed friend requests and profile conflict',async()=>{
  const id=alice.session.profile.id;assert.equal((await req('/api/chat/users?q='+encodeURIComponent(id),{as:bob})).value.items[0].key,alice.session.key);
  assert.equal((await req('/api/chat/threads',{as:alice,method:'POST',json:{kind:'direct',members:[bob.session.key]}})).status,403);
  const first=await req('/api/chat/friend-requests',{as:alice,method:'POST',json:{target:bob.session.key}});assert.equal(first.value.item.state,'pending');
  assert.deepEqual((await req('/api/chat/friend-requests',{as:alice,method:'POST',json:{target:bob.session.key}})).value,first.value);
  assert.equal((await req('/api/chat/friend-requests',{as:bob,method:'POST',json:{target:alice.session.key}})).value.item.state,'accepted');
  assert.equal((await req('/api/chat/friends',{as:alice})).value.items[0].key,bob.session.key);await thread(alice,'direct',[bob.session.key]);
  const p=alice.session.profile;assert.equal((await req('/api/chat/profile',{as:alice,method:'PATCH',json:{version:p.version,displayName:'同名旅人',status:'invisible'}})).status,200);
  assert.equal((await req('/api/chat/profile',{as:alice,method:'PATCH',json:{version:p.version,displayName:'错误覆盖'}})).status,409);
  const found=(await req('/api/chat/users?q='+encodeURIComponent('同名旅人'),{as:bob})).value.items[0];assert.equal(found.id,id);assert.equal(found.status,'offline');
 });
 const g1=await thread(owner,'group',[alice.session.key]);
 await t.test('initial selection only invites; valid membership, expiry/revocation and leave/rejoin',async()=>{
  assert.equal((await req('/api/chat/threads/'+g1.id,{as:alice})).status,404);
  const initial=(await req('/api/chat/invitations',{as:alice})).value.items.find(i=>i.threadId===g1.id);await accept(alice,initial);await accept(alice,initial);
  assert.equal((await req('/api/chat/threads/'+g1.id,{as:alice})).status,200);
  const pending=await invite(alice,g1,bob);assert.equal((await invite(alice,g1,bob)).id,pending.id);
  assert.equal((await req('/api/chat/threads/'+g1.id,{as:alice,method:'DELETE'})).status,200);
  assert.equal((await req('/api/chat/invitations/'+pending.id+'/accept',{as:bob,method:'POST'})).status,410);
  assert.equal((await req('/api/chat/invitations/'+initial.id+'/accept',{as:alice,method:'POST'})).status,410);
  const fresh=await invite(owner,g1,alice);assert.notEqual(fresh.id,initial.id);await accept(alice,fresh);
 });
 const g2=await thread(owner);await accept(alice,await invite(owner,g2,alice));
 await t.test('AI is a real invited member; separate group scopes, identity and filtered memory recall',async()=>{
  const list=(await req('/api/chat/ai',{as:owner})).value;assert.equal(list.connected,true);const ai=list.items[0];
  for(const g of[g1,g2]){const one=await req('/api/chat/threads/'+g.id+'/ai',{as:alice,method:'POST',json:{aiId:ai.id}});assert.equal(one.status,200);assert.deepEqual((await req('/api/chat/threads/'+g.id+'/ai',{as:alice,method:'POST',json:{aiId:ai.id}})).value,one.value);}
  assert.equal((await req('/api/chat/threads/'+g1.id,{as:owner})).value.item.members.filter(m=>m.kind==='ai').length,1);
  const shared=await req('/api/chat/memories',{as:alice,method:'POST',json:{body:'我允许跨群共享：喜欢月亮',scope:'shared'}});assert.equal(shared.status,200);
  await req('/api/chat/memories',{as:alice,method:'POST',json:{body:'我的私人秘密',scope:'private'}});
  await send(alice,g1,'记住：我喜欢猫');await waitReplies(g1,1);await send(owner,g2,'请问我们喜欢什么');await waitReplies(g2,1);
  const p1=packets.find(p=>p.scope.threadId===g1.id),p2=packets.find(p=>p.scope.threadId===g2.id);assert.notEqual(p1.scope.threadId,p2.scope.threadId);
  assert.equal(p1.messages.at(-1).senderId,alice.session.profile.id);assert.ok(p1.memories.some(m=>m.body==='我喜欢猫'));assert.ok(!p2.memories.some(m=>m.body==='我喜欢猫'));
  assert.ok(p2.memories.some(m=>m.body.includes('允许跨群')));assert.ok(!p1.memories.some(m=>m.body==='我的私人秘密'));
  const key=randomUUID();await send(owner,g2,'去重验证',key);await send(owner,g2,'去重验证',key);await waitReplies(g2,2);assert.equal(packets.filter(p=>p.messages.at(-1).body==='去重验证').length,1);
 });
 await t.test('persona edits use privileged connector, round-trip version, conflict and offline drafts',async()=>{
  assert.equal((await req('/api/chat/admin/personas',{as:alice})).status,403);
  const p=(await req('/api/chat/admin/personas',{as:owner})).value.items[0];
  const saved=await req('/api/chat/admin/personas/'+p.id,{as:owner,method:'PUT',json:{...p,name:'鱼的新名字',systemPrompt:'服务器的新设定'}});assert.equal(saved.status,200,JSON.stringify(saved.value));assert.equal(saved.value.synced,true);
  const conflict=await req('/api/chat/admin/personas/'+p.id,{as:owner,method:'PUT',json:{...p,systemPrompt:'过期覆盖'}});assert.equal(conflict.status,409);
  assert.equal((await req('/api/chat/admin/personas/drafts',{as:owner})).value.items.length,1);
  available=false;assert.equal((await req('/api/chat/admin/personas/'+p.id,{as:owner,method:'PUT',json:{...saved.value.item,systemPrompt:'离线编辑'}})).status,503);available=true;
 });
 await t.test('a verified persona write remains successful if the agent list subsequently fails', async () => {
  const current = personas.get('fish');
  agentListingAvailable = false;
  try {
   const updated = await req('/api/chat/admin/personas/fish', {
    as: owner, method: 'PUT', json: { ...current, description: '已回读的人格' },
   });
   assert.equal(updated.status, 200);
   assert.equal(updated.value.synced, true);
   assert.equal(updated.value.agentsRefreshed, false);
   assert.equal(updated.value.item.version, personas.get('fish').version);
   assert.equal((await req('/api/chat/admin/personas/drafts', { as: owner })).value.items.length, 0);
  } finally { agentListingAvailable = true; }
 });
 await t.test('two concurrent attempts for a first AI message create one row and one reply', async () => {
  const dialogue = await thread(owner, 'ai');
  const key = randomUUID(), text = '只需要一条用于重试验收的回复。';
  const [one, two] = await Promise.all([send(owner, dialogue, text, key), send(owner, dialogue, text, key)]);
  assert.deepEqual([one.status, two.status].sort(), [200, 201]);
  assert.equal(one.value.items.length, 2);
  assert.deepEqual(one.value.items.map(m => m.id), two.value.items.map(m => m.id));
  await waitReplies(dialogue, 1);
  assert.equal(packets.filter(p => p.scope.threadId === dialogue.id).length, 1);
 });
 await t.test('memory revocation is checked again; AI removal/reinvite increments the scope version',async()=>{
  const ai=(await req('/api/chat/ai',{as:owner})).value.items[0];
  const memory=(await req('/api/chat/memories',{as:alice})).value.items.find(m=>m.scope==='shared');assert.ok(memory);
  assert.equal((await req('/api/chat/memories/'+memory.id,{as:bob,method:'PATCH',json:{version:memory.version,revoked:true}})).status,403);
  assert.equal((await req('/api/chat/memories/'+memory.id,{as:alice,method:'PATCH',json:{version:memory.version,revoked:true}})).status,200);
  await send(owner,g2,'授权撤销后召回');await waitReplies(g2,3);assert.ok(!packets.at(-1).memories.some(m=>m.id===memory.id));
  const before=packets.at(-1).scope.epoch;
  assert.equal((await req('/api/chat/threads/'+g2.id+'/ai/'+ai.id,{as:owner,method:'DELETE'})).status,200);
  const count=packets.length;await send(owner,g2,'AI离群后不得回复');await new Promise(r=>setTimeout(r,100));assert.equal(packets.length,count);
  assert.equal((await req('/api/chat/threads/'+g2.id+'/ai',{as:owner,method:'POST',json:{aiId:ai.id}})).status,200);
  await send(owner,g2,'重邀后的新会话版本');await waitReplies(g2,4);assert.ok(packets.at(-1).scope.epoch>before);assert.ok(revocations.every(r=>Number.isInteger(r.epoch)));
 });
 await t.test('invitations reject expiry/revocation; friend rejections do not create an edge',async()=>{
  const expired=await invite(owner,g2,bob);let d=openDatabase(dbPath);d.prepare('UPDATE chat_group_invitations SET expires_at=0 WHERE id=?').run(expired.id);d.close();
  assert.equal((await req('/api/chat/invitations/'+expired.id+'/accept',{as:bob,method:'POST'})).status,410);
  const revoked=await invite(owner,g2,bob);assert.equal((await req('/api/chat/invitations/'+revoked.id+'/revoke',{as:owner,method:'POST'})).status,200);assert.equal((await req('/api/chat/invitations/'+revoked.id+'/accept',{as:bob,method:'POST'})).status,410);
  const f=(await req('/api/chat/friend-requests',{as:owner,method:'POST',json:{target:bob.session.key}})).value.item;assert.equal((await req('/api/chat/friend-requests/'+f.id+'/reject',{as:bob,method:'POST'})).status,200);assert.ok(!(await req('/api/chat/friends',{as:owner})).value.items.some(p=>p.key===bob.session.key));
 });
 await t.test('restart retains profiles, friend edges, accepted invitations, memories and history',async()=>{
  await send(owner,g1,`记住：@${alice.session.profile.id} 我喜欢雨夜；@${owner.session.profile.id} 我喜欢星云`);await waitReplies(g1,2);
  const am=(await req('/api/chat/memories',{as:alice})).value.items.find(m=>m.body==='我喜欢雨夜'),om=(await req('/api/chat/memories',{as:owner})).value.items.find(m=>m.body==='我喜欢星云');assert.ok(am&&om);assert.equal(am.sourceMessageId,om.sourceMessageId);assert.equal(am.sourceActor,owner.session.key);assert.equal(am.scope,'group');
  await Promise.all([send(owner,g1,'第一位的并发消息'),send(alice,g1,'第二位的并发消息')]);await waitReplies(g1,4);const rows=packets.filter(p=>p.messages.at(-1).body.includes('并发消息'));assert.equal(rows.length,2);assert.notEqual(rows[0].messages.at(-1).senderId,rows[1].messages.at(-1).senderId);assert.ok(rows[0].messages.at(-1).id<rows[1].messages.at(-1).id);
  await stop();await start();assert.equal((await req('/api/chat/profile',{as:alice})).value.item.displayName,'同名旅人');assert.equal((await req('/api/chat/friends',{as:alice})).value.items[0].key,bob.session.key);
  assert.equal((await req('/api/chat/threads/'+g1.id,{as:alice})).status,200);assert.ok((await req('/api/chat/memories',{as:alice})).value.items.length>=3);
 });
 await t.test('connection and heartbeat determine presence; all five chosen states preserve invisibility',async()=>{
  const control=new AbortController(),response=await fetch(base+'/api/chat/events',{headers:{Cookie:bob.cookie},signal:control.signal});const reader=response.body.getReader();await reader.read();
  for(const state of['online','away','busy','invisible','offline']){const p=(await req('/api/chat/profile',{as:bob})).value.item;assert.equal((await req('/api/chat/profile',{as:bob,method:'PATCH',json:{version:p.version,status:state}})).status,200);const found=(await req('/api/chat/users?q=bob',{as:owner})).value.items[0];assert.equal(found.status,state==='invisible'?'offline':state);}
  const p=(await req('/api/chat/profile',{as:bob})).value.item;await req('/api/chat/profile',{as:bob,method:'PATCH',json:{version:p.version,status:'online'}});let d=openDatabase(dbPath);d.prepare('UPDATE chat_presence_connections SET heartbeat_at=0 WHERE account_key=?').run(bob.session.key);d.close();assert.equal((await req('/api/chat/users?q=bob',{as:owner})).value.items[0].status,'offline');await req('/api/chat/presence/heartbeat',{as:bob,method:'POST'});assert.equal((await req('/api/chat/users?q=bob',{as:owner})).value.items[0].status,'online');await reader.cancel();control.abort();await new Promise(r=>setTimeout(r,40));assert.equal((await req('/api/chat/users?q=bob',{as:owner})).value.items[0].status,'offline');
 });
});

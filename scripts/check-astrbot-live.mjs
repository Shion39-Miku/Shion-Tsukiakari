// Uses the existing private backend configuration; never outputs credentials.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
const settings=JSON.parse(await readFile(process.env.ASTRBOT_CONFIG_FILE||join(homedir(),'.codex/secrets/hoshifuru-astrbot.json'),'utf8'));
const report={at:new Date().toISOString(),checks:[],conversations:[]},created=[];
const output=resolve('artifacts/astrbot-v3');await mkdir(output,{recursive:true});
async function call(path,{method='GET',body,version,admin=false,key=randomUUID()}={}){const r=await fetch(settings.baseUrl+path,{method,signal:AbortSignal.timeout(120000),headers:{Authorization:'Bearer '+(admin?settings.adminToken:settings.chatToken),'Idempotency-Key':key,...(body?{'Content-Type':'application/json'}:{}),...(version?{'If-Match':version}:{})},body:body?JSON.stringify(body):undefined});const v=await r.json();return{status:r.status,value:v};}
const pass=s=>{report.checks.push(s);console.log('通过：'+s);};
function crc(buffer){let c=0xffffffff;for(const b of buffer){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function pngText(png,card){const data=Buffer.from('chara\0'+Buffer.from(JSON.stringify(card)).toString('base64'));const type=Buffer.from('tEXt'),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([png.subarray(0,33),head,type,data,tail,png.subarray(33)]);}
try{
 const health=await call('/v2/health');assert.equal(health.status,200);assert.equal(health.value.providerAvailable,true);report.server=health.value;
 const agents=(await call('/v2/agents')).value;assert.equal(agents.defaultId,'大肥鱼');assert.ok(agents.items.some(p=>p.id==='大肥鱼'));pass('真实 AstrBot 4.29.1 与既有模型可用，默认AI为服务器大肥鱼人格');
 const suffix=randomUUID().slice(0,8),id='星降联调-'+suffix;
 const card={spec:'chara_card_v2',spec_version:'2.0',data:{name:id,description:'隔离验收角色，完成后删除。',personality:'回答简洁，按提供的发送者ID区分不同用户。',system_prompt:'你是接口验收助手。只依据当前请求里的近期消息、摘要和授权记忆回答。',first_mes:'星光你好。',mes_example:'用户：你好\nAI：夜安。',extensions:{hoshifuru_test:suffix}}};
 const imported=await call('/v2/personas/import',{method:'POST',body:{id,card},admin:true});assert.equal(imported.status,200,JSON.stringify(imported.value));created.push(id);assert.equal(imported.value.item.firstMessage,'星光你好。');assert.equal(imported.value.item.extensions.original.extensions.hoshifuru_test,suffix);
 const picId=id+'-PNG',png=pngText(await sharp({create:{width:32,height:32,channels:4,background:'#b79abf'}}).png().toBuffer(),card);const importedPng=await call('/v2/personas/import',{method:'POST',body:{id:picId,png:png.toString('base64')},admin:true});assert.equal(importedPng.status,200,JSON.stringify(importedPng.value));created.push(picId);assert.equal(importedPng.value.item.avatar,true);const picture=await fetch(settings.baseUrl+'/v2/avatars/'+encodeURIComponent(picId),{headers:{Authorization:'Bearer '+settings.chatToken}});assert.equal(picture.status,200);assert.equal((await sharp(Buffer.from(await picture.arrayBuffer())).metadata()).width,32);
 pass('JSON与PNG角色卡均写入真实AstrBot，开场、扩展信息和服务器角色图片回读一致');
 const aiId=randomUUID(),one=randomUUID(),two=randomUUID(),uid1='U-'+randomUUID(),uid2='U-'+randomUUID();
 const members=[{id:uid1,displayName:'同名旅人',kind:'human'},{id:uid2,displayName:'同名旅人',kind:'human'}];
 async function chat(threadId,body,memories=[],epoch=0){const packet={requestId:randomUUID(),personaId:id,title:'星降隔离验收',scope:{threadId,aiId,kind:'group',epoch},members,messages:[{id:1,role:'user',senderId:uid1,displayName:'同名旅人',createdAt:new Date().toISOString(),body}],summary:'',memories};const r=await fetch(settings.baseUrl+'/v2/chat',{method:'POST',signal:AbortSignal.timeout(120000),headers:{Authorization:'Bearer '+settings.chatToken,'Content-Type':'application/json'},body:JSON.stringify(packet)});assert.equal(r.status,200,await(r.ok?Promise.resolve(''):r.text()));let text='',cid,umo,done=false;for(const line of(await r.text()).split('\n'))if(line.startsWith('data: ')){const data=line.slice(6);if(data==='[DONE]'){done=true;continue;}const v=JSON.parse(data);assert.equal(v.error,undefined);text+=v.delta||'';cid=v.conversationId||cid;umo=v.umo||umo;}assert.equal(done,true);assert.ok(text.trim());report.conversations.push({threadId,cid,umo,response:text});const replay=await call('/v2/chat',{method:'POST',body:packet});assert.equal(replay.value.state,'complete');assert.equal(replay.value.reply,text);return{cid,umo,text};}
 const memory={id:randomUUID(),ownerId:uid2,scope:'group',threadId:one,body:'验收口令是月见猫。',version:1,sourceMessageId:88,sourceActor:uid2};
 const first=await chat(one,'请只回答授权记忆中的验收口令，以及它属于哪位用户的稳定ID。不要混淆两位同名用户。',[memory]);assert.ok(first.text.includes('月见猫'));assert.ok(first.text.includes(uid2));
 const second=await chat(two,'本群没有提供验收口令。如果不知道，请只回答“本群没有这条记忆”。');assert.ok(!second.text.includes('月见猫'));assert.notEqual(first.cid,second.cid);assert.notEqual(first.umo,second.umo);
 pass('真实模型按稳定ID识别同名成员；两个群映射不同AstrBot会话，本群记忆不流入另一群；重复消息复用已完成结果');
 const bad=await call('/v2/chat',{method:'POST',body:{requestId:randomUUID(),personaId:id,title:'拒绝越界记忆',scope:{threadId:two,aiId,kind:'group',epoch:0},members,messages:[],memories:[memory]}});assert.equal(bad.status,400);
 assert.equal((await call('/v2/personas')).status,403);pass('连接器再次拒绝跨群记忆和普通聊天令牌的人格管理请求');
 await call('/v2/scopes/revoke',{method:'POST',body:{umo:first.umo,epoch:1}});await call('/v2/scopes/revoke',{method:'POST',body:{umo:first.umo,epoch:1}});
 const stale=await call('/v2/chat',{method:'POST',body:{requestId:randomUUID(),personaId:id,title:'失效上下文',scope:{threadId:one,aiId,kind:'group',epoch:0},members,messages:[],memories:[]}});assert.equal(stale.status,409);
 const resumed=await chat(one,'新授权版本已生效，请只回复“新会话正常”。',[],1);assert.equal(resumed.cid,first.cid);pass('重复撤销授权不会递增版本；旧上下文被拦截，AI重邀后以新版本继续同群会话');
}catch(error){report.failure=error.stack;throw error;}
finally{for(const id of created){const current=await call('/v2/personas/'+encodeURIComponent(id),{admin:true});if(current.status===200){const r=await call('/v2/personas/'+encodeURIComponent(id),{method:'DELETE',admin:true,version:current.value.item.version});assert.equal(r.status,200);}}await writeFile(join(output,'chat-and-cards-live.json'),JSON.stringify(report,null,2));console.log('报告：'+join(output,'chat-and-cards-live.json'));}

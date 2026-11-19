import { check, cleanText, newId, now, Problem, sha256, transaction } from './core.mjs';
import { readJson } from './media.mjs';

const stableId=(text)=>{const h=sha256(text);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export function createChatAI(db,config,{social,own,emit,publish,message}) {
  const settings=config.astrbot || {}, active=new Map();let closed=false,refreshing,pumping=false;
  let configured=!!(settings.baseUrl&&settings.chatToken);
  async function remote(path,{admin=false,method='GET',body,version,key,actor,signal}={}){
    check(configured && (!admin||settings.adminToken),'尚未配置服务器 AstrBot 连接；人格草稿会保留。',503,'astrbot_unconfigured');
    let response;
    try{response=await fetch(settings.baseUrl.replace(/\/$/,'')+path,{method,redirect:'error',signal:signal||AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+(admin?settings.adminToken:settings.chatToken),...(body===undefined?{}:{'Content-Type':'application/json'}),...(version?{'If-Match':version}:{}),...(key?{'Idempotency-Key':key}:{}),...(actor?{'X-Actor-ID':actor}:{})},body:body===undefined?undefined:JSON.stringify(body)});}
    catch(error){if(signal?.aborted)throw error;throw new Problem(503,'astrbot_unavailable','服务器 AstrBot 暂不可达，输入与待提交草稿已保留。');}
    if(!response.ok){const value=await response.json().catch(()=>({}));throw new Problem([401,403,409,410].includes(response.status)?response.status:503,'astrbot_error',value.error?.message||'AstrBot暂未完成请求，原内容已保留。');}
    return response;
  }
  async function jsonRemote(path,options){return(await remote(path,options)).json();}
  async function refreshAgents(){
    if(refreshing)return refreshing;
    refreshing=(async()=>{const value=await jsonRemote('/v2/agents');const at=now();let changed=false;
      transaction(db,()=>{const ids=[];for(const p of value.items){const id=stableId('astrbot:'+p.id);ids.push(id);const old=db.prepare('SELECT version,enabled FROM chat_ai_agents WHERE id=?').get(id);changed ||= !old||old.version!==p.version||!old.enabled;
        db.prepare('INSERT INTO chat_ai_agents VALUES(?,?,?,?,?,?,1,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,avatar_url=excluded.avatar_url,version=excluded.version,enabled=1,document=excluded.document,checked_at=excluded.checked_at').run(id,p.id,p.name,p.description||'',p.avatar?'/v2/avatars/'+encodeURIComponent(p.id):null,p.version,'astrbot',JSON.stringify(p),at);}
        for(const row of db.prepare('SELECT id FROM chat_ai_agents WHERE enabled=1').all())if(!ids.includes(row.id)){changed=true;db.prepare('UPDATE chat_ai_agents SET enabled=0,checked_at=? WHERE id=?').run(at,row.id);for(const a of db.prepare('SELECT thread_id FROM chat_ai_members WHERE ai_id=? AND active=1').all(row.id))invalidate(a.thread_id);}
      });if(changed)for(const u of social.users())emit(u.key,null,'agents',{});
      return {items:agents(),defaultId:value.defaultId?stableId('astrbot:'+value.defaultId):agents()[0]?.id,connected:true};})().finally(()=>refreshing=null);return refreshing;
  }
  const agents=()=>db.prepare('SELECT * FROM chat_ai_agents ORDER BY name,id').all().map(a=>({id:a.id,personaId:a.remote_id,name:a.name,description:a.description,avatar:a.avatar_url?'/api/chat/ai/'+a.id+'/avatar':null,version:a.version,enabled:!!a.enabled,source:a.source,firstMessage:JSON.parse(a.document).firstMessage||''}));
  function agent(id){const value=db.prepare('SELECT * FROM chat_ai_agents WHERE id=?').get(id);check(value&&value.enabled,'此AI已被删除或停用，请重新选择。',410,'ai_unavailable');return value;}
  const memberAIs=(thread)=>db.prepare('SELECT a.* FROM chat_ai_members m JOIN chat_ai_agents a ON a.id=m.ai_id WHERE m.thread_id=? AND m.active=1 AND a.enabled=1 ORDER BY m.joined_at').all(thread);
  function addAI(session,threadId,id){const thread=own(session,threadId);check(['ai','group'].includes(thread.kind),'请在群聊或AI私聊中选择AI。');agent(id);
    if(thread.kind==='ai'){check(thread.owner===session.key,'不能修改别人的AI会话。',403);for(const old of memberAIs(threadId))if(old.id!==id)removeAI(session,threadId,old.id);}
    check(memberAIs(threadId).length<5||memberAIs(threadId).some(a=>a.id===id),'每群最多邀请5位AI。');
    db.prepare('INSERT INTO chat_ai_members(thread_id,ai_id,added_by,joined_at) VALUES(?,?,?,?) ON CONFLICT(thread_id,ai_id) DO UPDATE SET active=1,epoch=CASE WHEN active=0 THEN epoch+1 ELSE epoch END,removed_at=NULL').run(threadId,id,session.key,now());
    const umo='hoshifuru:'+(thread.kind==='group'?'GroupMessage:':'FriendMessage:')+threadId+'_'+id;
    db.prepare('INSERT INTO chat_ai_sessions(thread_id,ai_id,umo,updated_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(threadId,id,umo,now());emit(null,threadId,'threads',{});return agents().find(a=>a.id===id);
  }
  function removeAI(session,threadId,id){const thread=own(session,threadId),m=db.prepare('SELECT * FROM chat_ai_members WHERE thread_id=? AND ai_id=?').get(threadId,id);check(m,'AI成员不存在。',404);check(thread.owner===session.key||m.added_by===session.key,'只有群主或邀请人可以移除此AI。',403);if(!m.active)return;db.prepare('UPDATE chat_ai_members SET active=0,epoch=epoch+1,removed_at=? WHERE thread_id=? AND ai_id=?').run(now(),threadId,id);social.invalidateRoster(threadId);}
  function invalidate(thread){
    for(const r of active.values())if(r.thread===thread)r.controller.abort();
    db.prepare("UPDATE chat_ai_jobs SET state='canceled',updated_at=? WHERE thread_id=? AND state='queued'").run(now(),thread);
    db.prepare("UPDATE chat_messages SET status='stopped',metadata=json_set(metadata,'$.error','群成员或共享授权已变更，已停止旧上下文回复。'),updated_at=? WHERE id IN(SELECT reply_id FROM chat_ai_jobs WHERE thread_id=? AND state='canceled') AND status='generating'").run(now(),thread);
    for(const s of db.prepare('SELECT umo,roster_version FROM chat_ai_sessions WHERE thread_id=?').all(thread))if(configured)void jsonRemote('/v2/scopes/revoke',{method:'POST',body:{umo:s.umo,epoch:s.roster_version}}).catch(()=>{});
  }
  async function prepare(session,thread,selected){
    if(!configured)return [];
    if(selected){await refreshAgents();addAI(session,thread.id,selected);}
    if(thread.kind==='ai'&&!memberAIs(thread.id).length){const list=await refreshAgents();check(list.defaultId,'服务器没有可用AI，请在AI列表中检查。',503);addAI(session,thread.id,list.defaultId);}
    return memberAIs(thread.id);
  }
  function remember(row){
    const scope=db.prepare('SELECT kind FROM chat_threads WHERE id=?').get(row.thread_id)?.kind;
    const roster=social.members(row.thread_id).filter(u=>u.kind!=='ai');
    const explicit=/^记住\s*[:：]/.test(row.body);if(!explicit&&!/^(?:我|我的)(?:喜欢|讨厌|叫|是|生日|偏好|养)/.test(row.body))return;
    const parts=row.body.replace(/^记住\s*[:：]\s*/,'').split(/[；;\n]/).slice(0,6);
    for(let part of parts){part=part.trim();if(!part)continue;let owner=row.sender_key;
      const mention=/^@([^\s，,；;]+)\s+/.exec(part);if(mention){const matches=roster.filter(u=>[u.id,u.username,u.displayName].includes(mention[1]));if(matches.length!==1)continue;owner=matches[0].key;part=part.slice(mention[0].length);}
      const id=newId(),at=now();db.prepare('INSERT INTO chat_memories VALUES(?,?,?,?,?,?,?,1,0,?,?) ON CONFLICT(owner_key,source_message_id,body) DO NOTHING').run(id,owner,scope==='group'?'group':'private',scope==='group'?row.thread_id:null,part.slice(0,600),row.id,row.sender_key,at,at);
    }
  }
  function context(job){
    const thread=db.prepare('SELECT * FROM chat_threads WHERE id=?').get(job.thread_id), a=agent(job.ai_id), session=db.prepare('SELECT * FROM chat_ai_sessions WHERE thread_id=? AND ai_id=?').get(job.thread_id,job.ai_id);
    const humans=social.members(job.thread_id).filter(u=>u.kind!=='ai'&&u.role!=='disabled');const keys=new Set(humans.map(u=>u.key));
    const source=db.prepare('SELECT * FROM chat_messages WHERE id=?').get(job.source_id);check(source&&keys.has(source.sender_key),'消息发送者已退出，停止处理。',410);
    const all=db.prepare("SELECT * FROM chat_messages WHERE thread_id=? AND id<=? AND (status='complete' OR id=?) ORDER BY id DESC LIMIT 150").all(job.thread_id,job.source_id,job.source_id).reverse().filter(r=>r.role==='user'?keys.has(r.sender_key):r.sender_key==='ai:'+job.ai_id);
    const recent=all.slice(-30);let budget=22000;const messages=[];
    for(const row of recent.reverse()){const p=social.profile(row.sender_key);const body=row.body.slice(0,Math.min(2200,budget));if(budget<=0)break;budget-=body.length;messages.unshift({id:row.id,role:row.role,senderId:p?.id||job.ai_id,displayName:p?.displayName||a.name,createdAt:row.created_at,body});}
    const older=all.slice(0,Math.max(0,all.length-30));const summary=older.slice(-25).map(r=>`[消息${r.id};${social.profile(r.sender_key)?.id||job.ai_id}] ${r.body.slice(0,130)}`).join('\n').slice(-4000);
    db.prepare('UPDATE chat_ai_sessions SET summary=?,summary_through=?,updated_at=? WHERE thread_id=? AND ai_id=?').run(summary,older.at(-1)?.id||0,now(),job.thread_id,job.ai_id);
    const terms=source.body.match(/[\u4e00-\u9fff]{2,6}|[a-zA-Z0-9]{2,}/g)||[];
    const memories=db.prepare(`SELECT * FROM chat_memories WHERE revoked=0 AND owner_key IN (${[...keys].map(()=>'?').join(',')}) AND (scope='shared' OR (scope='group' AND thread_id=?) OR (scope='private' AND ?='ai' AND owner_key=?)) ORDER BY updated_at DESC LIMIT 256`).all(...keys,job.thread_id,thread.kind,source.sender_key)
      .map(m=>({...m,score:terms.reduce((n,t)=>n+(m.body.includes(t)?1:0),0)})).sort((a,b)=>b.score-a.score).slice(0,8).map(m=>({id:m.id,ownerId:social.profile(m.owner_key).id,scope:m.scope,threadId:m.thread_id,body:m.body.slice(0,500),version:m.version,sourceMessageId:m.source_message_id,sourceActor:social.profile(m.source_actor)?.id||m.source_actor}));
    return {requestId:job.id+'-'+job.attempt,personaId:a.remote_id,title:thread.title,scope:{threadId:thread.id,aiId:a.id,kind:thread.kind,epoch:session.roster_version},members:humans.map(u=>({id:u.id,displayName:u.displayName,kind:'human'})),messages,summary,memories};
  }
  function queue(session,thread,source,selectedAgents){
    remember(source);const result=[];
    for(const a of selectedAgents){let old=db.prepare('SELECT * FROM chat_ai_jobs WHERE source_id=? AND ai_id=?').get(source.id,a.id);if(old){const m=db.prepare('SELECT * FROM chat_messages WHERE id=?').get(old.reply_id);if(m)result.push(m);continue;}
      const id=newId(),at=now(),meta=JSON.stringify({requestedBy:session.key,aiId:a.id,sourceMessageId:source.id,queued:true});
      const reply=db.prepare("INSERT INTO chat_messages(thread_id,role,sender_key,sender_name,body,status,metadata,request_key,created_at,updated_at) VALUES(?,'assistant',?,?,?,'generating',?,?,?,?)").run(thread.id,'ai:'+a.id,a.name,'',meta,'ai-job:'+id,at,at);
      const epoch=db.prepare('SELECT roster_version FROM chat_ai_sessions WHERE thread_id=? AND ai_id=?').get(thread.id,a.id).roster_version;
      db.prepare("INSERT INTO chat_ai_jobs VALUES(?,?,?,?,?,'queued',0,?,?,?)").run(id,thread.id,a.id,source.id,Number(reply.lastInsertRowid),epoch,at,at);result.push(db.prepare('SELECT * FROM chat_messages WHERE id=?').get(Number(reply.lastInsertRowid)));
    }queueMicrotask(()=>void pump());return result;
  }
  function update(job,text,status,error){
    if(closed)return;const row=db.prepare('SELECT metadata FROM chat_messages WHERE id=?').get(job.reply_id);if(!row)return;
    const permitted=db.prepare('SELECT 1 FROM chat_ai_members WHERE thread_id=? AND ai_id=? AND active=1').get(job.thread_id,job.ai_id);if(!permitted&&status!=='stopped')return;
    const meta=JSON.parse(row.metadata);meta.queued=false;if(error)meta.error=error;else delete meta.error;
    db.prepare('UPDATE chat_messages SET body=?,status=?,metadata=?,updated_at=? WHERE id=?').run(text,status,JSON.stringify(meta),now(),job.reply_id);publish(null,job.thread_id,job.reply_id);
  }
  async function run(job){
    const controller=new AbortController();const state={thread:job.thread_id,controller,text:''};active.set(job.id,state);let completed=false,timer;
    try{
      const packet=context(job);check(db.prepare('SELECT roster_version FROM chat_ai_sessions WHERE thread_id=? AND ai_id=?').get(job.thread_id,job.ai_id).roster_version===job.roster_version,'会话成员已更新。',409);
      const response=await remote('/v2/chat',{method:'POST',body:packet,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(200000)])});
      if(response.headers.get('content-type')?.includes('application/json')){const value=await response.json();check(value.state==='complete','上一条处理未完成，请稍后重试。',409);state.text=value.reply;completed=true;}
      else{const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';try{while(!completed){const part=await reader.read();pending+=decoder.decode(part.value||new Uint8Array(),{stream:!part.done});check(pending.length<1000000,'AI返回异常。');let cut;
        while((cut=pending.indexOf('\n'))>=0){const line=pending.slice(0,cut).trim();pending=pending.slice(cut+1);if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]'){completed=true;break;}const value=JSON.parse(data);check(!value.error,'AstrBot回复中断。',502);if(value.delta){state.text+=value.delta;check(state.text.length<=60000,'AI回复过长。');if(!timer)timer=setTimeout(()=>{timer=null;update(job,state.text,'generating');},100);}if(value.conversationId)db.prepare('UPDATE chat_ai_sessions SET conversation_id=? WHERE thread_id=? AND ai_id=?').run(value.conversationId,job.thread_id,job.ai_id);}
        if(part.done)break;
      }}finally{await reader.cancel().catch(()=>{});}}
      check(completed&&state.text.trim(),'回复未完成，已保留收到的内容。',502);update(job,state.text,'complete');db.prepare("UPDATE chat_ai_jobs SET state='complete',updated_at=? WHERE id=?").run(now(),job.id);db.prepare('UPDATE chat_ai_sessions SET last_message_id=?,updated_at=? WHERE thread_id=? AND ai_id=?').run(job.source_id,now(),job.thread_id,job.ai_id);
    }catch(error){if(!closed){const stop=controller.signal.aborted;update(job,state.text,stop?'stopped':'failed',stop?'成员或授权已更新，已停止旧回复。':error instanceof Problem?error.message:'AstrBot回复暂未完成，可明确重试。');db.prepare('UPDATE chat_ai_jobs SET state=?,updated_at=? WHERE id=?').run(stop?'canceled':'failed',now(),job.id);}}
    finally{clearTimeout(timer);active.delete(job.id);if(!closed)void pump();}
  }
  async function pump(){if(closed||pumping)return;pumping=true;try{while(active.size<4){let job;transaction(db,()=>{job=db.prepare("SELECT j.* FROM chat_ai_jobs j WHERE state='queued' AND NOT EXISTS(SELECT 1 FROM chat_ai_jobs r WHERE r.thread_id=j.thread_id AND r.ai_id=j.ai_id AND r.state='running') ORDER BY source_id,created_at LIMIT 1").get();if(job)db.prepare("UPDATE chat_ai_jobs SET state='running',updated_at=? WHERE id=? AND state='queued'").run(now(),job.id);});if(!job)break;void run(job);}}finally{pumping=false;}}
  const timer=setInterval(()=>void pump(),500);timer.unref();
  const refreshTimer=setInterval(()=>{if(configured&&!closed)void refreshAgents().catch(()=>{});},15000);refreshTimer.unref();
  async function recover(){for(const job of db.prepare("SELECT * FROM chat_ai_jobs WHERE state='running'").all()){try{const r=await jsonRemote('/v2/requests/'+encodeURIComponent(job.id+'-'+job.attempt));if(closed)return;if(r.item?.state==='complete'){update(job,r.item.reply,'complete');db.prepare("UPDATE chat_ai_jobs SET state='complete' WHERE id=?").run(job.id);continue;}}catch{}if(closed)return;update(job,db.prepare('SELECT body FROM chat_messages WHERE id=?').get(job.reply_id)?.body||'','failed','服务重启，已保留内容；未自动重复模型调用。');db.prepare("UPDATE chat_ai_jobs SET state='failed' WHERE id=?").run(job.id);}void pump();}
  void recover();
  function retry(session,replyId){const job=db.prepare('SELECT * FROM chat_ai_jobs WHERE reply_id=?').get(replyId);if(!job)return false;own(session,job.thread_id);check(JSON.parse(db.prepare('SELECT metadata FROM chat_messages WHERE id=?').get(replyId).metadata).requestedBy===session.key,'只能重试自己发起的回复。',403);check(['failed','canceled'].includes(job.state),'当前回复不能重试。',409);agent(job.ai_id);check(memberAIs(job.thread_id).some(a=>a.id===job.ai_id),'AI已退出本群。',410);db.prepare("UPDATE chat_ai_jobs SET state='queued',attempt=attempt+1,roster_version=(SELECT roster_version FROM chat_ai_sessions WHERE thread_id=? AND ai_id=?),updated_at=? WHERE id=?").run(job.thread_id,job.ai_id,now(),job.id);update(job,'','generating');void pump();return true;}
  async function handle(session,req,res,url,json){
    const path=url.pathname,method=req.method;
    if(path==='/api/chat/ai'&&method==='GET'){try{json(res,await refreshAgents());}catch(e){json(res,{items:agents(),connected:false,error:e.message});}return true;}
    const member=/^\/api\/chat\/threads\/([0-9a-f-]{36})\/ai(?:\/([0-9a-f-]{36}))?$/.exec(path);
    if(member){own(session,member[1]);if(method==='POST'){const data=await readJson(req);await refreshAgents();json(res,{item:addAI(session,member[1],data.aiId)});return true;}if(method==='DELETE'&&member[2]){removeAI(session,member[1],member[2]);json(res,{ok:true});return true;}}
    const avatar=/^\/api\/chat\/ai\/([0-9a-f-]{36})\/avatar$/.exec(path);
    if(avatar&&method==='GET'){const a=agent(avatar[1]);check(a.avatar_url,'此AI未设置图片。',404);const r=await remote(a.avatar_url);res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(Buffer.from(await r.arrayBuffer()));return true;}
    if(path==='/api/chat/memories'&&method==='GET'){json(res,{items:db.prepare('SELECT * FROM chat_memories WHERE owner_key=? ORDER BY updated_at DESC LIMIT 200').all(session.key).map(m=>({id:m.id,body:m.body,scope:m.scope,threadId:m.thread_id,sourceMessageId:m.source_message_id,sourceActor:m.source_actor,version:m.version,revoked:!!m.revoked}))});return true;}
    if(path==='/api/chat/memories'&&method==='POST'){const d=await readJson(req);check(['private','shared','group'].includes(d.scope),'请选择共享范围。');if(d.scope==='group')own(session,d.threadId);const body=cleanText(d.body,'记忆',600,true),id=stableId(session.key+d.scope+(d.threadId||'')+body),at=now();db.prepare('INSERT INTO chat_memories VALUES(?,?,?,?,?,NULL,?,1,0,?,?) ON CONFLICT(id) DO NOTHING').run(id,session.key,d.scope,d.scope==='group'?d.threadId:null,body,session.key,at,at);json(res,{id});return true;}
    const memory=/^\/api\/chat\/memories\/([0-9a-f-]{36})$/.exec(path);
    if(memory&&['PATCH','DELETE'].includes(method)){const old=db.prepare('SELECT * FROM chat_memories WHERE id=?').get(memory[1]);check(old?.owner_key===session.key,'不能修改他人的个人记忆。',403);const d=method==='PATCH'?await readJson(req):{};check(method==='DELETE'||d.version===old.version,'记忆已变更，请重新读取。',409);const scope=d.scope||old.scope;check(['private','shared','group'].includes(scope),'共享范围无效。');check(scope!=='group'||old.thread_id,'该记忆没有群来源。');db.prepare('UPDATE chat_memories SET scope=?,body=?,revoked=?,version=version+1,updated_at=? WHERE id=?').run(scope,cleanText(d.body??old.body,'记忆',600,true),method==='DELETE'||d.revoked===true?1:0,now(),old.id);for(const t of db.prepare('SELECT thread_id FROM chat_members WHERE account_key=?').all(session.key)){social.invalidateRoster(t.thread_id);}json(res,{ok:true});return true;}
    if(path.startsWith('/api/chat/admin/personas')){
      check(session.role==='admin','人格管理仅管理员可用。',403,'admin_required');
      const picture=/^\/api\/chat\/admin\/personas\/([^/]+)\/avatar$/.exec(path);
      if(picture&&method==='GET'){const r=await remote('/v2/avatars/'+encodeURIComponent(decodeURIComponent(picture[1])),{admin:true});res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(Buffer.from(await r.arrayBuffer()));return true;}
      if(path==='/api/chat/admin/personas/drafts'&&method==='GET'){json(res,{items:db.prepare('SELECT remote_id AS id,document,base_version AS baseVersion,updated_at AS updatedAt FROM chat_persona_drafts WHERE account_key=?').all(session.key).map(r=>({...r,document:JSON.parse(r.document)}))});return true;}
      if(path==='/api/chat/admin/personas'&&method==='GET'){json(res,await jsonRemote('/v2/personas',{admin:true}));return true;}
      if(path==='/api/chat/admin/personas/import'&&method==='POST'){const d=await readJson(req,12*1024*1024),key=req.headers['idempotency-key']||newId();db.prepare('INSERT INTO chat_persona_drafts VALUES(?,?,?,?,?) ON CONFLICT(account_key,remote_id) DO UPDATE SET document=excluded.document,base_version=excluded.base_version,updated_at=excluded.updated_at').run(session.key,d.id||'__import__',JSON.stringify(d),d.version||null,now());const value=await jsonRemote('/v2/personas/import',{admin:true,method:'POST',body:d,version:d.version,key,actor:session.key});const read=await jsonRemote('/v2/personas/'+encodeURIComponent(value.item.id),{admin:true});check(read.item.version===value.item.version,'服务器回读已变更，草稿保留。',409);db.prepare('DELETE FROM chat_persona_drafts WHERE account_key=? AND remote_id=?').run(session.key,d.id||'__import__');await refreshAgents();json(res,read);return true;}
      const p=/^\/api\/chat\/admin\/personas(?:\/([^/]+))?$/.exec(path);
      if(p&&method==='GET'&&p[1]){json(res,await jsonRemote('/v2/personas/'+encodeURIComponent(decodeURIComponent(p[1])),{admin:true}));return true;}
      if(p&&['POST','PUT'].includes(method)){const d=await readJson(req,12*1024*1024),id=p[1]?decodeURIComponent(p[1]):d.id;const document={...d,id};db.prepare('INSERT INTO chat_persona_drafts VALUES(?,?,?,?,?) ON CONFLICT(account_key,remote_id) DO UPDATE SET document=excluded.document,base_version=excluded.base_version,updated_at=excluded.updated_at').run(session.key,id,JSON.stringify(document),d.version||null,now());const result=await jsonRemote('/v2/personas'+(p[1]?'/'+encodeURIComponent(id):''),{admin:true,method,body:document,version:d.version,key:req.headers['idempotency-key']||newId(),actor:session.key});const fresh=await jsonRemote('/v2/personas/'+encodeURIComponent(result.item.id),{admin:true});check(fresh.item.version===result.item.version,'人格在保存后再次变更，请重新读取；草稿已保留。',409);db.prepare('DELETE FROM chat_persona_drafts WHERE account_key=? AND remote_id=?').run(session.key,id);await refreshAgents();json(res,{...fresh,synced:true});return true;}
    }
    return false;
  }
  return {get configured(){return configured;},reconfigure(){configured=!!(settings.baseUrl&&settings.chatToken);if(configured)void refreshAgents().catch(()=>{});},agents,refreshAgents,prepare,queue,memberAIs,remember,retry,handle,invalidate,
    stop(session,thread){own(session,thread);for(const job of db.prepare("SELECT j.* FROM chat_ai_jobs j JOIN chat_messages m ON m.id=j.source_id WHERE j.thread_id=? AND m.sender_key=? AND j.state IN('queued','running')").all(thread,session.key)){const running=active.get(job.id);if(running)running.controller.abort();else{db.prepare("UPDATE chat_ai_jobs SET state='canceled' WHERE id=?").run(job.id);update(job,'','stopped','已停止。');}}},
    decorate(item){if(!item.senderKey.startsWith('ai:'))return item;const a=db.prepare('SELECT * FROM chat_ai_agents WHERE id=?').get(item.senderKey.slice(3));return a?{...item,senderName:a.name,senderId:a.id,senderAvatar:a.avatar_url?'/api/chat/ai/'+a.id+'/avatar':null,ai:true,personaId:a.remote_id}:item;},
    close(){for(const [id,run] of active){const job=db.prepare('SELECT * FROM chat_ai_jobs WHERE id=?').get(id);if(job)update(job,run.text,'stopped','软件服务已关闭，收到的文字已保留。');run.controller.abort();}closed=true;clearInterval(timer);clearInterval(refreshTimer);}};
}

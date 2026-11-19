import {check,cleanText,now,transaction}from'./core.mjs';
import{readJson}from'./media.mjs';
import{recordChange}from'./logs.mjs';
export function createManagement(db,config,{social,emit,onConnection}){
 const settings=()=>JSON.parse(db.prepare("SELECT value FROM app_flags WHERE key='tsukiakari-service'").get()?.value||'{}');
 return async function handle(session,req,res,url,json){
  const p=url.pathname;if(!p.startsWith('/api/chat/admin/'))return false;
  if(p.startsWith('/api/chat/admin/personas'))return false;
  check(session.role==='admin','软件管理仅管理员可用。',403);const method=req.method;
  if(p==='/api/chat/admin/overview'&&method==='GET'){json(res,{item:{users:db.prepare('SELECT count(*) AS n FROM chat_accounts').get().n,groups:db.prepare("SELECT count(*) AS n FROM chat_threads WHERE kind='group'").get().n,friends:db.prepare('SELECT count(*) AS n FROM chat_friendships').get().n,websiteLinked:!!config.siteBridge,astrbotConfigured:!!config.astrbot?.baseUrl}});return true;}
  if(p==='/api/chat/admin/groups'&&method==='GET'){json(res,{items:db.prepare("SELECT t.id,t.title,t.owner,t.created_at AS createdAt,(SELECT count(*) FROM chat_members WHERE thread_id=t.id) AS members,(SELECT count(*) FROM chat_ai_members WHERE thread_id=t.id AND active=1) AS aiMembers FROM chat_threads t WHERE kind='group' ORDER BY created_at DESC LIMIT 200").all().map(t=>({...t,ownerName:social.profile(t.owner)?.displayName||'已停用'}))});return true;}
  if(p==='/api/chat/admin/friends'&&method==='GET'){json(res,{items:db.prepare('SELECT a_key,b_key,created_at FROM chat_friendships ORDER BY created_at DESC LIMIT 200').all().map(r=>({a:social.profile(r.a_key),b:social.profile(r.b_key),createdAt:r.created_at})),pending:db.prepare("SELECT count(*) AS n FROM chat_friend_requests WHERE state='pending'").get().n});return true;}
  const group=/^\/api\/chat\/admin\/groups\/([0-9a-f-]{36})$/.exec(p);
  if(group&&method==='PATCH'){const d=await readJson(req),title=cleanText(d.title,'群名',80,true);check(db.prepare("SELECT 1 FROM chat_threads WHERE id=? AND kind='group'").get(group[1]),'群聊不存在。',404);db.prepare('UPDATE chat_threads SET title=?,updated_at=? WHERE id=?').run(title,now(),group[1]);recordChange(db,'admin:'+session.username,'group.update','chat-group',group[1],'修改群名',null);emit(null,group[1],'threads',{});json(res,{ok:true});return true;}
  if(p==='/api/chat/admin/service'){
   if(method==='GET'){json(res,{item:{...settings(),astrbotUrl:config.astrbot?.baseUrl||'',hasChatToken:!!config.astrbot?.chatToken,hasAdminToken:!!config.astrbot?.adminToken,connectionWritable:!!config.saveConnection,websiteUrl:config.websiteUrl||'本服务兼容模式',audioLimit:100000000}});return true;}
   if(method==='PUT'){const d=await readJson(req,16000);if(d.connection){check(config.saveConnection,'此服务由环境变量管理连接，请在服务端配置。',409);const c=d.connection;let u;try{u=new URL(c.baseUrl);}catch{check(false,'接口地址无效。');}check((u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))&&!u.username&&!u.password&&!u.search&&!u.hash,'连接需使用HTTPS或本机HTTP，不能包含账号或查询参数。');const next={baseUrl:c.baseUrl.replace(/\/$/,''),chatToken:c.chatToken||config.astrbot?.chatToken||'',adminToken:c.adminToken||config.astrbot?.adminToken||''};check(next.chatToken.length>=32&&next.adminToken.length>=32&&!/[\r\n]/.test(next.chatToken+next.adminToken),'请填写独立有效令牌，至少32字符。');await config.saveConnection(next);Object.assign(config.astrbot,next);onConnection?.();}
    const values={defaultSound:d.defaultSound!==false,defaultTaskbar:d.defaultTaskbar!==false,defaultDesktop:d.defaultDesktop!==false};db.prepare("INSERT INTO app_flags(key,value) VALUES('tsukiakari-service',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(values));recordChange(db,'admin:'+session.username,'service.update','chat-service','settings','保存软件服务设置与受限连接（密钥已脱敏）',null);json(res,{ok:true});return true;}
  }
  return false;
 };
}

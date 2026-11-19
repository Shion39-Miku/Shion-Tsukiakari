import http from 'node:http';
import https from 'node:https';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {randomBytes} from 'node:crypto';
import {check,Problem,now} from './core.mjs';
import {requireAccount} from './auth.mjs';
import {canReadChatFile} from './chat-access.mjs';

export function createSiteBridge({baseUrl,eventToken='',db}){
 const clients=new Set();
 const origin=new URL(baseUrl).origin;
 check(new URL(origin).protocol==='https:'||['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname),'网站联动须使用HTTPS或本机地址。');
 const cookies=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>!x.startsWith('hoshifuru_')&&!x.startsWith('moonlit_chat_session=')).join('; ');
 async function fetchSite(path,{req,method='GET',body,headers={}}={}){
  const response=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Cookie:req?cookies(req):'','Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  if(!response.ok){const value=await response.json().catch(()=>({}));throw new Problem(response.status===401?403:response.status,'website_'+(value.error?.code||'unavailable'),response.status===401?'请先连接网站管理员账号。':value.error?.message||'网站后端暂不可达。');}return response;
 }
 const get=async(path,req)=>(await fetchSite(path,{req})).json();
 async function siteSession(req){return get('/api/admin/session',req);}
 async function login(credentials){const r=await fetchSite('/api/admin/login',{method:'POST',body:credentials});return r.headers.getSetCookie();}
 function shouldProxy(path){return path.startsWith('/api/public/')||path.startsWith('/api/v1/')||path.startsWith('/api/admin/')&&!path.startsWith('/api/admin/accounts')||['/','/about','/music','/games','/cats','/questions','/admin','/admin/login'].includes(path)||path.startsWith('/media/');}
 async function handle(req,res,url){
  const path=url.pathname;
  if(!shouldProxy(path))return false;
  const headers={...req.headers,host:new URL(origin).host,cookie:cookies(req)};delete headers['x-hoshifuru-desktop'];
  if(path.startsWith('/api/admin/')||path.startsWith('/api/v1/')){
   const actor=requireAccount(db,{headers:req.headers,chatAdminCookieName:req.chatAdminCookieName,method:'GET'});check(actor.role==='admin','网站管理仅管理员可用。',403);
   if(req.method!=='GET'&&req.method!=='HEAD'&&headers['x-csrf-token']===actor.csrf){const value=await siteSession(req);headers['x-csrf-token']=value.csrf;}
  }
  if(headers.origin)headers.origin=origin;
  await new Promise((done,reject)=>{
   const client=(origin.startsWith('https:')?https:http).request(origin+url.pathname+url.search,{method:req.method,headers,timeout:900000},response=>{
    const responseHeaders={...response.headers};delete responseHeaders['x-moonlit-instance'];
    if(response.statusCode===401&&path.startsWith('/api/admin/')){response.resume();res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:{code:'website_login_required',message:'网站会话已失效，请在网站管理中重新登录。'}}));done();return;}
    res.writeHead(response.statusCode,responseHeaders);response.pipe(res);response.on('end',done);response.on('error',reject);
   });clients.add(client);client.once('close',()=>clients.delete(client));client.on('timeout',()=>client.destroy(new Error('website timeout')));client.on('error',reject);req.on('aborted',()=>client.destroy());res.on('close',()=>client.destroy());req.pipe(client);
  });return true;
 }
 async function events(after,req){await siteSession(req);check(eventToken,'网站事件连接未配置。',503);return(await fetchSite('/api/v1/events?after='+after+'&limit=100',{headers:{Authorization:'Bearer '+eventToken}})).json();}
 async function exportMedia(session,req,ids){
  check(Array.isArray(ids)&&ids.length<=8,'导出媒体列表无效。');const site=await siteSession(req),result={};
  for(const id of ids){check(canReadChatFile(db,session.key,id),'不能转交不属于当前账号或会话的附件。',403);const existing=db.prepare('SELECT site_media_id FROM chat_site_exports WHERE account_key=? AND media_id=?').get(session.key,id);if(existing){result[id]=existing.site_media_id;continue;}
   const m=db.prepare('SELECT * FROM media WHERE id=?').get(id);check(m,'附件不存在。',404);const kind=m.mime.startsWith('image/')?'image':m.mime.startsWith('audio/')?'audio':'lyrics';const boundary='hoshifuru'+randomBytes(16).toString('hex');
   const filename=m.name.replace(/["\r\n\\]/g,'_');const prefix=Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="kind"\r\n\r\n'+kind+'\r\n--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="'+filename+'"\r\nContent-Type: '+m.mime+'\r\n\r\n'),suffix=Buffer.from('\r\n--'+boundary+'--\r\n');
   async function* content(){yield prefix;for(const chunk of db.prepare('SELECT data FROM media_chunks WHERE media_id=? ORDER BY seq').iterate(id))yield Buffer.from(chunk.data);yield suffix;}
   const response=await fetch(origin+'/api/admin/files',{method:'POST',duplex:'half',body:Readable.from(content()),signal:AbortSignal.timeout(900000),headers:{Cookie:cookies(req),'X-CSRF-Token':site.csrf,'Idempotency-Key':'export_'+id,'Content-Type':'multipart/form-data; boundary='+boundary,'Content-Length':String(prefix.length+m.size+suffix.length)}});
   const value=await response.json();check(response.ok,value.error?.message||'网站附件转交失败，源文件保留。',response.status);result[id]=value.item.id;db.prepare('INSERT INTO chat_site_exports VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(session.key,id,value.item.id,now());
  }return result;
 }
 return{origin,shouldProxy,handle,get,login,events,exportMedia,siteSession,close(){for(const c of clients)c.destroy();clients.clear();}};
}

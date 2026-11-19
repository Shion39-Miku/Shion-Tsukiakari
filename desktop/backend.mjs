import { createApplication } from './server/app.mjs';
import { readConfig,sha256,openDatabase,check } from './server/core.mjs';
import {setAdmin}from'./server/auth.mjs';
import { DatabaseSync,backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { writeFile,mkdir } from 'node:fs/promises';
import { dirname,join } from 'node:path';
import { randomBytes } from 'node:crypto';

let server,website,stopping=false,starting=false,initializing=false;const replies=new Map();
async function shutdown(){if(stopping)return;stopping=true;const force=setTimeout(()=>process.exit(0),6000);force.unref();for(const s of[server,website])if(s){s.closeAllConnections();await new Promise(done=>s.close(done));}process.exit(0);}
async function initializeDatabases(message){
 const source=existsSync(message.legacyDbPath)?message.legacyDbPath:message.seedDbPath;let copied=false;
 for(const path of[message.dbPath,message.websiteDbPath])if(!existsSync(path)){await mkdir(dirname(path),{recursive:true});const selected=path===message.websiteDbPath&&existsSync(message.websiteSeedDbPath||'')&&!existsSync(message.legacyDbPath)?message.websiteSeedDbPath:source;const db=new DatabaseSync(selected,{readOnly:true});try{await backup(db,path);}finally{db.close();}copied=true;}
 if(copied)await writeFile(join(dirname(message.dbPath),'split-migration.json'),JSON.stringify({at:new Date().toISOString(),source,chat:message.dbPath,website:message.websiteDbPath,legacyPreserved:existsSync(message.legacyDbPath)},null,2));
}
async function listen(instance,port){await new Promise((done,reject)=>{instance.once('error',reject);instance.listen(port,'127.0.0.1',done);});return instance.address().port;}
process.once('disconnect',()=>shutdown());process.once('SIGTERM',()=>shutdown());
process.on('message',async message=>{
 if(message?.type==='connection-saved'){const r=replies.get(message.id);if(r){replies.delete(message.id);message.error?r.reject(Error(message.error)):r.resolve();}return;}
 if(message?.type==='shutdown')return shutdown();if(message?.type!=='start'||starting||stopping)return;starting=true;
 try{
  const{dbPath,port,accessToken,chat,astrbot}=message;if(typeof accessToken!=='string'||accessToken.length<40||typeof dbPath!=='string')throw Error('桌面服务启动配置无效。');
  await initializeDatabases(message);process.env.PORT=String(port);process.env.DATABASE_PATH=dbPath;process.env.BOT_TOKENS='[]';process.env.CHAT_AI_CONFIG_FILE='';
  const base={...readConfig({envFile:false}),host:'127.0.0.1',baseUrl:'',seedDemo:false,secureCookie:false,ipGeoEnabled:false};
  const eventToken=randomBytes(32).toString('base64url'),eventBot={id:'hoshifuru-local-feed',hash:sha256(eventToken),scopes:new Set(['events:read','events:ack','content-events:read','catalog:read','questions:review','batches:read'])};
  website=await createApplication({...base,dbPath:message.websiteDbPath,disableChat:true,serviceMode:'website',bots:new Map([[eventBot.id,eventBot]]),astrbot:{}});
  let websitePort;try{websitePort=await listen(website,port<65535?port+1:0);}catch(error){if(error.code!=='EADDRINUSE')throw error;websitePort=await listen(website,0);}
  const initializeAdmin=async d=>{check(!initializing,'正在初始化，请稍候。',409);initializing=true;const a=openDatabase(dbPath),b=openDatabase(message.websiteDbPath);try{check(!a.prepare('SELECT 1 FROM admins LIMIT 1').get(),'管理员已存在。',409);await setAdmin(b,d.username,d.password);await setAdmin(a,d.username,d.password);}finally{a.close();b.close();initializing=false;}};
  const saveConnection=value=>new Promise((resolve,reject)=>{const id=randomBytes(16).toString('hex');const timer=setTimeout(()=>{replies.delete(id);reject(Error('安全保存连接超时，尚未确认。'));},10000);replies.set(id,{resolve:()=>{clearTimeout(timer);resolve();},reject:e=>{clearTimeout(timer);reject(e);}});process.send({type:'connection-save',id,value});});
  server=await createApplication({...base,dbPath,port,serviceMode:'chat',initializeAdmin,saveConnection,bots:new Map(),desktopAccessToken:accessToken,websiteUrl:'http://127.0.0.1:'+websitePort,websiteEventToken:eventToken,astrbot:astrbot||{},chat:{...base.chat,...chat}});
  await listen(server,port);process.send?.({type:'ready',port,websitePort});
 }catch(error){console.error('桌面服务初始化失败：'+error.message);process.send?.({type:'failed'});void shutdown();}
});

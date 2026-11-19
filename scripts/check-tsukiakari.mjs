import assert from'node:assert/strict';
import{randomBytes,randomUUID}from'node:crypto';
import{createServer}from'node:http';
import{once}from'node:events';
import{mkdtemp,mkdir,writeFile,readFile,copyFile}from'node:fs/promises';
import{join,resolve}from'node:path';
import{homedir}from'node:os';
import{pathToFileURL}from'node:url';
import{DatabaseSync}from'node:sqlite';
import{checkChatResilience}from'./check-chat-resilience.mjs';
const root=resolve('.'),out=resolve(process.env.TSUKIAKARI_QA_OUTPUT||'artifacts/tsukiakari-check'),screens=resolve(process.env.TSUKIAKARI_QA_SCREENSHOTS||'docs/images');await mkdir(out,{recursive:true});await mkdir(screens,{recursive:true});
const data=await mkdtemp(join(out,'demo-')),password=randomBytes(20).toString('hex');
const personas=new Map([['demo-fish',{id:'demo-fish',name:'知遥 · 演示人格',description:'用于软件截图的演示人格',systemPrompt:'这是演示环境。以简洁的中文交流。',beginDialogs:[],firstMessage:'晚上好。月色很安静，我在这里。',exampleDialogue:'',extensions:{},enabled:true,version:'v1',avatar:false}]]);let revision=1,calls=0,personaAllowed=true;
const bot=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const d=chunks.length?JSON.parse(Buffer.concat(chunks)):{};const json=(v,status=200)=>res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(v));
 if(req.url==='/v2/agents')return json({items:[...personas.values()],defaultId:'demo-fish'});
 if(req.url==='/v2/scopes/revoke')return json({ok:true});
 if(req.url.startsWith('/v2/personas')&&!personaAllowed)return json({error:{message:'演示人格连接令牌已失效'}},401);
 if(req.url.startsWith('/v2/personas')&&req.headers.authorization!=='Bearer tsukiakari-demo-admin-token-000000000000')return json({error:{message:'缺少人格管理权限'}},403);
 if(req.url==='/v2/personas'&&req.method==='GET')return json({items:[...personas.values()]});
 if(req.url==='/v2/personas'&&req.method==='POST'){const p={...d,avatar:!!d.avatarPng,version:'v'+(++revision)};personas.set(p.id,p);return json({item:p});}
 if(req.url.startsWith('/v2/personas/')){const id=decodeURIComponent(req.url.slice(13)),p=personas.get(id);if(req.method==='GET')return json({item:p});if(req.headers['if-match']!==p?.version)return json({error:{message:'服务器版本已变化'}},409);const n={...d,id,version:'v'+(++revision)};personas.set(id,n);return json({item:n});}
 if(req.url==='/v2/chat'){calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});const slow=d.messages.at(-1).body==='演示 · 需要停止的流式回复';for(const text of(slow?Array(10).fill('已经收到的文字。'):['当然可以。\n\n','把今天的喧闹留在窗外吧。你可以说说近况，','或选一首喜欢的歌，让这个夜晚慢一点。\n\n','这是一段用于界面演示的回复。'])){if(res.destroyed)return;res.write('data: '+JSON.stringify({delta:text,conversationId:'demo-'+d.scope.threadId,umo:'demo-scope-'+d.scope.threadId})+'\n\n');await new Promise(r=>setTimeout(r,slow?230:60));}res.end('data: [DONE]\n\n');return;}
 return json({item:null});
});bot.listen(0,'127.0.0.1');await once(bot,'listening');const configFile=join(data,'demo-astrbot.json');await writeFile(configFile,JSON.stringify({baseUrl:'http://127.0.0.1:'+bot.address().port,chatToken:'tsukiakari-demo-chat-token-0000000000000',adminToken:'tsukiakari-demo-admin-token-000000000000'}));
const{_electron}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE):'playwright');
const environment={...process.env,NODE_PATH:'',TSUKIAKARI_DESKTOP_DATA:data,TSUKIAKARI_ASTRBOT_FILE:configFile,TSUKIAKARI_MODEL_FILE:join(data,'no-model.json')};delete environment.ELECTRON_RUN_AS_NODE;
const exe=process.env.TSUKIAKARI_QA_EXECUTABLE;let app,page,member,aiId,groupId,friendId;const report={at:new Date().toISOString(),mode:exe?'packaged':'source',checks:[],errors:[],screenshots:[]};
const pass=s=>{report.checks.push(s);console.log('通过：'+s);};const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(){app=await _electron.launch({executablePath:exe||join(root,'desktop/node_modules/electron/dist/electron.exe'),args:exe?[]:[join(root,'desktop')],env:environment,timeout:50000});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>report.errors.push(e.message));await page.waitForURL(/http:\/\/127\.0\.0\.1:\d+\/chat/);await page.locator('.desktop-titlebar').waitFor();}
async function api(path,method='GET',json,p=page){return p.evaluate(async({path,method,json})=>{const s=await(await fetch('/api/chat/session')).json();const r=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf,'Idempotency-Key':crypto.randomUUID()},body:json===undefined?undefined:JSON.stringify(json)});return{status:r.status,body:await r.json()};},{path,method,json});}
async function nav(label){await page.locator('#app-rail').getByRole('button',{name:label,exact:true}).click();}
async function shot(name){
 await page.locator('#app-boot').waitFor({state:'hidden'});
 await page.waitForTimeout(350);
 await page.screenshot({path:join(screens,name+'.png')});
 report.screenshots.push('docs/images/'+name+'.png');
}
async function send(text){await page.getByRole('textbox',{name:'聊天消息',exact:true}).fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();}
async function closeModal(){if(await page.locator('#app-dialog[open]').count())await page.getByRole('button',{name:'关闭对话框',exact:true}).click();}
try{
 await boot();await page.getByRole('button',{name:'创建管理员',exact:true}).waitFor();await page.getByLabel('账号',{exact:true}).fill('demo_owner');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'创建管理员',exact:true}).click();await page.locator('#app-shell:not([hidden])').waitFor();assert.equal(await page.title(),'月明かり');assert.equal((await api('/api/chat/bootstrap')).body.available,false);assert.equal(await page.locator('#background-audio').count(),0);
 const native=await app.evaluate(({app,BrowserWindow})=>({name:app.getName(),...global.__hoshifuruDesktop,features:global.__hoshifuruDesktop.features(),web:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().sandbox}));assert.equal(native.name,'月明かり');assert.equal(native.features.tray,true);assert.equal(native.web,true);assert.notEqual(native.origin,native.websiteOrigin);pass('干净安装首次设置管理员，两套独立后端可用；原生窗口、托盘与无背景音乐正确');
 const me=(await api('/api/chat/profile')).body.item;await api('/api/chat/profile','PATCH',{version:me.version,displayName:'月庭管理人',status:'online'});
 await api('/api/admin/accounts','POST',{username:'luna',password});const event=app.waitForEvent('window');await app.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(i=>i.label==='新建登录窗口').click());member=await event;member.setDefaultTimeout(20000);await member.waitForURL(/\/chat$/);await member.getByLabel('账号',{exact:true}).fill('luna');
 await member.getByLabel('密码',{exact:true}).fill('invalid-demo-password');
 await member.getByRole('button',{name:'登录',exact:true}).click();
 await member.getByText('账号或密码不正确。',{exact:true}).waitFor();
 await member.getByLabel('密码',{exact:true}).fill(password);await member.getByRole('button',{name:'登录',exact:true}).click();
 await member.locator('#app-shell:not([hidden])').waitFor();const ms=(await api('/api/chat/session','GET',undefined,member)).body;
 assert.equal(await member.locator('#app-rail').getByRole('button',{name:'软件管理',exact:true}).count(),0);
 await member.locator('#app-rail').getByRole('button',{name:'个人设置',exact:true}).click();
 await member.getByLabel('显示名称',{exact:true}).fill('澄月');
 await member.getByRole('button',{name:'保存修改',exact:true}).click();
 await member.getByText('资料已保存，好友与群成员会同步看到。',{exact:true}).waitFor();
 await member.locator('#app-header').getByRole('button',{name:'返回聊天',exact:true}).click();
 await page.bringToFront();
 await page.getByRole('button',{name:'通讯录',exact:true}).click();
 await page.getByRole('button',{name:'搜索用户',exact:true}).click();
 await page.getByLabel('用户ID、账号或名称',{exact:true}).fill(ms.profile.id);
 await page.getByRole('button',{name:'搜索',exact:true}).click();
 await page.getByRole('button',{name:'添加好友',exact:true}).click();
 await page.getByRole('button',{name:'已申请',exact:true}).waitFor();await closeModal();
 await member.bringToFront();
 await member.getByRole('button',{name:'通讯录',exact:true}).click();
 await member.getByRole('button',{name:'好友申请',exact:true}).click();
 await member.getByRole('button',{name:'接受',exact:true}).click();
 await member.getByText('已添加为好友',{exact:true}).waitFor();
 await member.getByRole('button',{name:'关闭对话框',exact:true}).click();
 const dm=(await api('/api/chat/threads','POST',{kind:'direct',members:[ms.key]})).body.item;friendId=dm.id;await api('/api/chat/threads/'+dm.id+'/messages','POST',{text:'今晚想听一首安静的歌。'},member);await api('/api/chat/threads/'+dm.id+'/messages','POST',{text:'好呀，晚一点我们去月光庭院看看。'});
 const group=(await api('/api/chat/threads','POST',{kind:'group',title:'月下茶话 · 演示群',members:[ms.key]})).body.item;groupId=group.id;
 assert.equal((await api('/api/chat/threads/'+groupId,'GET',undefined,member)).status,404);
 await member.getByRole('button',{name:'申请与邀请',exact:true}).click();
 await member.getByRole('button',{name:'接受邀请',exact:true}).click();
 await member.getByRole('button',{name:'打开群聊',exact:true}).click();
 await member.locator('#app-header .header-identity').filter({hasText:'群聊'}).waitFor();
 await api('/api/chat/threads/'+groupId+'/messages','POST',{text:'这里是包含 AI 与好友的演示群，大家都能分辨彼此。'},member);
 const agents=(await api('/api/chat/ai')).body.items;await api('/api/chat/threads/'+groupId+'/ai','POST',{aiId:agents[0].id});
 assert.equal((await api('/api/chat/admin/overview','GET',undefined,member)).status,403);assert.equal((await api('/api/chat/admin/personas','GET',undefined,member)).status,403);assert.equal((await api('/api/admin/settings','GET',undefined,member)).status,403);pass('好友双向申请、邀请入群及混合AI成员真实落库；普通用户不能越权进入两套管理');
 await page.bringToFront();await page.getByRole('button',{name:'新建会话',exact:true}).click();await page.getByRole('button',{name:'AI 对话',exact:true}).click();await page.getByRole('button',{name:'与这位AI聊天',exact:true}).click();await page.waitForURL(u=>u.searchParams.has('t'));aiId=new URL(page.url()).searchParams.get('t');await page.locator('#app-header h1').filter({hasText:'知遥'}).waitFor();await send('晚上好，知遥。今天想在这里放松一会儿。');await page.locator('.message.assistant .message-bubble').filter({hasText:'这是一段用于界面演示的回复。'}).waitFor();assert.equal(await page.locator('.message.assistant .ai-member-badge').count(),1);await shot('ai-chat');
 await page.getByRole('button',{name:'好友',exact:true}).click();await page.locator('.thread-button').filter({hasText:'澄月'}).click();await page.locator('#app-header h1').filter({hasText:'澄月'}).waitFor();assert.equal(await page.locator('#app-header .header-identity').textContent(),'好友');await shot('friend-chat');
 await page.getByRole('button',{name:'群聊',exact:true}).click();await page.locator('.thread-button').filter({hasText:'月下茶话'}).click();await send('知遥也来和大家打个招呼吧。');await page.locator('.message.assistant .message-bubble').filter({hasText:'这是一段用于界面演示的回复。'}).waitFor();await page.getByRole('button',{name:'查看群成员'}).click();await page.locator('#conversation-details .person-row').filter({hasText:'知遥'}).waitFor();await shot('group-chat');await page.getByRole('button',{name:'关闭会话详情'}).click();pass('AI/好友/群聊分类、对象头部、混合群AI标识及按需成员侧栏正确');
 await page.getByRole('textbox',{name:'聊天消息',exact:true}).fill('未发送的月色 · 页面返回验证');const original=page.url();await nav('个人设置');await page.getByRole('button',{name:'外观',exact:true}).click();await page.getByLabel('界面密度').selectOption('compact');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByText('偏好已保存。',{exact:true}).waitFor();await shot('personal-settings');await page.locator('#app-header').getByRole('button',{name:'返回聊天'}).click();assert.equal(await page.getByRole('textbox',{name:'聊天消息',exact:true}).inputValue(),'未发送的月色 · 页面返回验证');assert.equal(await page.getByRole('button',{name:'群聊',exact:true}).getAttribute('aria-pressed'),'true');await nav('个人设置');await page.getByRole('button',{name:'通知',exact:true}).click();await page.getByLabel('消息提示音',{exact:true}).uncheck();await page.getByRole('button',{name:'保存修改',exact:true}).click();assert.equal((await api('/api/chat/preferences')).body.item.sound,false);await page.getByRole('button',{name:'关闭窗口',exact:true}).click();await page.getByLabel('关闭窗口时').selectOption('background');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByText('偏好已保存。',{exact:true}).waitFor();pass('个人设置独立页面，返回保留草稿与筛选，外观/通知/关闭行为分别保存');
 await nav('网站管理');await page.locator('#manage-main .admin-tabs').waitFor();await shot('website-management');assert.equal((await api('/api/admin/drafts')).status,200);await nav('软件管理');await page.getByRole('heading',{name:'软件概览',exact:true}).waitFor();await shot('software-management');await page.getByRole('button',{name:'AI 人格／角色卡',exact:true}).click();await page.locator('.page-section .person-row').filter({hasText:'知遥'}).waitFor();await page.getByRole('button',{name:'编辑人格',exact:true}).click();await page.getByLabel('系统设定',{exact:true}).waitFor();await page.getByLabel('人格说明',{exact:true}).fill('演示角色 · 服务器管理的人格，月明かり只缓存同步状态。');await page.getByRole('button',{name:'保存并同步到 AstrBot',exact:true}).click();await page.getByText('已写入 AstrBot 并回读确认，使用此人格的AI会获取新版本。',{exact:true}).waitFor();assert.equal(personas.get('demo-fish').description,'演示角色 · 服务器管理的人格，月明かり只缓存同步状态。');await shot('persona-settings');pass('网站管理沿用独立草稿API；软件管理人格写入后回读版本，页面同步状态真实');
 await page.getByRole('button',{name:'服务与 AI 接入',exact:true}).click();await page.getByLabel('AstrBot 接口地址').waitFor();assert.equal(await page.getByLabel('聊天令牌',{exact:true}).inputValue(),'');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByText('设置已安全保存。连接可用性请在 AI 列表中刷新确认。',{exact:true}).waitFor();const secret=JSON.parse(await readFile(join(data,'connection-credentials.json'),'utf8'));assert.ok(secret.encrypted);assert.ok(!JSON.stringify(secret).includes('demo-admin-token'));pass('连接配置通过后端与主进程加密保存，密钥不回显');
 for(const size of[{width:900,height:680},{width:1280,height:860}]){await(await app.browserWindow(page)).evaluate((w,size)=>w.setSize(size.width,size.height),size);await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}await page.evaluate(()=>document.documentElement.style.zoom='1.25');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.evaluate(()=>document.documentElement.style.zoom='');pass('900px小窗口与125%缩放无页面横向溢出');
 await nav('聊天');await(await app.browserWindow(page)).evaluate(w=>w.close());await wait(200);assert.equal(await(await app.browserWindow(page)).evaluate(w=>w.isVisible()),false);assert.equal((await api('/api/chat/session')).status,200);await(await app.browserWindow(page)).evaluate(w=>{w.show();w.focus();});await page.evaluate(()=>window.hoshifuruDesktop.setPreferences({closeAction:'ask'}));pass('关闭选择后台时保留真实连接和托盘，窗口可恢复');
 const db=new DatabaseSync(join(data,'data/chat.sqlite'),{readOnly:true});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();assert.deepEqual(report.errors,[]);
 await api('/api/chat/preferences','PATCH',{sound:false,taskbar:false,desktop:false});await api('/api/chat/preferences','PATCH',{sound:false,taskbar:false,desktop:false},member);
 for(let i=0;i<64;i++){const r=await api('/api/chat/threads/'+friendId+'/messages','POST',{text:'滚动验收 '+i+' · 月色、星光与一段普通的聊天。'},i%2?member:page);assert.equal(r.status,201);}
 await page.goto(new URL('/chat?t='+friendId,page.url()).href);await page.locator('#app-shell:not([hidden])').waitFor();await page.getByRole('button',{name:'查看更早的消息',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-message-id]').length>60);await page.bringToFront();await page.locator('#conversation').evaluate(n=>n.scrollTop=180);await page.getByRole('textbox',{name:'聊天消息',exact:true}).fill('滚动位置与草稿保留');const position=await page.locator('#conversation').evaluate(n=>n.scrollTop);await nav('个人设置');await page.locator('#app-header').getByRole('button',{name:'返回聊天'}).click();assert.equal(await page.getByRole('textbox',{name:'聊天消息',exact:true}).inputValue(),'滚动位置与草稿保留');await wait(150);assert.ok(Math.abs(await page.locator('#conversation').evaluate(n=>n.scrollTop)-position)<8);
 const sample=page.evaluate(()=>new Promise(done=>{const values=[],start=performance.now();let before;function step(t){if(before&&t-start>250)values.push(t-before);before=t;if(t-start<1600)requestAnimationFrame(step);else done(values.sort((a,b)=>a-b));}requestAnimationFrame(step);}));const cdp=await page.context().newCDPSession(page),box=await page.locator('#conversation').boundingBox();await cdp.send('Input.synthesizeScrollGesture',{x:box.x+box.width/2,y:box.y+box.height/2,yDistance:-850,speed:800,gestureSourceType:'mouse'});const frames=await sample;report.performance={messageRows:await page.locator('[data-message-id]').count(),samples:frames.length,medianMs:frames[Math.floor(frames.length*.5)],p95Ms:frames[Math.floor(frames.length*.95)],over34:frames.filter(v=>v>34).length};assert.ok(frames.length>30&&report.performance.medianMs<34);await cdp.detach();pass('历史按需加载，真实66条消息滚动采样完成，切页保留滚动位置与输入草稿');
 await checkChatResilience({app,page,member,api,nav,shot,friendId,groupId,report});
 if(process.env.TSUKIAKARI_QA_BASELINE!=='1'){
  await page.goto(new URL('/chat?t='+aiId,page.url()).href);
  await page.locator('#app-header .header-identity').filter({hasText:'AI'}).waitFor();
  await send('演示 · 需要停止的流式回复');
  const response=page.locator('.message.assistant').last();
  await response.getByText('已经收到的文字。',{exact:true}).waitFor();
  await page.getByRole('button',{name:'停止回复',exact:true}).click();
  await response.getByRole('button',{name:'重试回复',exact:true}).waitFor();
  assert.match(await response.locator('.message-bubble').textContent(),/已经收到的文字/);
  await response.getByRole('button',{name:'重试回复',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.stop-reply').hidden);
  await page.waitForFunction(()=>document.querySelector('.stop-reply').hidden);
  assert.equal(await response.getByRole('button',{name:'重试回复',exact:true}).count(),0);
  pass('流式回复停止保留已接收文字，用户点击重试同一条回复');

  await nav('软件管理');
  await page.getByRole('button',{name:'AI 人格／角色卡',exact:true}).click();
  const backToPersonas=page.getByRole('button',{name:'返回人格列表',exact:true});
  if(await backToPersonas.count())await backToPersonas.click();
  await page.getByRole('button',{name:'编辑人格',exact:true}).click();
  const prompt=page.getByLabel('系统设定',{exact:true});
  await prompt.fill('演示 · 未提交的系统设定');
  const p=personas.get('demo-fish');
  personas.set(p.id,{...p,systemPrompt:'服务器侧同时做了修改。',version:'v'+(++revision)});
  const sync=page.getByRole('button',{name:'保存并同步到 AstrBot',exact:true});
  await sync.click();
  await page.getByText('服务器版本已变化',{exact:true}).waitFor();
  assert.equal(await prompt.inputValue(),'演示 · 未提交的系统设定');
  await page.getByRole('button',{name:'对照服务器版本',exact:true}).click();
  await page.getByText(/服务器侧同时做了修改/).waitFor();
  await page.getByRole('button',{name:'用此服务器版本继续编辑',exact:true}).click();
  personaAllowed=false;
  await sync.click();
  await page.getByText('演示人格连接令牌已失效',{exact:true}).waitFor();
  assert.equal((await api('/api/chat/session')).status,200);
  assert.equal(await prompt.inputValue(),'演示 · 未提交的系统设定');
  personaAllowed=true;
  await sync.click();
  await page.getByText('已写入 AstrBot 并回读确认，使用此人格的AI会获取新版本。',{exact:true}).waitFor();
  pass('人格冲突可对照合并，AstrBot 授权失效时保留草稿和软件会话');

  await page.context().clearCookies({name:'moonlit_session'});
  await nav('网站管理');
  await page.getByLabel('网站管理员账号',{exact:true}).fill('demo_owner');
  await page.getByLabel('网站管理员密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'连接网站后台',exact:true}).click();
  await page.locator('#manage-main .admin-tabs').waitFor();
  assert.equal((await api('/api/chat/session')).body.username,'demo_owner');
  assert.equal((await api('/api/admin/session')).status,200);
  pass('真实独立网站会话过期后可单独重新连接');
 }
 await app.close();app=null;await boot();await page.locator('#app-shell:not([hidden])').waitFor();assert.equal((await api('/api/chat/session')).body.username,'demo_owner');assert.ok((await api('/api/chat/threads')).body.items.some(t=>t.id===groupId));pass('退出与重启保留账号、会话、资料、群聊和加密连接');
}catch(e){report.failure=e.stack;if(page&&!page.isClosed())await page.screenshot({path:join(out,'failure.png')}).catch(()=>{});throw e;}
finally{if(app)await app.close().catch(()=>{});bot.closeAllConnections();await new Promise(r=>bot.close(r));await writeFile(join(out,'report.json'),JSON.stringify(report,null,2));console.log('报告：'+join(out,'report.json'));}

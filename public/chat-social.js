import { action,el,icon,iconButton,image,showStatus,toast,motionChoice } from './ui.js';
const statuses={online:'在线',away:'离开',busy:'忙碌',invisible:'隐身',offline:'离线'};
const field=(label,input)=>el('label',{class:'field'},el('span',{},label),input);
const text=(label,value='',max=200)=>el('input',{'aria-label':label,value, maxlength:max});
const area=(label,value='',max=12000)=>el('textarea',{'aria-label':label,rows:4,maxlength:max},value);
export function personAvatar(person,size=36){return typeof person?.avatar==='string'?image(person.avatar,person.displayName||person.username,{width:size,height:size,class:'account-avatar'}):el('span',{class:'account-avatar','aria-hidden':true},(person?.displayName||person?.username||'星').slice(0,1).toUpperCase());}
function personRow(person,...actions){return el('article',{class:'person-row'},personAvatar(person),el('div',{class:'person-copy'},el('strong',{},person.displayName||person.name||person.username),el('small',{},person.username?'账号 '+person.username+' · '+(statuses[person.status]||'离线'):person.description||'服务器AI'),el('code',{},person.id)),el('div',{class:'person-actions'},actions));}
async function perform(button,status,work){if(button.disabled)return;button.disabled=true;try{await work();}catch(error){showStatus(status,error.message,'error');}finally{button.disabled=false;}}

export function createSocialUI({request,account,openModal,openPage,openDetails,hasOpenSurface,dialog,refresh,onProfile,openThread,currentThread,uploadAvatar,routeStamp}){
 let redraw,heartbeat,surfaceTimer,preferences={sound:true,taskbar:true,desktop:true},noticeReady=false,lastBadge;
 const key=()=>account()?.key;
 async function loadPrefs(){const value=await request('/api/chat/preferences');preferences=value.item;if(lastBadge)updateBadge([],lastBadge.count);return preferences;}
 function reloadSurface(){
  if(surfaceTimer || !redraw || (!dialog.open && !hasOpenSurface?.())) return;
  surfaceTimer=setTimeout(()=>{
   surfaceTimer=null;
   if((dialog.open||hasOpenSurface?.())&&redraw)void redraw().catch(()=>{});
  },180);
 }
 function rowChat(person){const start=action('私聊','mail');start.onclick=()=>perform(start,el('span'),async()=>{const value=await request('/api/chat/threads',{method:'POST',json:{kind:'direct',members:[person.key]},key:crypto.randomUUID()});dialog.close();await openThread(value.item.id);});return start;}
 async function friends(tab='friends'){
  const content=el('div',{class:'social-dynamic-list'}),status=el('p',{class:'inline-status',role:'status'}),tabs=el('div',{class:'social-tabs'});
  const labels={friends:'好友',requests:'好友申请',invitations:'群邀请',search:'搜索用户'};
  for(const [value,label]of Object.entries(labels)){const b=action(label,undefined,{'aria-pressed':String(tab===value)});b.onclick=()=>friends(value);tabs.append(b);}
  const query=text('用户ID、账号或名称','',80),search=action('搜索','sparkle',{type:'submit'}),form=el('form',{class:'user-search'},field('用户ID、账号或名称',query),search);
  let currentQuery='';
  async function load(){
   if(tab==='friends'){const data=await request('/api/chat/friends');content.replaceChildren(...data.items.map(p=>personRow(p,rowChat(p))));if(!data.items.length)content.append(el('p',{class:'quiet-empty'},'还没有同行的人。通过用户ID或账号发送好友申请吧。'));}
   if(tab==='search'){
    if(!currentQuery)return;const data=await request('/api/chat/users?q='+encodeURIComponent(currentQuery));content.replaceChildren(...data.items.map(p=>{
     const label={self:'这是你',friends:'已添加',outgoing:'已申请',incoming:'处理申请',none:'添加好友'}[p.relationship];const add=action(label);add.disabled=['self','outgoing'].includes(p.relationship);
     add.onclick=()=>p.relationship==='friends'?rowChat(p).click():p.relationship==='incoming'?friends('requests'):perform(add,status,async()=>{await request('/api/chat/friend-requests',{method:'POST',json:{target:p.key},key:crypto.randomUUID()});await load();});
     return personRow(p,add);
    }));if(!data.items.length)content.append(el('p',{class:'quiet-empty'},'没有找到这位旅人，请核对ID或账号。'));
   }
   if(tab==='requests'){
    const data=await request('/api/chat/friend-requests');content.replaceChildren(...data.items.map(r=>{const incoming=r.to.key===key(),p=incoming?r.from:r.to,buttons=[];
     if(r.state==='pending')for(const [verb,label]of incoming?[['accept','接受'],['reject','拒绝']]:[['cancel','撤销申请']]){const b=action(label);b.onclick=()=>perform(b,status,async()=>{await request('/api/chat/friend-requests/'+r.id+'/'+verb,{method:'POST'});await load();await refresh();});buttons.push(b);}
     return el('div',{},el('small',{class:'relation-state'},({pending:incoming?'收到好友申请':'等待对方接受',accepted:'已添加为好友',rejected:'已拒绝',canceled:'已撤销'})[r.state]),personRow(p,buttons));
    }));if(!data.items.length)content.append(el('p',{class:'quiet-empty'},'暂时没有新的好友申请。'));
   }
   if(tab==='invitations'){
    const data=await request('/api/chat/invitations');content.replaceChildren(...data.items.map(r=>{const incoming=r.target.key===key(),buttons=[];
     if(r.state==='pending')for(const [verb,label]of incoming?[['accept','接受邀请'],['reject','拒绝邀请']]:[['revoke','撤销邀请']]){const b=action(label);b.onclick=()=>perform(b,status,async()=>{await request('/api/chat/invitations/'+r.id+'/'+verb,{method:'POST'});await load();await refresh();});buttons.push(b);}
     if(r.state==='accepted'&&incoming){const b=action('打开群聊');b.onclick=async()=>{dialog.close();await openThread(r.threadId);};buttons.push(b);}
     return el('article',{class:'invite-card'},el('h3',{},r.title),el('p',{},(incoming?r.inviter.displayName+' 邀请你': '你邀请 '+r.target.displayName)+' · '+({pending:'待接受',accepted:'已加入',rejected:'已拒绝',revoked:'已撤销',expired:'已过期'})[r.state]),el('small',{},'有效期至 '+new Date(r.expiresAt).toLocaleString()),el('div',{class:'person-actions'},buttons));
    }));if(!data.items.length)content.append(el('p',{class:'quiet-empty'},'没有待处理的群邀请。'));
   }
  }
  form.onsubmit=e=>{e.preventDefault();currentQuery=query.value.trim();if(currentQuery.length<2){showStatus(status,'请至少输入两个字符。','error');return;}perform(search,status,load);};
  openModal('星光之间 · 好友',tabs,tab==='search'&&form,status,content);redraw=load;await load().catch(e=>showStatus(status,e.message,'error'));
 }
 async function profile(present){
  const p=(await request('/api/chat/profile')).item;let version=p.version,avatarId=p.avatarId,selected,preview,keyForUpload=crypto.randomUUID();
  const display=text('显示名称',p.displayName,40),status=el('p',{class:'inline-status',role:'status'}),state=el('select',{'aria-label':'在线状态'},Object.entries(statuses).map(([v,l])=>el('option',{value:v,selected:v===p.preferredStatus},l)));
  const picture=el('div',{class:'profile-preview'},personAvatar(p,72)),picker=el('input',{type:'file',accept:'.png,.jpg,.jpeg,.webp',hidden:true,'aria-label':'选择头像图片'}),choose=action('选择头像','photo'),progress=el('div',{class:'social-upload-progress',role:'status'});
  choose.onclick=()=>picker.click();picker.onchange=()=>{const file=picker.files[0];if(!file)return;if(file.size>8*1024*1024){showStatus(status,'头像最大8MiB。','error');return;}if(preview)URL.revokeObjectURL(preview);selected=file;avatarId=null;keyForUpload=crypto.randomUUID();preview=URL.createObjectURL(file);picture.replaceChildren(image(preview,'头像本地预览',{width:72,height:72,class:'account-avatar'}));};
  const save=action('保存修改','check',{type:'submit',class:'button button-primary'}),form=el('form',{},el('div',{class:'profile-upload'},picture,choose,picker),field('显示名称',display),field('在线状态',state),el('p',{class:'hint'},'账号 '+p.username+' · 稳定ID '+p.id),el('p',{class:'hint'},'隐身对其他人显示为离线；修改名称不会改变历史消息的归属。'),progress,status,save);
  form.onsubmit=e=>{e.preventDefault();perform(save,status,async()=>{if(selected&&!avatarId){const uploaded=await uploadAvatar(selected,keyForUpload,(loaded,total,saving)=>{const n=Math.floor(loaded/total*100);progress.replaceChildren(el('span',{},saving?'正在保存头像…':`头像上传 ${n}%`),el('progress',{value:n,max:100,'aria-label':'头像上传进度'}));});avatarId=uploaded.id;}
   const result=await request('/api/chat/profile',{method:'PATCH',json:{version,displayName:display.value,status:state.value,avatarId},key:crypto.randomUUID()});version=result.item.version;onProfile(result.item);showStatus(status,'资料已保存，好友与群成员会同步看到。','success');await refresh();});};
  const copy=action('复制用户ID');copy.onclick=()=>navigator.clipboard.writeText(p.id).then(()=>toast('用户ID已复制')).catch(()=>toast(p.id));
  present('个人资料',form,copy);
 }
 async function groupMembers(){
  const group=currentThread();if(!group)return;const list=el('div',{class:'social-dynamic-list'}),status=el('p',{class:'inline-status',role:'status'}),query=text('邀请用户的ID或账号','',80),search=action('查找用户',undefined,{type:'submit'}),results=el('div'),form=el('form',{class:'user-search'},field('邀请用户的ID或账号',query),search),ai=action('邀请AI入群','sparkle');
  async function load(){const value=await request('/api/chat/threads/'+group.id);list.replaceChildren(...value.item.members.map(p=>{const buttons=[];
    if(p.kind==='ai'){const remove=action('移除AI');remove.onclick=()=>perform(remove,status,async()=>{await request('/api/chat/threads/'+group.id+'/ai/'+p.aiId,{method:'DELETE'});await load();await refresh();});buttons.push(remove);}
    else if(group.owner===key()&&p.key!==key()){const remove=action('移出群聊');remove.onclick=()=>perform(remove,status,async()=>{await request('/api/chat/threads/'+group.id+'/members',{method:'PUT',json:{members:value.item.members.filter(u=>u.kind!=='ai'&&u.key!==p.key).map(u=>u.key)}});await load();await refresh();});buttons.push(remove);}
    return personRow({...p,username:p.kind==='ai'?'AI成员 · '+p.personaId:p.username},buttons);
   }));}
  form.onsubmit=e=>{e.preventDefault();perform(search,status,async()=>{const value=await request('/api/chat/users?q='+encodeURIComponent(query.value.trim()));results.replaceChildren(...value.items.filter(p=>p.key!==key()).map(p=>{const invite=action('发送群邀请');invite.onclick=()=>perform(invite,status,async()=>{const v=await request('/api/chat/threads/'+group.id+'/invitations',{method:'POST',json:{target:p.key},key:crypto.randomUUID()});invite.textContent=v.item.joined?'已在群内':'邀请已发送';});return personRow(p,invite);}));});};
  ai.onclick=()=>aiHub(group.id);(openDetails||openModal)('群聊成员与邀请',el('p',{},'收到邀请并接受后即可加入。当前群成员都可以发出邀请。'),list,form,results,status,ai);redraw=load;await load().catch(e=>showStatus(status,e.message,'error'));
 }
 async function aiHub(threadId=null){
  const status=el('p',{class:'inline-status',role:'status'}),list=el('div',{class:'social-dynamic-list'}),buttons=el('div',{class:'social-tabs'}),reloadButton=action('从服务器刷新','sparkle');buttons.append(reloadButton);
  const creationKeys = new Map();
  let choosing = false;
  if(account().role==='admin'){const manage=action('管理服务器人格');manage.onclick=()=>personaList();buttons.append(manage);}
  async function load(){const value=await request('/api/chat/ai');showStatus(status,value.connected?'已连接 AstrBot · 人格以服务器为准':(value.error||'服务器不可达，显示上次缓存'),value.connected?'success':'error');
   list.replaceChildren(...value.items.map(p=>{const use=action(threadId?(currentThread()?.kind==='ai'?'选择这位AI':'邀请入群'):'与这位AI聊天');use.disabled=!value.connected||!p.enabled;
    use.onclick=()=>perform(use,status,async()=>{
     if(choosing)return;
     choosing=true;
     const stamp=routeStamp();
     try {
      let id=threadId;
      if(id)await request('/api/chat/threads/'+id+'/ai',{method:'POST',json:{aiId:p.id}});
      else {
       if(!creationKeys.has(p.id))creationKeys.set(p.id,crypto.randomUUID());
       const t=await request('/api/chat/threads',{method:'POST',json:{kind:'ai',title:p.name,aiId:p.id},key:creationKeys.get(p.id)});
       id=t.item.id;
      }
      if(stamp===routeStamp()&&dialog.open&&dialog.contains(list)){dialog.close();await openThread(id);}
     } finally {choosing=false;}
    });
    const edit=account().role==='admin'&&action('编辑人格');if(edit)edit.onclick=()=>editPersona(p.personaId);
    return personRow({...p,displayName:p.name,username:(p.enabled?'AI · ':'已停用 · ')+p.personaId,status:p.enabled?'online':'offline'},use,edit);
   }));if(!value.items.length)list.append(el('p',{class:'quiet-empty'},'服务器暂时没有可使用的AI人格。管理员可新建或导入角色卡。'));}
  reloadButton.onclick=()=>perform(reloadButton,status,load);openModal('AI成员 · 服务器人格',buttons,status,list);redraw=load;await load().catch(e=>showStatus(status,e.message,'error'));
 }
 async function personaList(present){
  const status=el('p',{class:'inline-status',role:'status'}),list=el('div'),drafts=el('div');
  const create=action('新建人格','plus'),imports=action('导入角色卡','upload'),reload=action('从服务器刷新');
  create.onclick=()=>editPersona();imports.onclick=()=>importCard();
  const show=present||((title,...children)=>openPage('personas',title,...children));
  show('AI 人格／角色卡',el('p',{class:'muted'},'写入后回读 AstrBot 服务器版本，确认人格已同步。'),
   el('div',{class:'form-actions'},create,imports,reload),status,list,drafts);
  async function load(){
   showStatus(status,'正在读取服务器人格…');
   const [remote,local]=await Promise.allSettled([request('/api/chat/admin/personas'),request('/api/chat/admin/personas/drafts')]);
   if(remote.status==='fulfilled'){
    showStatus(status,'');
    list.replaceChildren(...remote.value.items.map(p=>{
     const edit=action('编辑人格');edit.onclick=()=>editPersona(p.id);
     return personRow({...p,displayName:p.name,username:p.enabled?'服务器人格':'已停用'},edit);
    }));
    if(!remote.value.items.length) list.append(el('p',{class:'quiet-empty'},'服务器暂时没有可用人格。'));
   } else showStatus(status,remote.reason.message,'error');
   if(local.status==='fulfilled'){
    drafts.replaceChildren(...local.value.items.map(d=>{
     const importing=Boolean(d.document.card||d.document.png);
     const resume=action(importing?'继续导入角色卡':'继续编辑待提交草稿');
     resume.onclick=()=>importing?importCard(d.document):editPersona(d.document.version?d.id:null,d.document);
     return el('div',{class:'invite-card'},el('strong',{},d.id==='__import__'?'角色卡导入':d.id),
      el('small',{},'待确认同步 · '+new Date(d.updatedAt).toLocaleString()),resume);
    }));
   } else drafts.replaceChildren(el('p',{class:'hint'},'待提交草稿暂未读取，可刷新重试。'));
  }
  reload.onclick=()=>perform(reload,status,load);
  await load();
 }
 async function editPersona(id=null,draft=null){
  let original=draft||{id:'',name:'',description:'',systemPrompt:'',beginDialogs:[],firstMessage:'',exampleDialogue:'',extensions:{},enabled:true,version:null};
  const loading=el('p',{class:'inline-status',role:'status'},'正在读取服务器人格…');
  if(id&&!draft){
   const back=action('返回人格列表','back');back.onclick=()=>personaList();
   openPage('personas','读取人格',loading,back);
   const stamp=routeStamp();
   try{original=(await request('/api/chat/admin/personas/'+encodeURIComponent(id))).item;}
   catch(e){showStatus(loading,e.message,'error');return;}
   if(stamp!==routeStamp())return;
  }
  const ident=text('人格ID',original.id,120);ident.readOnly=!!id;const title=text('人格名称',original.name,80),description=area('人格说明',original.description,3000),prompt=area('系统设定',original.systemPrompt,60000),greeting=area('开场内容',original.firstMessage,6000),examples=area('示例对话',original.exampleDialogue,16000),enabled=el('input',{type:'checkbox',checked:original.enabled!==false,'aria-label':'允许使用此AI'}),pairs=el('div',{class:'persona-pairs'}),pairInputs=[];
  function addPair(user='',assistant=''){const a=area('用户示例',user,12000),b=area('AI示例',assistant,12000),row=el('div',{class:'persona-pair'},field('用户',a),field('AI',b)),remove=action('移除此轮');const record={a,b,row};remove.onclick=()=>{pairInputs.splice(pairInputs.indexOf(record),1);row.remove();};pairInputs.push(record);row.append(remove);pairs.append(row);}
  for(let i=0;i<(original.beginDialogs||[]).length;i+=2)addPair(original.beginDialogs[i],original.beginDialogs[i+1]);const add=action('添加一轮预设对话','plus');add.onclick=()=>addPair();
  let avatarFile,removeAvatar=false,avatarPreview;const avatarPicture=el('div',{class:'profile-preview'});const showAvatar=()=>avatarPicture.replaceChildren(...(original.avatar&&id?[image('/api/chat/admin/personas/'+encodeURIComponent(id)+'/avatar?v='+encodeURIComponent(original.version),'服务器角色图片',{width:96,height:96,class:'account-avatar'})]:[]));showAvatar();const avatarPicker=el('input',{type:'file',accept:'.png',hidden:true,'aria-label':'选择AI角色图片'}),avatarChoose=action('选择角色PNG图片','photo'),avatarRemove=action('移除角色图'),avatarNote=el('p',{class:'hint'},original.avatar?'已保存服务器角色图':'尚未设置角色图');avatarChoose.onclick=()=>avatarPicker.click();avatarPicker.onchange=()=>{avatarFile=avatarPicker.files[0];removeAvatar=false;if(avatarPreview)URL.revokeObjectURL(avatarPreview);avatarNote.textContent=avatarFile?avatarFile.name+' · 本地待保存':'未选择';if(avatarFile){avatarPreview=URL.createObjectURL(avatarFile);avatarPicture.replaceChildren(image(avatarPreview,'角色图片本地预览',{width:96,height:96,class:'account-avatar'}));}else showAvatar();};avatarRemove.onclick=()=>{avatarFile=null;removeAvatar=true;avatarPicture.replaceChildren();avatarNote.textContent='待移除角色图';};
  const status=el('p',{class:'inline-status',role:'status'}),save=action('保存并同步到 AstrBot','check',{type:'submit',class:'button button-primary'}),version=el('p',{class:'hint'},original.version?'服务器版本 '+original.version.slice(0,16):'新建人格 · 尚未同步'),reloadButton=action('对照服务器版本');
  const comparison=el('div',{class:'persona-comparison'});
  let operation=original.operationKey||crypto.randomUUID();
  const changeOperation=()=>{operation=crypto.randomUUID();};
  reloadButton.hidden=!id;
  reloadButton.onclick=()=>perform(reloadButton,status,async()=>{
   const latest=(await request('/api/chat/admin/personas/'+encodeURIComponent(id))).item;
   if(latest.version===original.version){showStatus(status,'服务器版本未变化，编辑内容已保留。');return;}
   const adopt=action('用此服务器版本继续编辑');
   adopt.onclick=()=>{
    original={...original,version:latest.version};
    version.textContent='保存依据 '+latest.version.slice(0,16);
    comparison.replaceChildren();
    changeOperation();
    showStatus(status,'已更新保存依据。请合并需要保留的字段，再确认同步。');
   };
   comparison.replaceChildren(el('details',{open:true},el('summary',{},'服务器当前版本 '+latest.version.slice(0,16)),
    el('pre',{},[latest.name,latest.description,latest.systemPrompt,latest.firstMessage,latest.exampleDialogue,(latest.beginDialogs||[]).join('\n')].filter(Boolean).join('\n\n')),adopt));
   showStatus(status,'保留了当前编辑。保存前请核对两边的内容。');
  });
  const back=action('返回人格列表','back');back.onclick=()=>personaList();const form=el('form',{},back,field('人格ID（创建后固定）',ident),field('人格名称',title),field('人格说明',description),field('系统设定',prompt),field('开场内容',greeting),field('示例对话',examples),el('h3',{},'模型预设对话'),pairs,add,avatarPicture,el('div',{class:'social-tabs'},avatarChoose,avatarRemove),avatarPicker,avatarNote,el('label',{class:'contact-choice'},enabled,'允许使用此AI'),version,status,comparison,el('div',{class:'dialog-footer'},reloadButton,save));
  form.addEventListener('input',changeOperation);
  avatarRemove.addEventListener('click',changeOperation);
  add.addEventListener('click',changeOperation);
  pairs.addEventListener('click',event=>{if(event.target.closest('button'))changeOperation();});
  form.onsubmit=e=>{e.preventDefault();perform(save,status,async()=>{const document={...original,id:ident.value.trim(),name:title.value,description:description.value,systemPrompt:prompt.value,firstMessage:greeting.value,exampleDialogue:examples.value,beginDialogs:pairInputs.flatMap(p=>[p.a.value,p.b.value]),enabled:enabled.checked};
   delete document.operationKey;
   if(avatarFile){if(avatarFile.size>8*1024*1024)throw Error('角色图片最大8MiB。');const bytes=new Uint8Array(await avatarFile.arrayBuffer());let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));document.avatarPng=btoa(binary);}if(removeAvatar)document.removeAvatar=true;
   showStatus(status,'正在写入并回读 AstrBot…');
   const result=await request('/api/chat/admin/personas'+(id?'/'+encodeURIComponent(id):''),{method:id?'PUT':'POST',json:document,key:operation});original=result.item;changeOperation();id=original.id;ident.readOnly=true;reloadButton.hidden=false;avatarFile=null;removeAvatar=false;if(avatarPreview)URL.revokeObjectURL(avatarPreview);showAvatar();comparison.replaceChildren();avatarNote.textContent=original.avatar?'已保存服务器角色图':'尚未设置角色图';version.textContent='服务器版本 '+original.version.slice(0,16)+' · 已同步';
   showStatus(status,result.agentsRefreshed===false?'已写入 AstrBot 并回读确认。AI 列表将在连接恢复后刷新。':'已写入 AstrBot 并回读确认，使用此人格的AI会获取新版本。','success');});};
  openPage('personas','编辑 AI 人格／角色卡',form);redraw=null;
 }
 function importCard(pending){
  const file=el('input',{type:'file',accept:'.json,.png','aria-label':'选择角色卡',hidden:true}),choose=action('选择JSON或PNG角色卡','upload'),id=text('新人格ID（可选）',pending?.id||'',120),note=el('p',{class:'hint'},pending?'已恢复待同步角色卡。':'尚未选择文件。'),status=el('p',{class:'inline-status',role:'status'}),send=action('导入并同步到 AstrBot','check',{class:'button button-primary'});
  let selected,keyValue=pending?.operationKey||crypto.randomUUID();
  choose.onclick=()=>file.click();
  file.onchange=()=>{
   if(!file.files[0])return;
   selected=file.files[0];pending=null;keyValue=crypto.randomUUID();
   note.textContent=selected.name+' · 尚未上传';
  };
  id.oninput=()=>{keyValue=crypto.randomUUID();};
  send.onclick=()=>perform(send,status,async()=>{
   const stamp=routeStamp();
   if(!selected&&!pending)throw Error('请先选择角色卡。');
   if(selected?.size>8*1024*1024)throw Error('角色卡最大 8 MiB。');
   let payload;
   if(pending)payload=pending.card?{card:pending.card}:{png:pending.png};
   else if(selected.name.toLowerCase().endsWith('.json')){
    if(selected.size>1024*1024)throw Error('JSON 角色卡最大 1 MiB。');
    try{payload={card:JSON.parse(await selected.text())};}catch{throw Error('角色卡内容不是有效 JSON。');}
   } else {
    const bytes=new Uint8Array(await selected.arrayBuffer());let binary='';
    for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));
    payload={png:btoa(binary)};
   }
   if(id.value.trim())payload.id=id.value.trim();
   showStatus(status,'正在导入并回读 AstrBot…');
   const result=await request('/api/chat/admin/personas/import',{method:'POST',json:payload,key:keyValue});
   showStatus(status,'角色卡已写入服务器并回读确认。','success');
   if(stamp===routeStamp()){toast(status.textContent);void editPersona(result.item.id,result.item);}
  });
  const back=action('返回人格列表','back');back.onclick=()=>personaList();
  openPage('personas','导入服务器角色卡',back,el('p',{class:'muted'},'支持 AstrBot 人格 JSON 和 Character Card v2/v3 的 JSON、PNG。'),choose,file,note,field('新人格ID（可选）',id),status,send);
  redraw=null;
 }
 async function memories(present){const list=el('div'),status=el('p',{class:'inline-status',role:'status'}),body=area('新的个人记忆','',600),scope=el('select',{'aria-label':'记忆共享范围'},el('option',{value:'private'},'仅AI私聊'),el('option',{value:'shared'},'允许在参加的群中共享')),save=action('保存记忆','check',{type:'submit'}),form=el('form',{},field('新的个人记忆',body),field('共享范围',scope),save);
  async function load(){const v=await request('/api/chat/memories');list.replaceChildren(...v.items.map(m=>{const sharing=el('select',{'aria-label':'共享范围 '+m.id},...['private','group','shared'].map(v=>el('option',{value:v,selected:v===m.scope,disabled:v==='group'&&!m.threadId},({private:'仅本人AI私聊',group:'仅来源群',shared:'允许跨群共享'})[v]))),change=action('保存授权'),remove=action(m.revoked?'恢复记忆':'撤销记忆');
   change.onclick=()=>perform(change,status,async()=>{await request('/api/chat/memories/'+m.id,{method:'PATCH',json:{version:m.version,scope:sharing.value}});await load();});remove.onclick=()=>perform(remove,status,async()=>{await request('/api/chat/memories/'+m.id,{method:'PATCH',json:{version:m.version,revoked:!m.revoked}});await load();});
   return el('article',{class:'invite-card'},el('p',{},m.body),el('small',{},(m.revoked?'已撤销 · ':'')+'来源消息 '+(m.sourceMessageId||'本人填写')+' · '+(m.threadId?'群 '+m.threadId:'个人会话')),sharing,el('div',{class:'person-actions'},change,remove));}));}
  form.onsubmit=e=>{e.preventDefault();perform(save,status,async()=>{await request('/api/chat/memories',{method:'POST',json:{body:body.value,scope:scope.value},key:crypto.randomUUID()});body.value='';await load();});};present('记忆与共享授权',el('p',{},'群记忆默认仅用于来源群。你允许共享的个人记忆可在你参加的其他群中召回。'),form,status,list);await load().catch(e=>showStatus(status,e.message,'error'));
 }
 async function settings(section,present){
  if(section==='notifications')await loadPrefs();
  const items={};for(const [key,label]of [['sound','消息提示音'],['taskbar','任务栏未读提醒'],['desktop','系统消息通知']])items[key]=el('input',{type:'checkbox',checked:preferences[key],'aria-label':label});
  const native=section==='close'?await window.hoshifuruDesktop?.getPreferences?.():null;
  const close=el('select',{'aria-label':'关闭窗口时'},...Object.entries({ask:'每次询问',background:'后台运行',exit:'退出软件'}).map(([v,l])=>el('option',{value:v,selected:v===(native?.closeAction||'ask')},l)));
  const density=el('select',{'aria-label':'界面密度'},el('option',{value:'comfortable'},'舒适'),el('option',{value:'compact'},'紧凑'));density.value=localStorage.getItem('tsukiakari-density')||'comfortable';
  const status=el('p',{class:'inline-status',role:'status'}),save=action('保存修改','check',{class:'button button-primary'});save.onclick=()=>perform(save,status,async()=>{if(section==='notifications'){const desired=Object.fromEntries(Object.entries(items).map(([k,v])=>[k,v.checked]));preferences=(await request('/api/chat/preferences',{method:'PATCH',json:desired})).item;updateBadge([],lastBadge?.count||0);}if(section==='close'&&native)await window.hoshifuruDesktop.setPreferences({closeAction:close.value});if(section==='appearance'){localStorage.setItem('tsukiakari-density',density.value);document.documentElement.dataset.density=density.value;}showStatus(status,'偏好已保存。','success');});
  const content=section==='appearance'?[motionChoice(),field('界面密度',density),el('p',{class:'hint'},'动效遵循系统减少动态效果选项。正文保持易读字号。')]:section==='close'?[native?field('关闭窗口时',close):el('p',{},'此项在桌面软件中可设置。'),el('p',{class:'hint'},'后台运行保留消息连接和托盘。可从托盘重新打开窗口或明确退出。')]:[...Object.entries(items).map(([k,v])=>el('label',{class:'contact-choice'},v,({sound:'消息提示音',taskbar:'任务栏未读提醒',desktop:'系统消息通知'})[k])),el('p',{class:'hint'},'默认提醒非当前前台会话的新消息，并遵循系统通知权限与勿扰状态。歌曲和消息音频由你主动播放。')];
  present(({appearance:'外观',close:'关闭窗口',notifications:'消息通知'})[section],...content,status,save);
 }
 async function notifyMessage(value){if(!noticeReady||!account()||value.item.status!=='complete'||value.item.senderKey===key())return;
  const foreground=document.hasFocus()&&!document.documentElement.classList.contains('page-hidden')&&currentThread()?.id===value.threadId&&document.querySelector('#chat-view')?.hidden===false;if(foreground)return;
  const owner=account().csrf;
  try{const r=await request('/api/chat/notifications/claim',{method:'POST',json:{messageId:value.item.id}});if(!r.notify||owner!==account()?.csrf)return;preferences=r.preferences||preferences;if(window.hoshifuruDesktop?.notify)await window.hoshifuruDesktop.notify({...r.item,preferences,accountKey:key()});else if(preferences.sound)playSound();}catch{}
 }
 function playSound(){try{const a=new Audio('/assets/message.wav');a.volume=.35;void a.play().catch(()=>{});}catch{}}
 function updateBadge(items,total){
  const unread=Number.isFinite(total)?total:items.reduce((n,t)=>n+t.unread,0);
  const next={accountKey:key(),count:unread,taskbar:preferences.taskbar};
  if(lastBadge?.accountKey===next.accountKey&&lastBadge.count===next.count&&lastBadge.taskbar===next.taskbar)return;
  lastBadge=next;
  window.hoshifuruDesktop?.setUnread?.(next);
 }
 function start(){clearInterval(heartbeat);noticeReady=false;void loadPrefs().catch(()=>{});heartbeat=setInterval(()=>{if(account())void request('/api/chat/presence/heartbeat',{method:'POST'}).catch(()=>{});},20000);}
 function stop(){clearInterval(heartbeat);clearTimeout(surfaceTimer);surfaceTimer=null;redraw=null;noticeReady=false;lastBadge=null;window.hoshifuruDesktop?.setUnread?.({count:0});}
  function connected(value=true){noticeReady=value;}
 return{friends,profile,groupMembers,aiHub,personaList,memories,settings,reloadSurface,start,stop,connected,notifyMessage,updateBadge};
}

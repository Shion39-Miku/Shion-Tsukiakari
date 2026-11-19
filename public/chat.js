import { action, api, data, el, icon, iconButton, image, motionChoice, showStatus, site, toast, updateSite } from './ui.js';
import * as player from './player.js';
import { createLibrary, sectionNames } from './chat-library.js';
import { messageView } from './chat-render.js';
import { trackRoute } from './activity.js';
import { createSocialUI,personAvatar } from './chat-social.js';
import {createPages,personalSections,managementSections} from './chat-pages.js';

const name = '月明かり';
document.title = name;
const shell = document.querySelector('#app-shell'), loginStage = document.querySelector('#app-login');
const sidebar = document.querySelector('#app-sidebar'), header = document.querySelector('#app-header');
const conversation = document.querySelector('#conversation'), list = document.querySelector('#message-list'), composer = document.querySelector('#composer');
const dialog = document.querySelector('#app-dialog');
const panels = Object.fromEntries(['chat', 'library', 'manage', 'accounts','settings','software'].map((key) => [key, document.querySelector('#' + key + '-view')]));
let session, threads = [], activeThread, view = 'chat', section = 'music', source, updates;
let textarea, sendButton, fileInput, fileList, progress, composerStatus, mention;
let selectedFiles = [], sending = false, sendKey = crypto.randomUUID(), threadPage = null, before = null;
let routeVersion = 0, refreshTimer, readTimer, scrollFrame, adminModule, adminOwner, connected = false;
let pendingThreadId;
let activeSendTicket;
const messageNodes = new Map(), pendingMessages = new Map(), inputDrafts = new Map(), uploadCache = new WeakMap();
let installPrompt;
let syncingNotices = false;
const seenNotices = new Set();
let pageSection='profile',threadKind='all',threadQuery='',sidebarAccount;const scrollPositions=new Map();const details=document.querySelector('#conversation-details');
try{document.documentElement.dataset.density=localStorage.getItem('tsukiakari-density')||'comfortable';}catch{}

async function request(path, options = {}) {
  const requestingAccount = session?.key;
  const { json, key, ...rest } = options;
  const response = await fetch(path, { ...rest, cache: 'no-store', headers: {
    ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}),
    ...(session?.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...rest.headers,
  }, body: json === undefined ? rest.body : JSON.stringify(json) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.endsWith('/login') && session && session.key === requestingAccount) showLogin();
    const error = new Error(result.error?.message || '连接暂时未完成，请稍后重试。'); error.status = response.status; throw error;
  }
  return result;
}
const library = createLibrary({ root: panels.library, request, account: () => session, changeSection: (next) => navigate('library', { section: next }) });
const socialUI=createSocialUI({request,account:()=>session,dialog,openModal,openPage,openDetails,hasOpenSurface:()=>!details.hidden,currentThread:()=>activeThread,
 refresh:async()=>{await loadThreads();if(activeThread&&view==='chat')await loadThread(activeThread.id,{background:true});},
 onProfile:(profile)=>{if(session)session.profile=profile;drawSidebar();},openThread:(id)=>navigate('chat',{threadId:id}),
 uploadAvatar:(file,key,onProgress)=>xhrUpload({file,kind:'image'},key,onProgress,session)});

const pages=createPages({request,account:()=>session,navigate,social:()=>socialUI,showAccounts,openModal});
function openPage(section,title,...children){if(dialog.open)dialog.close();details.hidden=true;return navigate(['personas'].includes(section)?'software':'settings',{section,surface:{title,children}});}
function openDetails(title,...children){const close=iconButton('close','关闭会话详情');close.onclick=()=>details.hidden=true;details.replaceChildren(el('header',{class:'details-heading'},el('h2',{},title),close),...children.flat(Infinity).filter(v=>v!==false&&v!=null));details.hidden=false;close.focus();}
addEventListener('keydown',e=>{if(e.key==='Escape'&&!dialog.open&&!details.hidden){details.hidden=true;header.querySelector('[aria-label="查看群成员"]')?.focus();}});
function appBrand() {
  return el('div', { class: 'app-brand' }, image('/assets/brand/tsukiakari-192.png', '', { width: 41, height: 41, loading: 'eager' }),
    el('div', {}, el('strong', {}, name), el('small', {}, 'TSUKIAKARI')));
}
function avatar(username) { return el('span', { class: 'account-avatar', 'aria-hidden': true }, username.slice(0, 1).toUpperCase()); }
function closeSidebar() { document.body.classList.remove('sidebar-open'); sidebar.inert = matchMedia('(max-width:760px)').matches; document.querySelector('#sidebar-shade').hidden = true; header.querySelector('.mobile-menu')?.setAttribute('aria-expanded', 'false'); }
document.querySelector('#sidebar-shade').onclick = closeSidebar;
function openModal(title, ...children) {
  dialog.classList.remove('wide-dialog');
  const close = iconButton('close', '关闭对话框'); close.onclick = () => dialog.close();
  dialog.replaceChildren(el('div', { class: 'app-dialog-content' }, el('header', { class: 'app-dialog-heading' }, el('h2', { id: 'app-dialog-title' }, title), close), children));
  if (!dialog.open) dialog.showModal();
}
function confirmModal(title, description, label, work, extra) {
  const cancel = action('取消'); cancel.onclick = () => dialog.close();
  const confirm = action(label, 'check', { class: 'button button-primary' });
  const status = el('p', { class: 'inline-status', role: 'status' });
  confirm.onclick = async () => { confirm.disabled = true; try { await work(); dialog.close(); } catch (error) { showStatus(status, error.message, 'error'); } finally { confirm.disabled = false; } };
  openModal(title, el('p', {}, description), extra, status, el('footer', { class: 'dialog-footer' }, cancel, confirm));
}

function showLogin() {
  pages.reset();sidebarAccount=null;document.querySelector('#app-rail').replaceChildren();details.hidden=true;socialUI.stop();if(dialog.open)dialog.close();dialog.replaceChildren();
  source?.close(); updates?.close(); source = updates = null; connected = false;
  session = null; activeThread = null; threads = []; messageNodes.clear(); pendingMessages.clear(); inputDrafts.clear();
  routeVersion++; pendingThreadId = null; activeSendTicket = null; sending = false;
  seenNotices.clear(); syncingNotices = false;
  list.replaceChildren(); panels.accounts.replaceChildren(); adminModule?.unmountAdmin();
  shell.hidden = true; loginStage.hidden = false; closeSidebar(); player.stop(); player.setBackground(null);
  selectedFiles.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)); selectedFiles = [];
  document.querySelector('#manage-main').replaceChildren(); adminOwner = null; library.reset();
  const username = el('input', { name: 'username', autocomplete: 'username', required: true, maxlength: 40, placeholder: '你的账号', 'aria-label': '账号' });
  const password = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 128, placeholder: '账号密码', 'aria-label': '密码' });
  const submit = action('登录', 'lock', { type: 'submit', class: 'button button-primary' });
  const status = el('p', { class: 'inline-status', role: 'status' });
  const form = el('form', { class: 'app-login-form' }, appBrand(), el('h1', {}, '今夜，也在这里相见。'), el('p', {}, '登录后，回到属于你的聊天与收藏。'),
    el('label', { class: 'field' }, el('span', {}, '账号'), username), el('label', { class: 'field' }, el('span', {}, '密码'), password), submit, status,
    el('div', { class: 'app-login-note' }, '普通账号由站长开通 · 管理员使用现有网站账号', el('br'), el('a', { href: '/' }, '逛逛詩音の月光庭院')));
  form.onsubmit = async (event) => {
    event.preventDefault(); submit.disabled = true; showStatus(status, '正在核验账号…');
    try { await request('/api/chat/login', { method: 'POST', json: { username: username.value.trim(), password: password.value } }); password.value = ''; await enter(); }
    catch (error) { showStatus(status, error.message, 'error'); } finally { submit.disabled = false; }
  };
  request('/api/chat/bootstrap').then(v=>{if(v.available){form.querySelector('h1').textContent='为月明かり点亮第一盏灯。';form.querySelector('p').textContent='创建本机管理员，账号与密码由你设置。';submit.textContent='创建管理员';form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{await request('/api/chat/bootstrap',{method:'POST',json:{username:username.value.trim(),password:password.value}});await request('/api/chat/login',{method:'POST',json:{username:username.value.trim(),password:password.value}});password.value='';await enter();}catch(error){showStatus(status,error.message,'error');}finally{submit.disabled=false;}};}}).catch(()=>{});
  loginStage.replaceChildren(el('div', { class: 'app-login-art' }, image(site.heroImage, '', { loading: 'eager' }),
    el('div', { class: 'app-login-caption' }, el('p', { class: 'eyebrow' }, 'UNDER THE SAME MOON'), el('h2', {}, '星が降る夜、\nあなたと。'), el('p', {}, site.motto))), el('div', { class: 'app-login-form-wrap' }, form));
}

function drawRail(){
 const rail=document.querySelector('#app-rail');const brand=el('button',{class:'rail-brand',type:'button','aria-label':'月明かり · 返回聊天',title:'月明かり'},image('/assets/brand/tsukiakari-64.png','',{width:38,height:38}));brand.onclick=()=>navigate('chat');
 const nav=el('nav',{class:'app-nav','aria-label':'应用功能'});for(const[key,label,glyph]of[['chat','聊天','mail'],['library','月光庭院','moon'],...(session.role==='admin'?[['manage','网站管理','photo'],['software','软件管理','lock']]:[])]){const v=el('button',{type:'button',class:'rail-button','aria-label':label,title:label,'aria-current':view===key?'page':null},icon(glyph));v.onclick=()=>navigate(key);nav.append(v);}
 const settings=el('button',{type:'button',class:'rail-button','aria-label':'个人设置',title:'个人设置','aria-current':view==='settings'?'page':null},icon('sparkle'));settings.onclick=()=>navigate('settings',{section:'profile'});
 const profile=el('button',{type:'button',class:'rail-button rail-avatar','aria-label':'编辑个人资料',title:session.profile?.displayName||session.username},personAvatar(session.profile||{username:session.username}));profile.onclick=()=>navigate('settings',{section:'profile'});
 const logout=el('button',{class:'rail-button',type:'button','aria-label':'退出登录',title:'退出登录'},icon('back'));logout.onclick=()=>confirmModal('退出登录','聊天记录已保存，下次登录可继续。','退出登录',async()=>{await request('/api/chat/logout',{method:'POST'});showLogin();});
 rail.replaceChildren(brand,nav,el('span',{class:'rail-spacer'}),settings,profile,logout);
}
function newConversation(){const choices=el('div',{class:'new-conversation-choices'});for(const[k,title,note,glyph]of[['ai','AI 对话','选择服务器上的人格，开始一段独立对话。','sparkle'],['direct','好友私聊','与已添加的好友说说近况。','mail'],['group','创建群聊','邀请同行的人，也可以邀请 AI。','heart']]){const b=action('',glyph,{'aria-label':title});b.append(el('span',{},title,el('small',{},note)));b.onclick=()=>{dialog.close();if(k==='ai'){if(session.astrbotConfigured)socialUI.aiHub();else newAiThread();}else contactDialog(k);};choices.append(b);}openModal('新建会话',choices);}
function drawSidebar(){
 if(!session)return;drawRail();
 if(sidebarAccount!==session.key){sidebarAccount=session.key;try{threadKind=localStorage.getItem('tsukiakari-thread-kind:'+session.key)||'all';}catch{}const add=iconButton('plus','新建会话');add.onclick=newConversation;const search=el('input',{class:'thread-search','aria-label':'筛选会话',placeholder:'搜索会话…',value:threadQuery});search.oninput=()=>{threadQuery=search.value;drawThreadList();};
 const filters=el('div',{class:'conversation-filters','aria-label':'会话类型'});for(const[key,title]of[['all','全部'],['ai','AI'],['direct','好友'],['group','群聊']]){const button=action(title,undefined,{'aria-pressed':String(threadKind===key)});button.dataset.kind=key;button.onclick=()=>{threadKind=key;try{localStorage.setItem('tsukiakari-thread-kind:'+session.key,key);}catch{}drawThreadList();};filters.append(button);}
 const people=action('通讯录','heart');people.onclick=()=>socialUI.friends();const invites=action('申请与邀请','mail');invites.onclick=()=>socialUI.friends('invitations');sidebar.replaceChildren(el('div',{class:'conversation-heading'},el('div',{},el('strong',{},'月明かり'),el('small',{},'Tsukiakari')),add),search,filters,el('div',{class:'thread-list','aria-label':'会话列表'}),el('footer',{class:'sidebar-footer'},people,invites));}
 drawThreadList();
}
function drawThreadList(){const container=sidebar.querySelector('.thread-list');if(!container)return;sidebar.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===threadKind)));const visible=threads.filter(t=>(threadKind==='all'||t.kind===threadKind)&&t.title.toLowerCase().includes(threadQuery.toLowerCase()));container.replaceChildren(...visible.map(t=>{const kind={ai:'AI 对话',direct:'好友',group:'群聊'}[t.kind]||'会话';const b=el('button',{class:'thread-button',type:'button',title:t.title,'aria-label':t.title},el('span',{class:'thread-kind-icon kind-'+t.kind},icon(t.kind==='ai'?'sparkle':t.kind==='group'?'heart':'mail',16)),el('span',{class:'thread-copy'},el('strong',{},t.title),el('small',{},kind)),t.unread>0&&el('span',{class:'thread-unread'},t.unread>99?'99+':t.unread));b.onclick=()=>navigate('chat',{threadId:t.id});return el('div',{class:'thread-row'+(t.id===activeThread?.id&&view==='chat'?' is-active':'')},b);}));if(!visible.length)container.append(el('p',{class:'sidebar-empty'},threadQuery?'没有匹配的会话。':'这里还很安静，开始一段新的对话吧。'));if(threadPage!==null){const more=action('载入更多会话');more.onclick=()=>loadThreads(true);container.append(more);}}
function preferences(){navigate('settings',{section:'notifications'});}
function drawHeader(){if(!session)return;
 const menu=iconButton('plus','展开导航',{class:'icon-button mobile-menu','aria-expanded':String(document.body.classList.contains('sidebar-open'))});menu.onclick=()=>{const open=document.body.classList.toggle('sidebar-open');sidebar.inert=!open;document.querySelector('#sidebar-shade').hidden=!open;};
 const t=activeThread,ai=t?.members?.find(m=>m.kind==='ai'),friend=t?.kind==='direct'?t.members.find(m=>m.key!==session.key):null,kind=t?.kind||'ai';const labels={ai:'AI',direct:'好友',group:'群聊'};
 let title=view==='chat'?(kind==='ai'?ai?.displayName||session.assistantName||'AI 对话':friend?.displayName||t?.title||'聊天'):view==='library'?sectionNames[section]:view==='manage'?'詩音の月光庭院 · 网站管理':view==='software'?'月明かり · 软件管理':'个人设置';
 const statusNames={online:'在线',away:'离开',busy:'忙碌',invisible:'离线',offline:'离线'};
 const note=view==='chat'?(kind==='group'?t.members.length+' 位成员 · 邀请制':kind==='direct'?(statusNames[friend?.status]||'离线')+' · 好友私聊':ai?.enabled===false?'人格已停用，请重新选择':connected?'已连接 · '+(t?.title||'独立 AI 对话'):'连接中断 · 正在重连'):view==='manage'?'网站内容 · 草稿保存 · 确认同步':view==='software'?(managementSections[pageSection]||'软件概览'):(personalSections[pageSection]||sectionNames[section]||'');
 const actions=el('div',{class:'app-header-actions'});if(view==='chat'&&t){if(kind==='group'){const members=iconButton('heart','查看群成员');members.onclick=groupMembers;actions.append(members);}const more=iconButton('down','会话操作');more.onclick=()=>{const controls=el('div',{class:'conversation-menu'});if(kind!=='direct'){const choose=action(kind==='group'?'邀请AI入群':'选择AI人格','sparkle');choose.onclick=()=>socialUI.aiHub(t.id);controls.append(choose);}if(t.owner===session.key&&kind!=='direct'){const rename=action('重命名对话');rename.onclick=renameThread;controls.append(rename);}const remove=action(kind==='group'?(t.owner===session.key?'解散群聊':'退出群聊'):'移除对话','trash');remove.onclick=removeThread;controls.append(remove);openModal('会话操作',controls);};actions.append(more);}
 if(view!=='chat'){const back=action('返回聊天','back',{class:'button header-back'});back.onclick=()=>navigate('chat');actions.append(back);}
 header.replaceChildren(el('div',{class:'app-header-title'},view==='chat'&&menu,el('div',{class:'app-header-copy'},el('h1',{title},title),el('small',{},view==='chat'&&el('span',{class:'header-identity kind-'+kind},labels[kind]),view==='chat'&&el('span',{class:'presence-dot'+(connected?'':' offline')}),note))),actions);
}

async function loadThreads(more = false) {
  if (!session) return;
  const owner = session.key;
  const result = await request('/api/chat/threads' + (more && threadPage !== null ? '?offset=' + threadPage : ''));
  if (session?.key !== owner) return;
  threads = more ? [...threads, ...result.items.filter((r) => !threads.some((t) => t.id === r.id))] : result.items; threadPage = result.nextOffset; drawSidebar();
  socialUI.updateBadge(threads,result.totalUnread);
}
function scheduleThreads() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => loadThreads().catch(() => {}), 180); }
function isGenerating() { return [...messageNodes.values()].some((node) => node.data.status === 'generating' && node.data.metadata?.requestedBy === session?.key); }
function scrollToBottom() { if (scrollFrame) return; scrollFrame = requestAnimationFrame(() => { scrollFrame = null; conversation.scrollTop = conversation.scrollHeight; }); }
function markRead() {
  clearTimeout(readTimer); if (!activeThread || view !== 'chat' || document.hidden || !document.hasFocus() || !session) return;
  const id = activeThread.id; readTimer = setTimeout(() => request('/api/chat/threads/' + id + '/read', { method: 'POST' }).then(scheduleThreads).catch(() => {}), 350);
}
const renderHandlers = { account: () => session, request, showSection: (section) => navigate('library', { section }), setInput: (text) => { textarea.value = text; textarea.focus(); fitInput(); }, retry: async (item) => {
  try { await request('/api/chat/threads/' + activeThread.id + '/retry', { method: 'POST', json: { messageId: item.id } }); } catch (error) { toast(error.message, 'error'); }
}, confirmAction };
function upsert(item) {
  if (!session) return;
  const previous = messageNodes.get(item.id);
  if (previous && (previous.data.updatedAt > item.updatedAt || previous.data.updatedAt === item.updatedAt && previous.data.status === 'complete' && item.status === 'generating')) return;
  if (previous) { previous.data = item; previous.view.update(item); }
  else {
    list.querySelector('.conversation-welcome')?.remove();
    const rendered = messageView(item, renderHandlers); messageNodes.set(item.id, { data: item, view: rendered });
    const next = [...list.querySelectorAll('[data-message-id]')].find((n) => Number(n.dataset.messageId) > item.id); list.insertBefore(rendered.node, next || null);
  }
  reflectComposer();
}
function queueMessage(item) {
  pendingMessages.set(item.id, item);
  if (queueMessage.frame) return;
  queueMessage.frame = requestAnimationFrame(() => {
    queueMessage.frame = null; const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 180;
    for (const value of pendingMessages.values()) upsert(value); pendingMessages.clear();
    if (nearBottom && view === 'chat') scrollToBottom(); markRead();
  });
}
function welcome() {
  const prompts = activeThread && activeThread.kind !== 'ai' ? [] : [['music', '听一首歌', '查看音乐'], ['moon', '逛逛庭院', '查看首页'], ['mail', '聊聊今天', '今天想和你聊一会儿。']];
  list.replaceChildren(el('div', { class: 'conversation-welcome' }, el('div', { class: 'welcome-symbol' }, icon(activeThread?.kind === 'group' ? 'heart' : 'sparkle', 35)),
    el('p', { class: 'eyebrow' }, 'SOMEWHERE, UNDER THE SAME STARS'), el('h2', {}, activeThread?.kind === 'direct' ? '从一句「在吗」开始。' : activeThread?.kind === 'group' ? '把相逢，留在这里。' : '今晚，想聊些什么？'),
    el('p', {}, activeThread?.kind==='ai'&&activeThread.members?.find(m=>m.kind==='ai')?.greeting || (activeThread && activeThread.kind !== 'ai' ? '消息仅对本会话成员可见。聊天记录会为你妥善保存。' : '说说今天的心情，听一首熟悉的歌，或照看月光下的庭院。')),
    el('div', { class: 'welcome-prompts' }, prompts.map(([glyph, label, value]) => { const button = action(label, glyph); button.onclick = () => { textarea.value = value; textarea.focus(); fitInput(); }; return button; }))));
}
async function loadThread(id, { older = false, background = false } = {}) {
  if (background && pendingThreadId) return;
  const version = ++routeVersion, previousId = activeThread?.id;
  if (!older && textarea) inputDrafts.set(previousId || '', textarea.value);if(previousId&&previousId!==id)scrollPositions.set(previousId,conversation.scrollTop);
  if (previousId !== id) { pendingThreadId = id; reflectComposer(); }
  let result;
  try { result = await request('/api/chat/threads/' + id + (older && before ? '?before=' + before : '')); }
  catch (error) { if (version === routeVersion) { pendingThreadId = null; reflectComposer(); } throw error; }
  if (version !== routeVersion || !session) return;
  pendingThreadId = null;
  const changed = previousId !== id, oldHeight = conversation.scrollHeight;
  activeThread = result.item; before = result.before;
  if (changed) { messageNodes.clear(); pendingMessages.clear(); list.replaceChildren(); let saved='';try{saved=localStorage.getItem('chat-input:'+session.key+':'+id)||'';}catch{} textarea.value = inputDrafts.get(id) ?? saved; clearFiles(); sendKey = crypto.randomUUID(); }
  list.querySelector('.load-older')?.remove();
  if (before) { const more = action('查看更早的消息', null, { class: 'button load-older' }); more.onclick = () => loadThread(id, { older: true }); list.prepend(more); }
  for (const item of result.messages) upsert(item);
  if (!messageNodes.size) welcome();
  drawHeader(); drawSidebar(); reflectComposer();
  if (older) requestAnimationFrame(() => { conversation.scrollTop += conversation.scrollHeight - oldHeight; });
  else if (changed) {if(scrollPositions.has(id))requestAnimationFrame(()=>conversation.scrollTop=scrollPositions.get(id));else scrollToBottom();}
  markRead();
}
async function newAiThread() {
  if (pendingThreadId) return;
  pendingThreadId = 'creating'; reflectComposer();
  try { const result = await request('/api/chat/threads', { method: 'POST', json: {}, key: crypto.randomUUID() }); await loadThreads(); await navigate('chat', { threadId: result.item.id }); }
  catch (error) { pendingThreadId = null; reflectComposer(); toast(error.message, 'error'); }
}
async function contactDialog(kind, editing = false) {
  try {
    const { items } = await request('/api/chat/contacts');
    const title = el('input', { maxlength: 80, value: editing ? activeThread.title : '', placeholder: '给这片小天地起个名字', 'aria-label': '群聊名称' });
    const selected = new Set(editing ? activeThread.members.filter((m) => m.key !== session.key).map((m) => m.key) : []);
    const options = el('div', { class: 'contact-options' }, items.map((person) => {
      const input = el('input', { type: kind === 'direct' ? 'radio' : 'checkbox', name: 'contact', value: person.key, checked: selected.has(person.key) });
      input.onchange = () => { if (kind === 'direct') selected.clear(); input.checked ? selected.add(person.key) : selected.delete(person.key); };
      return el('label', { class: 'contact-choice' }, input, personAvatar(person), el('span', {}, person.displayName,el('small',{},' · '+person.username+' · '+person.id)));
    }));
    const status = el('p', { class: 'inline-status', role: 'status' });
    const start = action(editing ? '保存成员' : kind === 'direct' ? '开始私聊' : '创建群聊', 'check', { class: 'button button-primary' });
    start.onclick = async () => { start.disabled = true; pendingThreadId = 'creating'; reflectComposer(); try {
      let id = activeThread?.id;
      if (editing) await request('/api/chat/threads/' + id + '/members', { method: 'PUT', json: { members: [...selected] } });
      else { const result = await request('/api/chat/threads', { method: 'POST', json: { kind, title: kind === 'group' ? title.value.trim() || '星夜小聚' : '私聊', members: [...selected] }, key: crypto.randomUUID() }); id = result.item.id; }
      await loadThreads(); await navigate('chat', { threadId: id }); dialog.close();
    } catch (error) { pendingThreadId = null; reflectComposer(); showStatus(status, error.message, 'error'); } finally { start.disabled = false; } };
    openModal(editing ? '管理群成员' : kind === 'direct' ? '发起私聊' : '创建群聊', kind === 'group' && !editing && el('label', { class: 'field' }, el('span', {}, '群聊名称'), title),
      el('p', {}, editing ? '新增成员将收到邀请，取消勾选可移出群聊。' : kind === 'group' ? '可以先创建群聊；勾选的好友会收到邀请，接受后才加入。' : '选择一位已添加的好友。'), options,
      !items.length && el('p', {}, '好友列表为空。可在「好友」中通过ID或账号搜索并申请。'), status, el('footer', { class: 'dialog-footer' }, start));
  } catch (error) { toast(error.message, 'error'); }
}
function groupMembers() {
  socialUI.groupMembers().catch(e=>toast(e.message,'error'));
}
function renameThread() {
  const input = el('input', { value: activeThread.title, maxlength: 80, 'aria-label': '对话名称' });
  confirmModal('给夜话起个名字', '名称只影响这段对话。', '保存修改', async () => { await request('/api/chat/threads/' + activeThread.id, { method: 'PATCH', json: { title: input.value } }); await loadThread(activeThread.id); await loadThreads(); }, input);
}
function removeThread() {
  const thread = activeThread; const label = thread.kind === 'group' ? thread.owner === session.key ? '解散群聊' : '退出群聊' : '移除对话';
  confirmModal(label, thread.kind === 'direct' ? '仅从你的列表中隐藏；对方发送新消息后会重新出现。' : thread.kind === 'group' && thread.owner === session.key ? '解散后，所有成员将无法再访问本群消息。' : '确认处理这段对话？', label, async () => {
    await request('/api/chat/threads/' + thread.id, { method: 'DELETE' }); activeThread = null; messageNodes.clear(); welcome(); await loadThreads(); await navigate('chat');
  });
}

function fitInput() { if (!textarea) return; textarea.style.height = 'auto'; textarea.style.height = Math.min(160, textarea.scrollHeight) + 'px'; }
function clearFiles() { selectedFiles.forEach((entry) => entry.preview && URL.revokeObjectURL(entry.preview)); selectedFiles = []; if (fileInput) fileInput.value = ''; drawFiles(); }
function drawFiles() {
  if (!fileList) return;
  fileList.replaceChildren(...selectedFiles.map((entry, index) => {
    const remove = iconButton('close', '移除附件 ' + entry.file.name); remove.onclick = () => { if (entry.preview) URL.revokeObjectURL(entry.preview); selectedFiles.splice(index, 1); sendKey = crypto.randomUUID(); drawFiles(); };
    return el('div', { class: 'chat-attachment' }, entry.preview ? image(entry.preview, '', { width: 30, height: 30 }) : icon(entry.kind === 'audio' ? 'music' : 'mail', 15), el('span', {}, entry.file.name), remove);
  }));
}
function reflectComposer() {
  if (!sendButton) return;
  const generating = isGenerating()&&!textarea?.value.trim(); sendButton.disabled = sending || Boolean(pendingThreadId);
  textarea.disabled = sending || Boolean(pendingThreadId);
  sendButton.replaceChildren(icon(generating ? 'stop' : 'upload', 15), generating ? '停止回复' : sending ? '发送中' : '发送');
  sendButton.setAttribute('aria-label', generating ? '停止回复' : '发送消息');
  mention?.closest('label')?.toggleAttribute('hidden', !activeThread || activeThread.kind === 'ai');
  textarea.placeholder = activeThread && activeThread.kind !== 'ai' ? '写一条消息，和此刻的他们分享…' : '写下想说的话，或输入「查看音乐」…';
}
function buildComposer() {
  textarea = el('textarea', { rows: 1, maxlength: 8000, 'aria-label': '聊天消息', placeholder: '写下想说的话…' });
  textarea.oninput = () => { fitInput(); sendKey = crypto.randomUUID();reflectComposer();try{localStorage.setItem('chat-input:'+session.key+':'+(activeThread?.id||''),textarea.value);}catch{} };
  textarea.onkeydown = (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (textarea.value.trim()) composer.requestSubmit(); } };
  fileInput = el('input', { type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.webp,.mp3,.wav,.ogg,.opus,.lrc,.txt', hidden: true, 'aria-label': '选择聊天附件' });
  fileInput.onchange = () => {
    const entries = [...fileInput.files];
    try {
      if (selectedFiles.length + entries.length > 8) throw new Error('单条消息最多 8 个附件。');
      const prepared = entries.map((file) => { const suffix = file.name.split('.').at(-1).toLowerCase(), kind = ['wav', 'mp3', 'ogg', 'opus'].includes(suffix) ? 'audio' : ['lrc', 'txt'].includes(suffix) ? 'lyrics' : ['png', 'jpg', 'jpeg', 'webp'].includes(suffix) ? 'image' : null;
        if (!kind || !file.size || file.size > (kind === 'audio' ? 100_000_000 : kind === 'lyrics' ? 65536 : 8 * 1024 * 1024)) throw new Error(file.name + '：音频最大 100,000,000 字节；图片最大 8 MiB；LRC/TXT 最大 64 KiB。');
        return { file, kind, preview: null };
      });
      for (const entry of prepared) if (entry.kind === 'image') entry.preview = URL.createObjectURL(entry.file);
      selectedFiles.push(...prepared); sendKey = crypto.randomUUID(); drawFiles();
    } catch (error) { fileInput.value = ''; toast(error.message, 'error'); }
  };
  const attach = iconButton('plus', '添加附件'); attach.onclick = () => fileInput.click();
  const help = iconButton('sparkle', '查看助理指令'); help.onclick = () => { textarea.value = '/帮助'; textarea.focus(); fitInput(); };
  mention = el('input', { type: 'checkbox', name: 'mentionAssistant' });
  sendButton = action('发送', 'upload', { type: 'submit', class: 'button send-button', 'aria-label': '发送消息' });
  fileList = el('div', { class: 'composer-files' }); progress = el('div', { class: 'composer-progress', role: 'status' }); composerStatus = el('span');
  composer.replaceChildren(el('div', { class: 'composer-box' }, textarea, fileList, progress, el('div', { class: 'composer-toolbar' }, el('div', { class: 'composer-tools' }, attach, help, fileInput, el('small', {}, '图片 · 音频 · LRC'), el('label', { class: 'mention-option', hidden: true }, mention, '@助理')), sendButton)),
    el('div', { class: 'composer-note' }, composerStatus, el('span', {}, 'Enter 发送 · Shift + Enter 换行')));
  composerStatus.textContent = '消息仅对会话成员可见。';
  composer.onsubmit = sendMessage;
}
function xhrUpload(entry, key, onProgress, actor) {
  return new Promise(async (resolve, reject) => {
    try {
      const form = new FormData(); form.set('kind', entry.kind); form.set('file', entry.file);
      const encoded = new Request(location.origin + '/api/chat/files', { method: 'POST', body: form }); const blob = await encoded.blob();
      if (session?.key !== actor.key) throw new Error('账号已变更，本次上传已停止。');
      const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/chat/files'); xhr.responseType = 'json'; xhr.timeout = 900_000;
      xhr.setRequestHeader('Content-Type', encoded.headers.get('Content-Type')); xhr.setRequestHeader('X-CSRF-Token', actor.csrf); xhr.setRequestHeader('Idempotency-Key', key);
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded, event.total, false); }; xhr.upload.onload = () => onProgress(blob.size, blob.size, true);
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response.item) : reject(new Error(xhr.response?.error?.message || '文件未保存，请保留输入后重试。'));
      xhr.onerror = xhr.ontimeout = () => reject(new Error('文件传输中断，输入和附件已保留。')); xhr.send(blob);
    } catch (error) { reject(error); }
  });
}
async function sendMessage(event) {
  event.preventDefault(); if (sending || pendingThreadId || !session) return;
  if (isGenerating()&&!textarea.value.trim()) { try { await request('/api/chat/threads/' + activeThread.id + '/stop', { method: 'POST' }); } catch (error) { toast(error.message, 'error'); } return; }
  const text = textarea.value.trim() || (selectedFiles.length ? '分享一些文件。' : ''); if (!text) { textarea.focus(); return; }
  const key = sendKey, files = [...selectedFiles], senderKey = session.key, actor = session, ticket = {};
  activeSendTicket = ticket; sending = true; textarea.disabled = fileInput.disabled = true; reflectComposer();
  try {
    if (!activeThread) { const result = await request('/api/chat/threads', { method: 'POST', json: {}, key: key + '_thread' }); if (session?.key !== senderKey) throw new Error('账号已变更，请在当前账号重新发送。'); activeThread = { ...result.item, members: [{ key: senderKey, username: session.username }] }; history.replaceState(null, '', '/chat?t=' + result.item.id); drawHeader(); }
    const targetId = activeThread.id;
    const ids = []; const total = files.reduce((n, entry) => n + entry.file.size, 0); let completed = 0;
    for (let i = 0; i < files.length; i++) {
      if (session?.key !== senderKey) throw new Error('账号已变更，本次发送已停止。');
      const entry = files[i]; let value = uploadCache.get(entry.file);
      if (!value) value = await xhrUpload(entry, key + '_file_' + i, (loaded, size, saving) => {
        if (session?.key !== senderKey || activeSendTicket !== ticket) return;
        const percent = Math.min(100, Math.floor(loaded / size * 100)), overall = Math.min(100, Math.floor((completed + entry.file.size * loaded / size) / total * 100));
        progress.replaceChildren(el('span', {}, entry.file.name + ' · ' + percent + '% · ' + (saving ? '正在保存' : '上传中') + ' · 整体 ' + overall + '%'), el('progress', { max: 100, value: overall, 'aria-label': '附件整体上传进度' }));
      }, actor);
      uploadCache.set(entry.file, value); ids.push(value.id); completed += entry.file.size;
    }
    if (session?.key !== senderKey) throw new Error('账号已变更，本次发送已停止。');
    const result = await request('/api/chat/threads/' + targetId + '/messages', { method: 'POST', json: { text, attachmentIds: ids, mentionAssistant: mention.checked }, key });
    if (session?.key !== senderKey) return;
    inputDrafts.delete(targetId);
    try{localStorage.removeItem('chat-input:'+senderKey+':'+targetId);}catch{}
    if (activeThread?.id === targetId) { for (const item of result.items) upsert(item); textarea.value = ''; clearFiles(); progress.replaceChildren(); sendKey = crypto.randomUUID(); fitInput(); scrollToBottom(); }
    await loadThreads(); markRead();
  } catch (error) { if (session?.key === senderKey && activeSendTicket === ticket) { composerStatus.textContent = error.message; toast(error.message, 'error'); } }
  finally { if (activeSendTicket === ticket) { activeSendTicket = null; sending = false; textarea.disabled = fileInput.disabled = false; reflectComposer(); textarea.focus(); } }
}

function confirmAction(value, item, button) {
  if (session?.role !== 'admin') return;
  const label = value.type === 'sync' ? '确认同步' : '确认保存';
  confirmModal(value.type === 'sync' ? '同步到月光庭院' : '保存为网站草稿', value.type === 'sync' ? '同步后，网站首页与对应栏目会显示本次修改。' : '先保存私有草稿；公开发布仍需要另一次确认同步。', label, async () => {
    let result;
    if (value.type === 'sync') result = await request('/api/admin/drafts/' + value.id + '/sync', { method: 'POST', json: { version: value.version } });
    else if (value.type === 'reply') result = await request('/api/admin/questions/' + value.id + '/draft', { method: 'PUT', json: { reply: value.reply, version: value.version }, key: 'chat_action_' + item.id });
    else {const ids=Object.values(value.files).flat(),mapped=(await request('/api/chat/site/media-export',{method:'POST',json:{ids}})).items;const files=Object.fromEntries(Object.entries(value.files).map(([name,values])=>[name,values.map(id=>mapped[id]||id)]));result=await request('/api/admin/uploads/' + value.category, { method: 'POST', json: { fields: value.fields, files }, key: 'chat_action_' + item.id });}
    button.disabled = true; button.textContent = value.type === 'sync' ? '已同步' : '已保存，待同步'; toast(button.textContent);
    if (value.type !== 'sync') {
      const draft = result.draft || result; const next = action('核对并同步', 'check');
      next.onclick = () => confirmAction({ type: 'sync', id: draft.id, version: draft.version, title: draft.item?.title || value.question || '答复草稿' }, item, next); button.after(next);
    }
    library.refresh();
  }, el('pre', {}, value.reply || value.title || JSON.stringify(value.fields, null, 2)));
}

async function showAccounts(target) {
  const panel = target||panels.accounts;
  const username = el('input', { required: true, maxlength: 40, autocomplete: 'off', 'aria-label': '新账号' });
  const password = el('input', { type: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'new-password', 'aria-label': '初始密码' });
  const create = action('创建普通账号', 'plus', { type: 'submit', class: 'button button-primary' }), status = el('p', { class: 'inline-status', role: 'status' }), rows = el('div');
  const form = el('form', { class: 'account-form' }, el('label', { class: 'field' }, el('span', {}, '账号（2—40 位字母、数字、点、下划线或横线）'), username), el('label', { class: 'field' }, el('span', {}, '初始密码（8—128 个字符）'), password), create, status);
  async function load() {
    const result = await request('/api/admin/accounts');
    rows.replaceChildren(...result.items.map((account) => {
      const toggle = action(account.disabled ? '启用账号' : '停用账号'); toggle.onclick = () => confirmModal(account.disabled ? '启用账号' : '停用账号', account.disabled ? '启用后，此账号可以重新登录。' : '将使此账号的登录会话立即失效，聊天记录仍保留。', '保存修改', async () => { await request('/api/admin/accounts/' + account.id, { method: 'PATCH', json: { disabled: !account.disabled } }); await load(); });
      const reset = action('重置密码'); reset.onclick = () => { const input = el('input', { type: 'password', minlength: 8, maxlength: 128, autocomplete: 'new-password', 'aria-label': '新的账号密码' }); confirmModal('重置账号密码', '请设置 8—128 个字符的新密码。原有会话将失效。', '保存修改', async () => { await request('/api/admin/accounts/' + account.id, { method: 'PATCH', json: { password: input.value } }); toast('密码已更新'); }, input); };
      return el('article', { class: 'account-row' }, avatar(account.username), el('div', { class: 'account-copy' }, el('strong', {}, account.username), el('small', {}, account.disabled ? '已停用' : '普通成员 · 可以聊天、私聊与建群')), reset, toggle);
    }));
  }
  form.onsubmit = async (e) => { e.preventDefault(); create.disabled = true; try { await request('/api/admin/accounts', { method: 'POST', json: { username: username.value.trim(), password: password.value } }); username.value = password.value = ''; showStatus(status, '账号已创建。请通过私密方式交付给使用者。', 'success'); await load(); } catch (error) { showStatus(status, error.message, 'error'); } finally { create.disabled = false; } };
  panel.replaceChildren(el('header', { class: 'app-section-heading' }, el('p', { class: 'eyebrow' }, 'PEOPLE UNDER THE STARS'), el('h2', {}, '用户管理'), el('p', {}, '管理员也使用同一套聊天界面；普通成员仅能使用聊天与公开栏目。')), form, rows);
  try { await load(); } catch (error) { toast(error.message, 'error'); }
}

async function navigate(next, options = {}) {
  if (!session) return;
  if (!Object.hasOwn(panels, next)) next = 'chat';
  if (['manage', 'accounts','software'].includes(next) && session.role !== 'admin') { toast('此栏目仅管理员可用。', 'error'); next = 'chat'; }
  if(view==='chat'&&activeThread)scrollPositions.set(activeThread.id,conversation.scrollTop);
  view = next;document.body.classList.toggle('wide-page',view!=='chat');sidebar.hidden=view!=='chat';if(view!=='chat')details.hidden=true;
  if(options.section){if(['settings','software'].includes(view))pageSection=options.section;else section=options.section;}
  if(view==='software'&&!options.section)pageSection='overview';if(view==='settings'&&!options.section)pageSection='profile';
  for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== view;
  closeSidebar();
  if (view === 'chat' && options.threadId) await loadThread(options.threadId);
  else if (view === 'chat' && !activeThread) { messageNodes.clear(); welcome(); }
  if (view === 'library') library.show(section);
  if (view === 'manage') {
    if (!adminModule) adminModule = await import('./admin.js');
    if (adminOwner !== session.key) { await adminModule.mountAdmin(); adminOwner = session.key; }
    if (options.panel) adminModule.activateAdminPanel(options.panel);
  }
  if (view === 'accounts') return navigate('software',{section:'users'});
  if(['settings','software'].includes(view))await pages.render(panels[view],view,pageSection,options.surface);
  if(view==='chat'&&activeThread)requestAnimationFrame(()=>{if(scrollPositions.has(activeThread.id))conversation.scrollTop=scrollPositions.get(activeThread.id);});
  const url = new URL('/chat', location.origin); if (view !== 'chat') url.searchParams.set('view', view); if (activeThread) url.searchParams.set('t', activeThread.id); if (view === 'library') url.searchParams.set('section', section);if(['settings','software'].includes(view))url.searchParams.set('section',pageSection);
  if (!options.fromHistory && url.href !== location.href) history.pushState(null, '', url.pathname + url.search);
  drawHeader(); drawSidebar(); reflectComposer(); if (view === 'chat') markRead();
  window.hoshifuruDesktop?.setContext?.({threadId:view==='chat'?activeThread?.id:null});
}
function connect() {
  source?.close(); source = new EventSource('/api/chat/events');
  source.addEventListener('ready', async () => { connected = true; drawHeader(); await loadThreads().catch(() => {}); if (activeThread && session) await loadThread(activeThread.id, { background: true }).catch(() => {});socialUI.connected(); });
  source.addEventListener('message', (event) => {
    const value = JSON.parse(event.data);
    socialUI.notifyMessage(value);
    const notice = value.item.metadata?.noticeEventId;
    if (notice && !seenNotices.has(notice)) { seenNotices.add(notice); toast(value.item.metadata.questions ? '庭院收到新的来信，已放入「庭院来信」。' : '庭院更新已同步，批次清单已放入「庭院来信」。'); }
    if (value.threadId === activeThread?.id) queueMessage(value.item); else scheduleThreads();
  });
  source.addEventListener('threads', () => scheduleThreads());
  for(const topic of ['social','profiles','agents'])source.addEventListener(topic,()=>{request('/api/chat/profile').then(v=>{if(session){session.profile=v.item;drawSidebar();}}).catch(()=>{});socialUI.reload().catch(()=>{});});
  source.addEventListener('read',()=>scheduleThreads());
  source.addEventListener('deleted', (event) => { const value = JSON.parse(event.data); if (value.id === activeThread?.id) { activeThread = null; messageNodes.clear(); list.replaceChildren(); welcome(); drawHeader(); } scheduleThreads(); });
  source.onerror = () => { connected = false;socialUI.connected(false); drawHeader(); };
  updates?.close(); updates = new EventSource('/api/public/updates');
  updates.addEventListener('changes', () => refreshWebsite());
}
async function refreshWebsite() {
  try { const settings=await request('/api/public/site'); updateSite(settings.item); document.title = name; document.querySelector('link[rel="icon"]').href = '/assets/brand/tsukiakari-192.png'; if (view === 'library') library.refresh(); refreshNotices(); }
  catch { /* Focus/reconnection retries this lightweight refresh. */ }
}
async function refreshNotices() {
  if (session?.role !== 'admin' || syncingNotices) return;
  const owner = session.key; syncingNotices = true;
  try { for (let page = 0; page < 5 && session?.key === owner; page++) { const result = await request('/api/chat/notices/sync', { method: 'POST' }); if (result.created) scheduleThreads(); if (!result.hasMore) break; } }
  catch { /* The database cursor is advanced atomically with the saved notice. */ }
  finally { if (session?.key === owner) syncingNotices = false; }
}
async function enter() {
  session = await request('/api/chat/session'); loginStage.hidden = true; loginStage.replaceChildren(); shell.hidden = false;
  socialUI.start();buildComposer(); await loadThreads(); connect(); refreshWebsite(); trackRoute('/chat');
  const url = new URL(location.href); section = url.searchParams.get('section') || 'music';
  const wanted = url.pathname === '/chat/manage' ? 'manage' : url.searchParams.get('view') || 'chat';
  if(url.searchParams.get('t')&&wanted!=='chat')await loadThread(url.searchParams.get('t')).catch(()=>{});
  try { await navigate(wanted, { threadId: url.searchParams.get('t') || undefined,section:url.searchParams.get('section')||undefined, panel: url.searchParams.get('panel') || undefined, fromHistory: true }); }
  catch (error) { activeThread = null; toast(error.message, 'error'); await navigate('chat'); }
}
addEventListener('popstate', () => { if (!session) return; const url = new URL(location.href); navigate(url.searchParams.get('view') || 'chat', { threadId: url.searchParams.get('t') || undefined, section: url.searchParams.get('section') || 'music', fromHistory: true }).catch((e) => toast(e.message, 'error')); });
addEventListener('focus', () => { if (!session) return;markRead(); request('/api/chat/session').then(value => {session=value;loadThreads(); if (activeThread) loadThread(activeThread.id, { background: true }); refreshWebsite(); }).catch(() => {}); });
window.hoshifuruDesktop?.onOpenThread?.(id=>{if(session)navigate('chat',{threadId:id}).catch(e=>toast(e.message,'error'));});
document.addEventListener('visibilitychange', () => { document.documentElement.classList.toggle('page-hidden', document.hidden); if (!document.hidden && session) { markRead(); if (activeThread) loadThread(activeThread.id, { background: true }).catch(() => {}); } });
addEventListener('chat-auth-expired', showLogin);
addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
matchMedia('(max-width:760px)').addEventListener('change', () => closeSidebar());
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/chat-worker.js', { scope: '/chat' }).catch(() => {});
setTimeout(() => document.querySelector('#app-boot')?.remove(), 950);
enter().catch(() => showLogin());

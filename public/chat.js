import { action, el, icon, iconButton, image, showStatus, site, toast, updateSite } from './ui.js';
import * as player from './player.js';
import { createLibrary, sectionNames } from './chat-library.js';
import { messageView } from './chat-render.js';
import { trackRoute } from './activity.js';
import { createSocialUI,personAvatar } from './chat-social.js';
import {createPages,personalSections,managementSections} from './chat-pages.js';
import { hasDraftWork } from './draft-controls.js';
import { androidClient } from './chat-android.js';
import { attachmentBudget, readFiles, storeFiles } from './chat-android-drafts.js';
import { signalWithTimeout } from './request-signal.js';

const name = '月明かり';
document.title = name;
const shell = document.querySelector('#app-shell'), loginStage = document.querySelector('#app-login');
const sidebar = document.querySelector('#app-sidebar'), header = document.querySelector('#app-header');
const conversation = document.querySelector('#conversation'), list = document.querySelector('#message-list'), composer = document.querySelector('#composer');
const dialog = document.querySelector('#app-dialog');
const popup = TsukiakariDialogs.bind(dialog);
const connectionNotice = document.querySelector('#chat-connection');
const jumpToLatest = document.querySelector('#chat-latest');
const panels = Object.fromEntries(['chat', 'library', 'manage', 'accounts','settings','software'].map((key) => [key, document.querySelector('#' + key + '-view')]));
let session, threads = [], activeThread, view = 'chat', section = 'music', source, updates;
let textarea, sendButton, fileInput, attachButton, fileList, progress, composerStatus, mention, stopButton, composerDraft;
let threadPage = null, threadLimit = 50, before = null, loadingOlder = false, threadListRequest, refreshListAgain = false;
let routeVersion = 0, accountVersion = 0, refreshTimer, activeTimer, readTimer, scrollFrame, adminModule, adminOwner, olderRequest;
let connectionState = 'connecting', reconnectTimer, reconnectDelay = 1000, sessionRefresh, foregroundRequest, threadRefresh;
let pendingThreadId, activeSendTicket;
let loginAttempt = 0, lastRenewAttempt = 0, timelineCursor = null, retentionCutoff = '', oldestMessageDate = '';
let messageFrame, readPending = false, catchingUp = false, newWhileReading = 0;
let nativeHidden = false;
const messageNodes = new Map(), messageOrder = [], pendingMessages = new Map(), inputDrafts = new Map(), generating = new Set();
let syncingNotices = false;
const seenNotices = new Set();
let pageSection='profile',threadKind='all',threadQuery='',sidebarAccount,railProfile,headerSignature;
const scrollPositions=new Map(), threadRows=new Map();
const filterOrder = [['all', '全部'], ['ai', 'AI'], ['direct', '好友'], ['group', '群聊']];
const filterScroll = new Map();
let threadsLoaded = false, threadListError = false;
const nativeTextareaSizing = CSS.supports('field-sizing: content');
const details=document.querySelector('#conversation-details');
const windowHidden = () => document.hidden || nativeHidden;
window.hoshifuruDesktop?.setClosingGuard?.(() =>
  Boolean(activeSendTicket || [...inputDrafts.values()].some(draft => draft.files.length) || hasDraftWork()));
try{document.documentElement.dataset.density=localStorage.getItem('tsukiakari-density')||'comfortable';}catch{}

async function request(path, options = {}) {
  const version = accountVersion;
  const { json, key, ...rest } = options;
  let response;
  try {
    response = await fetch(path, { ...rest, signal: rest.signal ?? signalWithTimeout(45000), cache: 'no-store', headers: {
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}),
      ...(session?.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...rest.headers,
    }, body: json === undefined ? rest.body : JSON.stringify(json) });
  } catch (error) {
    if (rest.signal?.aborted && error.name !== 'TimeoutError') throw error;
    throw new Error(error.name === 'TimeoutError' ? '服务响应超时，可以重试。' : '暂时无法连接服务，请检查连接后重试。');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && result.error?.code === 'login_required' && !path.endsWith('/login') && session && version === accountVersion) showLogin();
    const missing = path.startsWith('/api/chat/') && (response.status === 404 && !session || [502, 503, 504].includes(response.status));
    const error = new Error(result.error?.message && !missing ? result.error.message : missing ? '聊天服务暂未就绪，请稍后重试。' : '服务暂未完成请求，请重试。');
    error.status = response.status;
    error.code = result.error?.code;
    throw error;
  }
  if (version !== accountVersion) throw new Error('登录会话已变更，请重试。');
  return result;
}
const library = createLibrary({ root: panels.library, request, account: () => session, changeSection: (next) => navigate('library', { section: next }) });
const socialUI=createSocialUI({request,account:()=>session,dialog,openModal,openPage,openDetails,hasOpenSurface:()=>!details.hidden,currentThread:()=>activeThread,routeStamp:()=>routeVersion,
 refresh:async()=>{await loadThreads();await refreshActiveThread();},
 onProfile:(profile)=>{if(session)session.profile=profile;drawSidebar();},openThread:(id)=>navigate('chat',{threadId:id}),
 uploadAvatar:(file,key,onProgress)=>xhrUpload({file,kind:'image'},key,onProgress,session)});

const android = androidClient({ account: () => session, request, navigate, contacts: () => socialUI.contacts.open(), modal: openModal, confirm: confirmModal,
  active: () => activeThread, visibility: hidden => { nativeHidden = hidden; onVisibilityChanged(); }, refreshRead: markRead, logout: confirmLogout, reconnect: openChatEvents });
const pages=createPages({request,account:()=>session,navigate,social:()=>socialUI,showAccounts,openModal,connection:()=>connectionState,androidPage:android?.page});
function openPage(section,title,...children){if(dialog.open)dialog.close();details.hidden=true;return navigate(['personas'].includes(section)?'software':'settings',{section,surface:{title,children}});}
function openDetails(title,...children){const close=iconButton('close','关闭会话详情');close.onclick=()=>details.hidden=true;details.replaceChildren(el('header',{class:'details-heading'},el('h2',{},title),close),...children.flat(Infinity).filter(v=>v!==false&&v!=null));details.hidden=false;close.focus();}
addEventListener('keydown',e=>{if(e.key==='Escape'&&!document.querySelector('dialog[open]')&&!details.hidden){details.hidden=true;header.querySelector('[aria-label="查看群成员"]')?.focus();}});
function appBrand() {
  return el('div', { class: 'app-brand' }, image('/assets/brand/tsukiakari-192.png', '', { width: 41, height: 41, loading: 'eager' }),
    el('div', {}, el('strong', {}, name), el('small', {}, 'TSUKIAKARI')));
}
function avatar(username) { return el('span', { class: 'account-avatar', 'aria-hidden': true }, username.slice(0, 1).toUpperCase()); }
function closeSidebar() { document.body.classList.remove('sidebar-open'); sidebar.inert = !android && matchMedia('(max-width:760px)').matches; document.querySelector('#sidebar-shade').hidden = true; header.querySelector('.mobile-menu')?.setAttribute('aria-expanded', 'false'); }
document.querySelector('#sidebar-shade').onclick = closeSidebar;
function openModal(title, ...children) {
  dialog.classList.remove('wide-dialog');
  const close = iconButton('close', '关闭对话框'); close.onclick = () => popup.close();
  dialog.replaceChildren(el('div', { class: 'app-dialog-content' }, el('header', { class: 'app-dialog-heading' }, el('h2', { id: 'app-dialog-title' }, title), close), children));
  popup.open(close);
}
function confirmModal(title, description, label, work, extra) {
  const cancel = action('取消'); cancel.onclick = () => popup.close();
  const confirm = action(label, 'check', { class: 'button button-primary' });
  const status = el('p', { class: 'inline-status', role: 'status' });
  confirm.onclick = async () => { confirm.disabled = true; try { await work(); dialog.close(); } catch (error) { showStatus(status, error.message, 'error'); } finally { confirm.disabled = false; } };
  openModal(title, el('p', {}, description), extra, status, el('footer', { class: 'dialog-footer' }, cancel, confirm));
}

function confirmLogout() {
  confirmModal('退出登录', '下次登录可继续聊天。', '退出登录', async () => {
    await request('/api/chat/logout', { method: 'POST' }); showLogin(true);
  });
}

function showLogin(explicit = false, problem = null, probe = false) {
  const leaving = Boolean(session) || explicit;
  loginAttempt++; lastRenewAttempt = 0; retentionCutoff = '';
  accountVersion++; routeVersion++;
  if (leaving || problem?.status === 401) android?.logout(explicit === true);
  if (leaving && android) history.replaceState(null, '', '/chat');
  foregroundRequest?.abort(); threadRefresh?.controller.abort(); activeSendTicket?.controller.abort();
  threadRefresh = sessionRefresh = threadListRequest = null; refreshListAgain = false;
  for (const timer of [refreshTimer, activeTimer, readTimer, reconnectTimer]) clearTimeout(timer);
  refreshTimer = activeTimer = reconnectTimer = null;
  pages.reset();sidebarAccount=railProfile=headerSignature=null;document.querySelector('#app-rail').replaceChildren();details.hidden=true;socialUI.stop();if(dialog.open)dialog.close();dialog.replaceChildren();
  source?.close(); updates?.close(); source = updates = null;
  connectionState = 'connecting'; reconnectDelay = 1000;
  session = null; activeThread = null; threads = []; threadLimit = 50; threadPage = null; threadQuery = '';
  threadsLoaded = threadListError = false;
  resetTimeline(); pendingMessages.clear(); scrollPositions.clear(); threadRows.clear(); filterScroll.clear();
  for (const draft of inputDrafts.values()) discardPreviews(draft.files);
  inputDrafts.clear(); composerDraft = null;
  pendingThreadId = null; activeSendTicket = null;
  seenNotices.clear(); syncingNotices = false;
  list.replaceChildren(); panels.accounts.replaceChildren(); adminModule?.unmountAdmin();
  shell.hidden = true; loginStage.hidden = false; closeSidebar(); player.stop(); player.setBackground(null);
  document.querySelector('#manage-main').replaceChildren(); adminOwner = null; library.reset();
  const username = el('input', { name: 'username', autocomplete: 'username', required: true, maxlength: 40, placeholder: '你的账号', 'aria-label': '账号' });
  const password = el('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 128, placeholder: '账号密码', 'aria-label': '密码' });
  const remember = el('input', { type: 'checkbox', name: 'remember', checked: true });
  const submit = action('登录', 'lock', { type: 'submit', class: 'button button-primary' });
  const status = el('p', { class: 'inline-status', role: 'status' });
  const retry = action('重试连接', null, { class: 'button app-login-retry', hidden: true });
  const form = el('form', { class: 'app-login-form' }, appBrand(), el('h1', {}, android ? '登录月明かり' : '今夜，也在这里相见。'),
    el('p', {}, android ? '使用与桌面端相同的账号，继续聊天。' : '登录后，回到属于你的聊天与收藏。'),
    el('label', { class: 'field' }, el('span', {}, '账号'), username), el('label', { class: 'field' }, el('span', {}, '密码'), password),
    el('label', { class: 'app-login-remember' }, remember, '记住登录状态'), submit, status, retry,
    !android && el('div', { class: 'app-login-note' }, el('a', { href: '/' }, '逛逛詩音の月光庭院')));
  const loginError = error => {
    showStatus(status, error.message, 'error');
    retry.hidden = Boolean(error.status && error.status < 500 && error.status !== 404);
  };
  async function resumeSession() {
    const attempt = ++loginAttempt;
    retry.disabled = true;
    try { await enter(attempt); }
    catch (error) {
      if (attempt !== loginAttempt) return;
      if (error.status === 401) { android?.logout(false); showStatus(status, ''); retry.hidden = true; }
      else loginError(error);
    } finally { retry.disabled = false; }
  }
  retry.onclick = () => username.value.trim() && password.value ? form.requestSubmit() : void resumeSession();
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const attempt = ++loginAttempt;
    submit.disabled = retry.disabled = true; showStatus(status, '正在核验账号…');
    try {
      await request('/api/chat/login', { method: 'POST', signal: signalWithTimeout(15000),
        json: { username: username.value.trim(), password: password.value, remember: remember.checked } });
      password.value = ''; await enter(attempt);
    } catch (error) { if (attempt === loginAttempt) loginError(error); }
    finally { submit.disabled = retry.disabled = false; }
  };
  if (!android) request('/api/chat/bootstrap').then(v=>{if(v.available){form.querySelector('h1').textContent='为月明かり点亮第一盏灯。';form.querySelector('p').textContent='创建本机管理员，账号与密码由你设置。';submit.textContent='创建管理员';form.onsubmit=async e=>{e.preventDefault();submit.disabled=true;try{await request('/api/chat/bootstrap',{method:'POST',json:{username:username.value.trim(),password:password.value}});await request('/api/chat/login',{method:'POST',json:{username:username.value.trim(),password:password.value,remember:remember.checked}});password.value='';await enter();}catch(error){showStatus(status,error.message,'error');}finally{submit.disabled=false;}};}}).catch(()=>{});
  loginStage.replaceChildren(el('div', { class: 'app-login-art' }, image(site.heroImage, '', { loading: 'eager' }),
    el('div', { class: 'app-login-caption' }, el('p', { class: 'eyebrow' }, 'UNDER THE SAME MOON'), el('h2', {}, '星が降る夜、\nあなたと。'), el('p', {}, site.motto))), el('div', { class: 'app-login-form-wrap' }, form));
  if (problem && problem.status !== 401) loginError(problem);
  if (probe) void resumeSession();
}

function drawRail(){
  const rail = document.querySelector('#app-rail');
  if (android) return android.rail(rail);
  if (!rail.firstElementChild) {
    const brand = el('button', { class: 'rail-brand', type: 'button', 'aria-label': '月明かり · 返回聊天', title: '月明かり' },
      image('/assets/brand/tsukiakari-64.png', '', { width: 38, height: 38 }));
    brand.onclick = () => navigate('chat');
    const nav = el('nav', { class: 'app-nav', 'aria-label': '应用功能' });
    const items = [['chat','聊天','mail'],['library','月光庭院','moon']];
    if (session.role === 'admin') items.push(['manage','网站管理','photo'],['software','软件管理','lock']);
    for (const [key, label, glyph] of items) {
      const button = el('button', { type: 'button', class: 'rail-button', 'aria-label': label, title: label, 'data-rail-view': key }, icon(glyph));
      button.onclick = () => navigate(key);
      nav.append(button);
    }
    const settings = el('button', { type: 'button', class: 'rail-button', 'aria-label': '个人设置', title: '个人设置', 'data-rail-view': 'settings' }, icon('sparkle'));
    settings.onclick = () => navigate('settings', { section: 'profile' });
    const profile = el('button', { type: 'button', class: 'rail-button rail-avatar', 'aria-label': '编辑个人资料' });
    profile.onclick = settings.onclick;
    const logout = el('button', { class: 'rail-button', type: 'button', 'aria-label': '退出登录', title: '退出登录' }, icon('back'));
    logout.onclick = confirmLogout;
    rail.replaceChildren(brand, nav, el('span', { class: 'rail-spacer' }), settings, profile, logout);
  }
  const person = session.profile || { username: session.username };
  const signature = JSON.stringify([person.displayName, person.avatar, person.username]);
  if (signature !== railProfile) {
    const profile = rail.querySelector('.rail-avatar');
    profile.title = person.displayName || person.username;
    profile.replaceChildren(personAvatar(person));
    railProfile = signature;
  }
  for (const button of rail.querySelectorAll('[data-rail-view]')) {
    if (button.dataset.railView === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}
function newConversation(){const choices=el('div',{class:'new-conversation-choices'});for(const[k,title,note,glyph]of[['ai','AI 对话','选择服务器上的人格，开始一段独立对话。','sparkle'],['direct','好友私聊','与已添加的好友说说近况。','mail'],['group','创建群聊','邀请同行的人，也可以邀请 AI。','heart']]){const b=action('',glyph,{'aria-label':title});b.append(el('span',{},title,el('small',{},note)));b.onclick=()=>{dialog.close();if(k==='ai'){if(session.astrbotConfigured)socialUI.aiHub();else newAiThread();}else contactDialog(k);};choices.append(b);}openModal('新建会话',choices);}
function drawSidebar(){
 if(!session)return;drawRail();
 if(sidebarAccount!==session.key){
 let saved;
 try { saved = localStorage.getItem('tsukiakari-thread-kind:' + session.key); } catch {}
 sidebarAccount=session.key;
 threadKind = filterOrder.some(([key]) => key === saved) ? saved : 'all';
 const add=iconButton('plus','新建会话');add.onclick=newConversation;
 if (android) try { threadQuery = localStorage.getItem('android-search:' + session.key) || ''; } catch {}
 const search=el('input',{class:'thread-search','aria-label':'筛选会话',placeholder:'搜索会话…',value:threadQuery});
 search.oninput=()=>{threadQuery=search.value;applyThreadFilter();if(android)try{localStorage.setItem('android-search:'+session.key,threadQuery);}catch{}};
 const filters=el('div',{class:'conversation-filters',role:'group','aria-label':'会话类型'});
 for(const [key,title] of filterOrder){
   const button=action(title,undefined,{'data-kind':key});
   button.onclick=()=>chooseThreadKind(key);
   filters.append(button);
 }
 filters.onkeydown = event => {
   const index = filterOrder.findIndex(([key]) => key === threadKind);
   const desired = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: filterOrder.length - 1 };
   if (!Object.hasOwn(desired, event.key)) return;
   event.preventDefault();
   const next = (desired[event.key] + filterOrder.length) % filterOrder.length;
   chooseThreadKind(filterOrder[next][0]);
   filters.children[next].focus({ preventScroll: true });
 };
 const people=action('通讯录','heart',{'aria-haspopup':'dialog','aria-controls':'contacts-dialog'});
 people.onclick=()=>socialUI.contacts.open();
 const retry = action('重试读取', null, { class: 'button thread-retry', hidden: true });
 retry.onclick = () => loadThreads().catch(error => toast(error.message, 'error'));
 const list = el('div', { class: 'thread-list', 'aria-label': '会话列表' },
   el('div', { class: 'thread-track' }), el('p', { class: 'sidebar-empty', hidden: true }), retry);
 const more = action('载入更多会话', null, { class: 'button more-threads', hidden: true });
 more.onclick = () => loadThreads(true).catch(error => toast(error.message, 'error'));
 sidebar.replaceChildren(el('div',{class:'conversation-heading'},el('strong',{},'月明かり'),add),search,filters,list,more,el('footer',{class:'sidebar-footer'},people));}
 drawThreadList();
}
function chooseThreadKind(kind) {
  if (kind === threadKind) return;
  const list = sidebar.querySelector('.thread-list');
  filterScroll.set(threadKind, list.scrollTop);
  const direction = filterOrder.findIndex(([key]) => key === kind) - filterOrder.findIndex(([key]) => key === threadKind);
  threadKind = kind;
  try { localStorage.setItem('tsukiakari-thread-kind:' + session.key, kind); } catch {}
  applyThreadFilter();
  list.scrollTop = filterScroll.get(kind) || 0;
  TsukiakariDialogs.slide(list.querySelector('.thread-track'), direction);
}
function applyThreadFilter() {
  const filters = sidebar.querySelector('.conversation-filters');
  filters.style.setProperty('--selected-filter', filterOrder.findIndex(([key]) => key === threadKind));
  for (const button of filters.children) button.setAttribute('aria-pressed', String(button.dataset.kind === threadKind));
  const query = threadQuery.trim().toLowerCase();
  let matches = 0;
  for (const entry of threadRows.values()) {
    const hidden = (threadKind !== 'all' && entry.kind !== threadKind) || !entry.search.includes(query);
    if (entry.row.hidden !== hidden) entry.row.hidden = hidden;
    if (!hidden) matches++;
  }
  const empty = sidebar.querySelector('.sidebar-empty');
  empty.hidden = matches > 0;
  if (!matches) {
    const copy = threadListError && !threadsLoaded ? '暂时无法读取会话。'
      : !threadsLoaded ? '正在读取会话…' : query ? '没有匹配的会话。' : '此分类还没有会话。';
    if (empty.textContent !== copy) empty.textContent = copy;
  }
  sidebar.querySelector('.thread-retry').hidden = threadsLoaded || !threadListError;
}
function drawThreadList() {
  const container = sidebar.querySelector('.thread-track');
  if (!container) return;
  const ids = new Set(threads.map(t => t.id));
  for (const [id, entry] of threadRows) {
    if (!ids.has(id)) { entry.row.remove(); threadRows.delete(id); }
  }
  let next = container.firstElementChild;
  for (const t of threads) {
    let entry = threadRows.get(t.id);
    if (!entry) {
      const label = { ai: 'AI 对话', direct: '好友', group: '群聊' }[t.kind] || '会话';
      const title = el('strong'), unread = el('span', { class: 'thread-unread', hidden: true });
      const button = el('button', { class: 'thread-button', type: 'button' },
        el('span', { class: 'thread-kind-icon kind-' + t.kind }, icon(t.kind === 'ai' ? 'sparkle' : t.kind === 'group' ? 'heart' : 'mail', 16)),
        el('span', { class: 'thread-copy' }, title, el('small', {}, label)), unread);
      button.onclick = () => navigate('chat', { threadId: t.id });
      entry = { row: el('div', { class: 'thread-row' }, button), button, title, unread, kind: t.kind, search: '' };
      threadRows.set(t.id, entry);
    }
    const { row, button, title, unread } = entry;
    if (title.textContent !== t.title) {
      title.textContent = button.title = t.title;
      button.setAttribute('aria-label', t.title);
      entry.search = t.title.toLowerCase();
    }
    const count = t.unread > 99 ? '99+' : String(t.unread || '');
    if (unread.textContent !== count) unread.textContent = count;
    unread.hidden = !t.unread;
    const current = view === 'chat' && t.id === activeThread?.id;
    row.classList.toggle('is-active', current);
    if (current) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
    if (row !== next) container.insertBefore(row, next);
    next = row.nextElementSibling;
  }
  const more = sidebar.querySelector('.more-threads');
  more.hidden = threadPage === null;
  more.disabled = !!threadListRequest;
  applyThreadFilter();
}
function drawHeader(){if(!session)return;
 const menu=iconButton('plus','展开导航',{class:'icon-button mobile-menu','aria-expanded':String(document.body.classList.contains('sidebar-open'))});menu.onclick=()=>{const open=document.body.classList.toggle('sidebar-open');sidebar.inert=!open;document.querySelector('#sidebar-shade').hidden=!open;};
 const t=activeThread,ai=t?.members?.find(m=>m.kind==='ai'),friend=t?.kind==='direct'?t.members?.find(m=>m.key!==session.key):null,kind=t?.kind;const labels={ai:'AI',direct:'好友',group:'群聊'};
 const title=view==='chat'?(kind==='ai'?ai?.displayName||session.assistantName||'AI 对话':friend?.displayName||t?.title||'聊天'):view==='library'?sectionNames[section]:view==='manage'?'詩音の月光庭院 · 网站管理':view==='software'?'月明かり · 软件管理':'个人设置';
 const statusNames={online:'在线',away:'离开',busy:'忙碌',invisible:'离线',offline:'离线'};
 const note=view==='chat'?(pendingThreadId?'正在打开会话…':kind==='group'?(t.members?.length||1)+' 位成员 · 邀请制':kind==='direct'?(statusNames[friend?.status]||'离线')+' · 好友私聊':ai?.enabled===false?'人格已停用，请重新选择':kind=== 'ai'?(t.title||'独立 AI 对话'):'选中一段对话，或开始新的聊天。'):view==='manage'?'草稿保存与确认同步':view==='software'?(managementSections[pageSection]||'软件概览'):view==='settings'?(personalSections[pageSection]||''):'已同步的庭院收藏';
 const signature = JSON.stringify([view, t?.id, kind, t?.owner, title, note]);
 if (signature === headerSignature) return;
 headerSignature = signature;
 const actions=el('div',{class:'app-header-actions'});if(view==='chat'&&t){if(kind==='group'){const members=iconButton('heart','查看群成员');members.onclick=groupMembers;actions.append(members);}const more=iconButton('down','会话操作');more.onclick=()=>{const controls=el('div',{class:'conversation-menu'});if(kind!=='direct'){const choose=action(kind==='group'?'邀请AI入群':'选择AI人格','sparkle');choose.onclick=()=>socialUI.aiHub(t.id);controls.append(choose);}if(t.owner===session.key&&kind!=='direct'){const rename=action('重命名对话');rename.onclick=renameThread;controls.append(rename);}const remove=action(kind==='group'?(t.owner===session.key?'解散群聊':'退出群聊'):'移除对话','trash');remove.onclick=removeThread;controls.append(remove);openModal('会话操作',controls);};actions.append(more);}
 if(view!=='chat'){const back=action('返回聊天','back',{class:'button header-back'});back.onclick=android?.list||(()=>navigate('chat'));actions.append(back);}
 const back = android && view === 'chat' ? iconButton('back','返回会话列表',{class:'icon-button android-chat-back'}) : null;
 if (back) back.onclick = android.list;
 header.replaceChildren(el('div',{class:'app-header-title'},back||view==='chat'&&menu,el('div',{class:'app-header-copy'},el('h1',{title},title),el('small',{},view==='chat'&&kind&&el('span',{class:'header-identity kind-'+kind},labels[kind]),note))),actions);
}

async function loadThreads(more = false) {
  if (!session) return;
  if (threadListRequest) {
    refreshListAgain ||= !more;
    return threadListRequest;
  }
  const version = accountVersion;
  const limit = more && threadPage !== null ? threadPage + 50 : threadLimit;
  const job = (async () => {
    const merged = new Map();
    let next = 0, unread;
    while (next !== null && next < limit) {
      const result = await request('/api/chat/threads?offset=' + next + '&limit=' + Math.min(300, limit - next));
      if (version !== accountVersion) return;
      for (const item of result.items) merged.set(item.id, item);
      next = result.nextOffset;
      unread = result.totalUnread;
    }
    threads = [...merged.values()];
    android?.read(threads);
    threadsLoaded = true;
    threadListError = false;
    threadLimit = limit;
    threadPage = next;
    if (!windowHidden()) drawSidebar();
    socialUI.updateBadge(threads, unread);
  })();
  threadListRequest = job;
  const moreButton = sidebar.querySelector('.more-threads');
  if (moreButton) moreButton.disabled = true;
  try { await job; }
  catch (error) {
    if (version === accountVersion) { threadListError = true; if (!windowHidden()) drawSidebar(); }
    throw error;
  }
  finally {
    if (threadListRequest === job) {
      threadListRequest = null;
      if (moreButton) moreButton.disabled = false;
      if (refreshListAgain) { refreshListAgain = false; scheduleThreads(); }
    }
  }
}
function scheduleThreads() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; loadThreads().catch(() => {}); }, 180);
}
function atLatest() {
  return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 96;
}
function updateLatestButton() {
  const pinned = atLatest();
  if (pinned) newWhileReading = 0;
  jumpToLatest.hidden = pinned || !messageOrder.length || view !== 'chat';
  const copy = newWhileReading ? '查看新消息（' + newWhileReading + '）' : '回到最新';
  if (jumpToLatest.textContent !== copy) jumpToLatest.textContent = copy;
}
function scrollToBottom() {
  if (scrollFrame || windowHidden() || view !== 'chat') return;
  const id = activeThread?.id;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    if (windowHidden() || view !== 'chat' || activeThread?.id !== id) return;
    conversation.scrollTop = conversation.scrollHeight;
    updateLatestButton();
    markRead();
  });
}
jumpToLatest.onclick = scrollToBottom;
conversation.addEventListener('scroll', () => {
  updateLatestButton();
  if (atLatest()) markRead();
}, { passive: true });
function markRead() {
  clearTimeout(readTimer);
  if (!readPending || catchingUp || !activeThread || pendingThreadId || view !== 'chat' || android && !android.isReading() || windowHidden() || !document.hasFocus() || !atLatest()) return;
  const id = activeThread.id, version = routeVersion;
  readTimer = setTimeout(async () => {
    if (routeVersion !== version || pendingThreadId || android && !android.isReading() || windowHidden() || !document.hasFocus() || !atLatest()) return;
    const through = messageOrder.at(-1);
    if (!through) return;
    readPending = false;
    try { await request('/api/chat/threads/' + id + '/read?through=' + through, { method: 'POST' }); }
    catch { if (routeVersion === version) readPending = true; }
  }, 250);
}
function resetTimeline() {
  timelineCursor = null;
  oldestMessageDate = '';
  olderRequest?.abort(); olderRequest = null;
  messageNodes.clear(); messageOrder.length = 0; generating.clear();
  before = null; loadingOlder = false; readPending = false; catchingUp = false; newWhileReading = 0;
  cancelAnimationFrame(scrollFrame); scrollFrame = null;
  cancelAnimationFrame(messageFrame); messageFrame = null;
  list.replaceChildren(); jumpToLatest.hidden = true;
}
const renderHandlers = {
  account: () => session, request, showSection: section => navigate('library', { section }), setInput,
  retry: async item => {
    const id = activeThread?.id;
    try { await request('/api/chat/threads/' + id + '/retry', { method: 'POST', json: { messageId: item.id } }); }
    catch (error) { toast(error.message, 'error'); }
  },
  confirmAction,
};
function upsert(item) {
  if (retentionCutoff && item.createdAt <= retentionCutoff) return false;
  const previous = messageNodes.get(item.id);
  if (previous) {
    const old = previous.data;
    const stale = old.revision && item.revision ? old.revision > item.revision : old.updatedAt > item.updatedAt ||
      old.updatedAt === item.updatedAt && old.status === 'complete' && item.status === 'generating';
    if (stale) return false;
    if (old.updatedAt === item.updatedAt && old.status === item.status && old.body === item.body && old.senderName === item.senderName && old.senderAvatar === item.senderAvatar) return false;
    previous.data = item;
    previous.view.update(item);
  } else {
    list.querySelector('.conversation-welcome')?.remove();
    const rendered = messageView(item, renderHandlers); messageNodes.set(item.id, { data: item, view: rendered });
    let low = 0, high = messageOrder.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (messageOrder[middle] < item.id) low = middle + 1;
      else high = middle;
    }
    const next = messageNodes.get(messageOrder[low]);
    messageOrder.splice(low, 0, item.id);
    list.insertBefore(rendered.node, next?.view.node || null);
  }
  if (!oldestMessageDate || item.createdAt < oldestMessageDate) oldestMessageDate = item.createdAt;
  if (item.status === 'generating' && item.metadata?.requestedBy === session.key) generating.add(item.id);
  else generating.delete(item.id);
  if (item.status === 'complete' && item.senderKey !== session.key) readPending = true;
  return true;
}
function applyRetention(cutoff) {
  if (typeof cutoff !== 'string' || cutoff <= retentionCutoff) return;
  retentionCutoff = cutoff;
  if (!oldestMessageDate || oldestMessageDate > cutoff) return;
  oldestMessageDate = '';
  let count = 0;
  for (const id of messageOrder) {
    const entry = messageNodes.get(id), created = entry.data.createdAt;
    if (created > cutoff) {
      messageOrder[count++] = id;
      if (!oldestMessageDate || created < oldestMessageDate) oldestMessageDate = created;
    } else {
      entry.view.node.remove(); messageNodes.delete(id); pendingMessages.delete(id); generating.delete(id);
    }
  }
  messageOrder.length = count;
  if (session) reflectComposer();
  if (!messageNodes.size && !before && view === 'chat' && !pendingThreadId && !list.firstElementChild) welcome();
}
function applyMessages(items, { follow = true } = {}) {
  if (!items.length) return;
  const pinned = follow && atLatest();
  let changed = false;
  for (const item of items) {
    const fresh = !messageNodes.has(item.id);
    if (!upsert(item)) continue;
    changed = true;
    if (follow && !pinned && fresh && item.senderKey !== session.key) newWhileReading++;
  }
  if (!changed) return;
  reflectComposer();
  if (pinned) scrollToBottom();
  else updateLatestButton();
  markRead();
}
function flushMessageQueue() {
  if (messageFrame || view !== 'chat' || windowHidden() || !pendingMessages.size) return;
  messageFrame = requestAnimationFrame(() => {
    messageFrame = null;
    if (view !== 'chat' || windowHidden() || !session || pendingThreadId) return;
    const items = [];
    for (const { threadId, item } of pendingMessages.values()) if (threadId === activeThread?.id) items.push(item);
    pendingMessages.clear();
    applyMessages(items);
  });
}
function queueMessage(value) {
  // Hidden windows reconcile from SQLite when restored. Keep notifications and unread counts live.
  if (view !== 'chat' || windowHidden()) return;
  if (value.threadId !== activeThread?.id && value.threadId !== pendingThreadId) return;
  const pending = pendingMessages.get(value.item.id);
  if (!pending || (pending.item.revision && value.item.revision ? pending.item.revision <= value.item.revision
    : pending.item.updatedAt <= value.item.updatedAt)) pendingMessages.set(value.item.id, value);
  flushMessageQueue();
}
function welcome() {
  const prompts = activeThread && activeThread.kind !== 'ai' ? [] : [['music', '听一首歌', '查看音乐'], ['moon', '逛逛庭院', '查看首页'], ['mail', '聊聊今天', '今天想和你聊一会儿。']];
  list.replaceChildren(el('div', { class: 'conversation-welcome' }, el('div', { class: 'welcome-symbol' }, icon(activeThread?.kind === 'group' ? 'heart' : 'sparkle', 35)),
    el('h2', {}, activeThread?.kind === 'direct' ? '从一句问候开始。' : activeThread?.kind === 'group' ? '把相逢，留在这里。' : '今晚，想聊些什么？'),
    el('p', {}, activeThread?.kind==='ai'&&activeThread.members?.find(m=>m.kind==='ai')?.greeting || (activeThread && activeThread.kind !== 'ai' ? '消息仅对本会话成员可见。服务器保留最近30天聊天记录。' : '说说今天的心情，听一首熟悉的歌，或照看月光下的庭院。')),
    el('div', { class: 'welcome-prompts' }, prompts.map(([glyph, label, value]) => { const button = action(label, glyph); button.onclick = () => setInput(value); return button; }))));
}
function updateOlderButton() {
  let button = list.querySelector('.load-older');
  if (!before) { button?.remove(); return; }
  if (!button) {
    button = action('查看更早的消息', null, { class: 'button load-older' });
    button.onclick = loadOlder;
    list.prepend(button);
  }
  button.disabled = loadingOlder;
  const copy = loadingOlder ? '正在读取…' : '查看更早的消息';
  if (button.textContent !== copy) button.textContent = copy;
}
async function loadOlder() {
  if (!before || loadingOlder || pendingThreadId || !activeThread) return;
  const id = activeThread.id, version = routeVersion;
  const controller = olderRequest = new AbortController();
  loadingOlder = true; updateOlderButton();
  try {
    const result = await request('/api/chat/threads/' + id + '?before=' + before, { signal: signalWithTimeout(20000, controller.signal) });
    if (version !== routeVersion || id !== activeThread?.id) return;
    const oldHeight = conversation.scrollHeight;
    before = result.before;
    applyRetention(result.retainedAfter);
    applyMessages(result.messages, { follow: false });
    updateOlderButton();
    conversation.scrollTop += conversation.scrollHeight - oldHeight;
  } catch (error) {
    if (version === routeVersion && !controller.signal.aborted) toast(error.message, 'error');
  } finally {
    if (olderRequest === controller) { olderRequest = null; loadingOlder = false; updateOlderButton(); }
  }
}
async function loadThread(id, { signal, version = routeVersion, replace = false } = {}) {
  const result = await request('/api/chat/threads/' + id, { signal: signal || signalWithTimeout(20000) });
  if (version !== routeVersion || signal?.aborted || !session) return;
  const changed = activeThread?.id !== id;
  activeThread = result.item;
  if (changed || replace) {
    resetTimeline();
    before = result.before;
    if (changed) restoreDraft(id);
  }
  timelineCursor ??= result.syncCursor ?? null;
  applyRetention(result.retainedAfter);
  applyMessages(result.messages, { follow: !changed });
  updateOlderButton();
  if (!messageNodes.size && !list.firstElementChild) welcome();
  if (changed && view === 'chat') {
    const position = scrollPositions.get(id);
    if (position !== undefined) requestAnimationFrame(() => {
      if (version === routeVersion) conversation.scrollTop = position;
    });
    else scrollToBottom();
  }
}
async function refreshActiveThread() {
  if (!session || view !== 'chat' || windowHidden() || !activeThread || pendingThreadId) return;
  if (threadRefresh) { threadRefresh.again = true; return; }
  const id = activeThread.id, version = routeVersion, known = messageOrder.at(-1);
  const controller = new AbortController();
  const job = { controller };
  threadRefresh = job; catchingUp = true;
  const valid = () => version === routeVersion && id === activeThread?.id && !controller.signal.aborted && !windowHidden();
  const path = '/api/chat/threads/' + id;
  const options = { signal: signalWithTimeout(20000, controller.signal) };
  try {
    if (timelineCursor !== null) {
      let more;
      do {
        const change = await request(path + '/sync?cursor=' + timelineCursor, options);
        if (!valid()) return;
        if (change.reset) { await loadThread(id, { signal: options.signal, version, replace: true }); break; }
        activeThread = change.item;
        applyRetention(change.retainedAfter);
        applyMessages(change.messages);
        timelineCursor = change.cursor;
        more = change.hasMore;
      } while (more && valid());
      drawHeader();
      return;
    }
    const result = await request(path, options);
    if (!valid()) return;
    applyRetention(result.retainedAfter);
    // If more than one page arrived while offline, fill the gap before applying the latest snapshot.
    const first = result.messages[0]?.id;
    let after = known;
    while (after && result.before && after < first) {
      const batch = await request(path + '?after=' + after, options);
      if (!valid()) return;
      applyMessages(batch.messages);
      after = batch.nextAfter;
    }
    activeThread = result.item;
    applyMessages(result.messages);
    timelineCursor = result.syncCursor ?? null;
    drawHeader();
  } catch (error) {
    if (valid() && error.status === 404) forgetThread(id);
  } finally {
    if (threadRefresh === job) {
      threadRefresh = null;
      catchingUp = false;
      markRead();
      if (job.again && valid()) scheduleActiveRefresh();
    }
  }
}
function scheduleActiveRefresh() {
  if (activeTimer || view !== 'chat' || windowHidden()) return;
  activeTimer = setTimeout(() => { activeTimer = null; void refreshActiveThread(); }, 180);
}
async function newAiThread() {
  if (pendingThreadId) return;
  const version = routeVersion;
  pendingThreadId = 'creating'; reflectComposer();
  try {
    const result = await request('/api/chat/threads', { method: 'POST', json: {}, key: crypto.randomUUID() });
    scheduleThreads();
    if (version === routeVersion) await navigate('chat', { threadId: result.item.id });
  } catch (error) { toast(error.message, 'error'); }
  finally { if (version === routeVersion) { pendingThreadId = null; reflectComposer(); } }
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
    let lastCreation;
    start.onclick = async () => { if (start.disabled) return; start.disabled = true; const version = routeVersion; try {
      let id = activeThread?.id;
      if (editing) await request('/api/chat/threads/' + id + '/members', { method: 'PUT', json: { members: [...selected] } });
      else {
        const json = { kind, title: kind === 'group' ? title.value.trim() || '星夜小聚' : '私聊', members: [...selected].sort() };
        const body = JSON.stringify(json);
        if (lastCreation?.body !== body) lastCreation = { body, key: crypto.randomUUID() };
        const result = await request('/api/chat/threads', { method: 'POST', json, key: lastCreation.key }); id = result.item.id;
      }
      scheduleThreads();
      if (version === routeVersion && dialog.contains(start)) { dialog.close(); await navigate('chat', { threadId: id }); }
    } catch (error) { showStatus(status, error.message, 'error'); } finally { start.disabled = false; } };
    openModal(editing ? '管理群成员' : kind === 'direct' ? '发起私聊' : '创建群聊', kind === 'group' && !editing && el('label', { class: 'field' }, el('span', {}, '群聊名称'), title),
      el('p', {}, editing ? '新增成员将收到邀请，取消勾选可移出群聊。' : kind === 'group' ? '可以先创建群聊；勾选的好友会收到邀请，接受后才加入。' : '选择一位已添加的好友。'), options,
      !items.length && el('p', {}, '还没有好友。可在通讯录搜索用户并发送申请。'), status, el('footer', { class: 'dialog-footer' }, start));
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
    await request('/api/chat/threads/' + thread.id, { method: 'DELETE' }); forgetThread(thread.id); scheduleThreads();
  });
}

function fitInput() {
  if (!textarea || view !== 'chat' || nativeTextareaSizing) return;
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(160, textarea.scrollHeight) + 'px';
}
function discardPreviews(files) {
  for (const entry of files) if (entry.preview) URL.revokeObjectURL(entry.preview);
}
function draftStorage(id) { return 'chat-input:' + session.key + ':' + id; }
function clearDraftStorage(id) {
  const path = draftStorage(id);
  localStorage.removeItem(path);
  if (android) localStorage.removeItem(path + ':state');
}
function saveDraft(draft) {
  try {
    if (draft.text) localStorage.setItem(draftStorage(draft.id), draft.text);
    else localStorage.removeItem(draftStorage(draft.id));
    if (android) {
      const key = draftStorage(draft.id) + ':state';
      if (draft.text || draft.files.length || draft.restoring) localStorage.setItem(key, JSON.stringify({ key: draft.key, mention: draft.mention, count: draft.count || draft.files.length }));
      else localStorage.removeItem(key);
    }
  } catch { /* The draft remains available in this window. */ }
}
async function cacheAndroidFiles(draft) {
  if (!android || !session) return;
  const path = draftStorage(draft.id);
  draft.count = draft.files.length;
  saveDraft(draft);
  try {
    const size = draft.files.reduce((total, entry) => total + entry.file.size, 0);
    await storeFiles(path, size <= attachmentBudget ? draft.files : []);
    if (size > attachmentBudget) throw Error('附件超出本机恢复容量，重启后需要重新选择。');
  } catch (error) { if (composerDraft === draft) toast(error.message || '此设备无法缓存选中的附件。', 'error'); }
}
function restoreDraft(id = '') {
  let draft = inputDrafts.get(id);
  if (!draft) {
    let text = '', state;
    const path = draftStorage(id);
    try { text = localStorage.getItem(path) || ''; if (android) state = JSON.parse(localStorage.getItem(path + ':state')); } catch {}
    draft = { id, text, files: [], mention: false, key: crypto.randomUUID(), error: '', progress: null };
    if (state && /^[0-9a-f-]{36}$/i.test(state.key)) {
      draft.key = state.key; draft.mention = state.mention === true;
      draft.count = Number.isSafeInteger(state.count) ? Math.min(8, Math.max(0, state.count)) : 0;
      if (draft.count) {
        draft.restoring = true;
        const actor = accountVersion;
        const recover = draft;
        void readFiles(path).catch(() => []).then(files => {
          if (accountVersion !== actor || inputDrafts.get(id) !== recover) return;
          recover.restoring = false;
          recover.files = files.map(entry => ({ ...entry, preview: entry.kind === 'image' ? URL.createObjectURL(entry.file) : null }));
          if (recover.files.length !== recover.count) recover.error = '有附件未能恢复。请重新选择后发送。';
          if (composerDraft === recover) { drawFiles(); reflectComposer(); }
        });
      }
    }
    inputDrafts.set(id, draft);
  }
  composerDraft = draft;
  textarea.value = draft.text;
  mention.checked = draft.mention;
  fileInput.value = '';
  drawFiles();
  drawUploadProgress();
  fitInput();
  reflectComposer();
}
function setInput(text) {
  if (!composerDraft || pendingThreadId || activeSendTicket?.draft === composerDraft) return;
  textarea.value = text;
  composerDraft.text = text;
  composerDraft.key = crypto.randomUUID();
  composerDraft.error = '';
  saveDraft(composerDraft);
  fitInput();
  reflectComposer();
}
function drawFiles() {
  const draft = composerDraft;
  fileList.replaceChildren(...draft.files.map((entry, index) => {
    const remove = iconButton('close', '移除附件 ' + entry.file.name);
    remove.onclick = () => {
      if (draft !== composerDraft || activeSendTicket?.draft === draft) return;
      discardPreviews([entry]); draft.files.splice(index, 1);
      draft.key = crypto.randomUUID(); draft.error = '';
      void cacheAndroidFiles(draft);
      drawFiles(); reflectComposer();
    };
    return el('div', { class: 'chat-attachment' }, entry.preview ? image(entry.preview, '', { width: 30, height: 30 }) : icon(entry.kind === 'audio' ? 'music' : 'mail', 15), el('span', {}, entry.file.name), remove);
  }));
}
function reflectComposer() {
  if (!composerDraft) return;
  const ownSend = activeSendTicket?.draft === composerDraft;
  const locked = Boolean(ownSend || pendingThreadId);
  sendButton.disabled = Boolean(activeSendTicket || pendingThreadId || composerDraft.restoring || (android && composerDraft.count > composerDraft.files.length) || (!textarea.value.trim() && !composerDraft.files.length));
  fileInput.disabled = attachButton.disabled = mention.disabled = locked || Boolean(composerDraft.restoring);
  if (android) textarea.readOnly = locked; else textarea.disabled = locked;
  const copy = ownSend ? '发送中' : '发送';
  if (sendButton.lastChild.textContent !== copy) sendButton.lastChild.textContent = copy;
  const allowMention = activeThread?.kind === 'group' && !session.astrbotConfigured && session.aiReady;
  mention.closest('label').hidden = !allowMention;
  const textHint = activeThread?.kind === 'direct' ? '给好友写条消息…' : activeThread?.kind === 'group' ? '给群里写条消息…' : '写下想说的话，或输入「查看音乐」…';
  if (textarea.placeholder !== textHint) textarea.placeholder = textHint;
  stopButton.hidden = !generating.size;
  const status = composerDraft.error || (composerDraft.restoring ? '正在恢复附件…' : pendingThreadId ? '正在打开会话…' : activeSendTicket && !ownSend ? '另一段对话正在发送，可继续编辑。' : '');
  if (composerStatus.textContent !== status) composerStatus.textContent = status;
  composerStatus.classList.toggle('has-error', Boolean(composerDraft.error));
}
function buildComposer() {
  textarea = el('textarea', { rows: 1, maxlength: 8000, 'aria-label': '聊天消息', placeholder: '写下想说的话…' });
  textarea.oninput = () => {
    composerDraft.text = textarea.value;
    composerDraft.key = crypto.randomUUID();
    composerDraft.error = '';
    saveDraft(composerDraft);
    const pinned = atLatest();
    fitInput();
    if (pinned) scrollToBottom();
    reflectComposer();
  };
  textarea.onkeydown = event => {
    if (event.key !== 'Enter' || event.shiftKey || android && !event.ctrlKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !sendButton.disabled) composer.requestSubmit();
  };
  fileInput = el('input', { type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.webp,.mp3,.wav,.ogg,.opus,.lrc,.txt', hidden: true, 'aria-label': '选择聊天附件' });
  fileInput.onchange = () => {
    const entries = [...fileInput.files];
    const draft = composerDraft;
    if (activeSendTicket?.draft === draft || pendingThreadId) return;
    try {
      if (draft.files.length + entries.length > 8) throw new Error('单条消息最多 8 个附件。');
      const prepared = entries.map((file) => { const suffix = file.name.split('.').at(-1).toLowerCase(), kind = ['wav', 'mp3', 'ogg', 'opus'].includes(suffix) ? 'audio' : ['lrc', 'txt'].includes(suffix) ? 'lyrics' : ['png', 'jpg', 'jpeg', 'webp'].includes(suffix) ? 'image' : null;
        if (!kind || !file.size || file.size > (kind === 'audio' ? 100_000_000 : kind === 'lyrics' ? 65536 : 8 * 1024 * 1024)) throw new Error(file.name + '：音频最大 100,000,000 字节；图片最大 8 MiB；LRC/TXT 最大 64 KiB。');
        return { file, kind, preview: null };
      });
      for (const entry of prepared) if (entry.kind === 'image') entry.preview = URL.createObjectURL(entry.file);
      draft.files.push(...prepared); draft.key = crypto.randomUUID(); draft.error = '';
      void cacheAndroidFiles(draft);
      drawFiles(); reflectComposer();
    } catch (error) { toast(error.message, 'error'); }
    finally { fileInput.value = ''; }
  };
  attachButton = iconButton('plus', '添加附件'); attachButton.onclick = () => fileInput.click();
  const help = iconButton('sparkle', '查看助理指令');
  help.onclick = () => openModal('助理指令', el('p', {}, '输入「查看音乐」「查看游戏」「查看猫猫图」，或用「播放 歌名」寻找歌曲。'),
    session.role === 'admin' && el('p', {}, '网站管理指令可在 AI 私聊中使用。输入 /帮助 可查看完整列表。'));
  mention = el('input', { type: 'checkbox', name: 'mentionAssistant' });
  mention.onchange = () => { composerDraft.mention = mention.checked; composerDraft.key = crypto.randomUUID(); if(android) saveDraft(composerDraft); };
  sendButton = action('发送', 'upload', { type: 'submit', class: 'button send-button', 'aria-label': '发送消息' });
  stopButton = action('停止回复', 'stop', { class: 'button stop-reply', hidden: true });
  stopButton.onclick = async () => {
    const id = activeThread?.id;
    if (!id || stopButton.disabled || pendingThreadId) return;
    stopButton.disabled = true;
    try { await request('/api/chat/threads/' + id + '/stop', { method: 'POST' }); }
    catch (error) { toast(error.message, 'error'); }
    finally { stopButton.disabled = false; }
  };
  fileList = el('div', { class: 'composer-files' }); progress = el('div', { class: 'composer-progress', role: 'status' }); composerStatus = el('span', { class: 'composer-status', role: 'status' });
  composer.replaceChildren(el('div', { class: 'composer-box' }, textarea, fileList, progress, el('div', { class: 'composer-toolbar' },
    el('div', { class: 'composer-tools' }, attachButton, help, fileInput, el('label', { class: 'mention-option', hidden: true }, mention, '请助理回复')),
    el('div', { class: 'composer-actions' }, stopButton, sendButton))),
    el('div', { class: 'composer-note' }, composerStatus, el('span', {}, android ? 'Ctrl + Enter 发送' : 'Enter 发送 · Shift + Enter 换行')));
  composer.onsubmit = sendMessage;
  restoreDraft();
}
function xhrUpload(entry, key, onProgress, actor, signal) {
  return new Promise((resolve, reject) => {
    if (session?.csrf !== actor.csrf || signal?.aborted) { reject(new Error('账号已变更，本次上传已停止。')); return; }
    const form = new FormData(); form.set('kind', entry.kind); form.set('file', entry.file);
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    xhr.open('POST', '/api/chat/files');
    xhr.responseType = 'json'; xhr.timeout = 900_000;
    xhr.setRequestHeader('X-CSRF-Token', actor.csrf);
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded, event.total, false); };
    xhr.upload.onload = () => onProgress(1, 1, true);
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve(xhr.response.item) : reject(new Error(xhr.response?.error?.message || '文件未保存，可以重试。'));
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('文件传输中断，输入和附件已保留。'));
    xhr.onloadend = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(form);
  });
}
function drawUploadProgress() {
  const value = composerDraft?.progress;
  if (!value) { if (progress.firstChild) progress.replaceChildren(); return; }
  let bar = progress.querySelector('progress');
  if (!bar) {
    bar = el('progress', { max: 100, 'aria-label': '附件整体上传进度' });
    progress.replaceChildren(el('span'), bar);
  }
  progress.firstChild.textContent = value.name + ' · ' + value.percent + '% · ' + (value.saving ? '正在保存' : '上传中') + ' · 整体 ' + value.overall + '%';
  bar.value = value.overall;
}
async function sendMessage(event) {
  event.preventDefault();
  if (activeSendTicket || pendingThreadId || !session || !composerDraft || android && sendButton.disabled) return;
  const draft = composerDraft, files = [...draft.files], key = draft.key, actor = session, version = accountVersion;
  const text = draft.text.trim() || (files.length ? '分享一些文件。' : '');
  if (!text) return;
  const mentionAssistant = !mention.closest('label').hidden && draft.mention;
  const controller = new AbortController(), ticket = { draft, controller };
  const valid = () => version === accountVersion && !controller.signal.aborted;
  const options = { signal: signalWithTimeout(45000, controller.signal) };
  activeSendTicket = ticket; draft.error = ''; reflectComposer();
  try {
    if (!draft.id) {
      const result = await request('/api/chat/threads', { ...options, method: 'POST', json: {}, key: key + '_thread' });
      if (!valid()) return;
      inputDrafts.delete('');
      const original = draftStorage('');
      draft.id = result.item.id;
      inputDrafts.set(draft.id, draft); saveDraft(draft);
      if (android) { void cacheAndroidFiles(draft).then(() => storeFiles(original, []).catch(() => {})); android.layout('chat', draft.id); }
      try { clearDraftStorage(''); } catch {}
      scheduleThreads();
      if (!activeThread && !pendingThreadId) {
        activeThread = { ...result.item, members: [{ key: actor.key, username: actor.username }] };
        writeRoute({ replace: true });
        drawHeader(); drawSidebar();
      }
    }
    const targetId = draft.id;
    const ids = []; const total = files.reduce((n, entry) => n + entry.file.size, 0); let completed = 0;
    for (let i = 0; i < files.length; i++) {
      if (!valid()) return;
      const entry = files[i];
      entry.uploaded ??= await xhrUpload(entry, key + '_file_' + i, (loaded, size, saving) => {
        if (!valid()) return;
        const percent = Math.min(100, Math.floor(loaded / size * 100));
        const overall = Math.min(100, Math.floor((completed + entry.file.size * loaded / size) / total * 100));
        draft.progress = { name: entry.file.name, percent, overall, saving };
        if (composerDraft === draft) drawUploadProgress();
      }, actor, controller.signal);
      ids.push(entry.uploaded.id); completed += entry.file.size;
      if (android) void cacheAndroidFiles(draft);
    }
    if (!valid()) return;
    const result = await request('/api/chat/threads/' + targetId + '/messages', {
      signal: signalWithTimeout(45000, controller.signal),
      method: 'POST', json: { text, attachmentIds: ids, mentionAssistant }, key,
    });
    if (!valid()) return;
    discardPreviews(draft.files);
    draft.files = []; draft.text = ''; draft.mention = false; draft.key = crypto.randomUUID(); draft.count = 0;
    saveDraft(draft);
    if (android) void cacheAndroidFiles(draft);
    if (composerDraft === draft) restoreDraft(targetId);
    if (activeThread?.id === targetId && view === 'chat' && !windowHidden()) {
      applyMessages(result.items); scrollToBottom();
    }
    scheduleThreads();
  } catch (error) {
    if (valid()) { draft.error = error.message + ' 草稿已保留。'; if (composerDraft !== draft) toast(draft.error, 'error'); }
  } finally {
    if (activeSendTicket === ticket) {
      activeSendTicket = null; draft.progress = null;
      if (composerDraft === draft) {
        drawUploadProgress();
        if (!android && view === 'chat' && !pendingThreadId) textarea.focus();
      }
      reflectComposer();
    }
  }
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

function writeRoute({ replace = false, threadId = activeThread?.id } = {}) {
  const url = new URL('/chat', location.origin);
  if (view !== 'chat') url.searchParams.set('view', view);
  if (threadId) url.searchParams.set('t', threadId);
  if (view === 'library') url.searchParams.set('section', section);
  if (view === 'settings' || view === 'software') url.searchParams.set('section', pageSection);
  if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search);
}
function setDesktopContext() {
  window.hoshifuruDesktop?.setContext?.({ threadId: view === 'chat' && !pendingThreadId ? activeThread?.id : null });
}
function forgetThread(id) {
  if (pendingThreadId === id) {
    foregroundRequest?.abort();
    pendingThreadId = null;
  }
  scrollPositions.delete(id);
  if (activeThread?.id !== id) return;
  threadRefresh?.controller.abort();
  activeThread = null;
  details.hidden = true;
  resetTimeline();
  restoreDraft();
  welcome();
  android?.layout(view, null);
  writeRoute({ replace: true });
  drawHeader(); drawThreadList(); setDesktopContext();
}
async function navigate(next, options = {}) {
  if (!session) return;
  if (!Object.hasOwn(panels, next)) next = 'chat';
  if (['manage', 'accounts', 'software'].includes(next) && session.role !== 'admin') {
    toast('此栏目仅管理员可用。', 'error'); next = 'chat';
  }
  if (next === 'accounts') { next = 'software'; options = { ...options, section: 'users' }; }
  const previousView = view, previousThreadId = activeThread?.id;
  if (view === 'chat' && previousThreadId) scrollPositions.set(previousThreadId, conversation.scrollTop);
  const version = ++routeVersion, isCurrent = () => Boolean(session && routeVersion === version);
  foregroundRequest?.abort(); foregroundRequest = null;
  if (olderRequest) { olderRequest.abort(); olderRequest = null; loadingOlder = false; updateOlderButton(); }
  threadRefresh?.controller.abort(); threadRefresh = null; catchingUp = false;
  pendingThreadId = null;
  clearTimeout(readTimer);
  if (dialog.open) dialog.close();
  void socialUI.contacts.close({ immediate: true });
  view = next;
  document.body.classList.toggle('wide-page', view !== 'chat');
  sidebar.hidden = view !== 'chat';
  details.hidden = true;
  if (view === 'settings') pageSection = Object.hasOwn(personalSections, options.section) ? options.section : 'profile';
  if (view === 'software') pageSection = Object.hasOwn(managementSections, options.section) ? options.section : 'overview';
  if (view === 'library') section = Object.hasOwn(sectionNames, options.section) ? options.section : 'music';
  for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== view;
  closeSidebar();
  const target = options.threadId || (options.fromHistory && view === 'chat' ? null : previousThreadId);
  if (view === 'chat' && target === null && activeThread) {
    activeThread = null;
    resetTimeline(); restoreDraft(); welcome();
  }
  if (view === 'chat' && target && target !== activeThread?.id) pendingThreadId = target;
  android?.layout(view, target, options);
  if (!pendingThreadId && !options.fromHistory) writeRoute();
  drawHeader(); drawSidebar(); reflectComposer(); setDesktopContext();
  if (pendingThreadId) {
    const controller = new AbortController();
    foregroundRequest = controller;
    try {
      await loadThread(target, { signal: signalWithTimeout(20000, controller.signal), version });
      if (!isCurrent()) return;
      if (!options.fromHistory) writeRoute();
    } catch (error) {
      if (!isCurrent() || controller.signal.aborted) return;
      toast(error.message, 'error');
      if (options.fromHistory) writeRoute({ replace: true });
    } finally {
      if (isCurrent() && foregroundRequest === controller) {
        foregroundRequest = null; pendingThreadId = null;
        android?.layout(view, activeThread?.id, options);
        drawHeader(); drawThreadList(); reflectComposer(); setDesktopContext();
      }
    }
  }
  if (!isCurrent()) return;
  if (view === 'chat') {
    if (!activeThread && !list.firstElementChild) welcome();
    fitInput();
    if (previousView !== 'chat' && target === previousThreadId && scrollPositions.has(target)) conversation.scrollTop = scrollPositions.get(target);
    updateLatestButton();
    flushMessageQueue();
    scheduleActiveRefresh();
    markRead();
  } else if (view === 'library') library.show(section);
  else if (view === 'manage') {
    adminModule ??= await import('./admin.js');
    if (!isCurrent()) return;
    if (adminOwner !== session.key) {
      adminOwner = session.key;
      await adminModule.mountAdmin({ connectWebsite: credentials => request('/api/chat/site/login', { method: 'POST', json: credentials }) });
    }
    if (isCurrent() && options.panel) adminModule.activateAdminPanel(options.panel);
  } else await pages.render(panels[view], view, pageSection, options.surface, isCurrent);
}
function setConnectionState(state) {
  connectionState = state;
  const offline = state === 'offline';
  connectionNotice.hidden = !offline;
  const live = document.querySelector('[data-connection-status]');
  if (live) live.textContent = { online: '实时消息已连接', connecting: '正在连接', offline: '实时消息已断开 · 正在重连' }[state];
}
async function checkSession() {
  if (!session) return;
  if (sessionRefresh) return sessionRefresh;
  const version = accountVersion;
  const job = request('/api/chat/session').then(value => {
    if (version !== accountVersion) return;
    if (value.key !== session.key) { showLogin(false, null, true); return; }
    session = value;
    applyRetention(value.retainedAfter);
    void renewSession();
    drawRail(); reflectComposer();
  }).catch(() => {});
  sessionRefresh = job;
  await job;
  if (sessionRefresh === job) sessionRefresh = null;
}
async function renewSession() {
  if (!session?.renewable || lastRenewAttempt && performance.now() - lastRenewAttempt < 10 * 60_000) return;
  const version = accountVersion;
  lastRenewAttempt = Math.max(1, performance.now());
  try {
    await request('/api/chat/session/refresh', { method: 'POST', signal: signalWithTimeout(12000) });
    if (version === accountVersion) android?.sessionRefreshed();
  } catch { if (version === accountVersion) lastRenewAttempt = 0; }
}
function openChatEvents() {
  if (!session || android && windowHidden()) return;
  clearTimeout(reconnectTimer);
  source?.close();
  const stream = source = new EventSource('/api/chat/events');
  stream.addEventListener('ready', event => {
    if (source !== stream || !session) return;
    applyRetention(JSON.parse(event.data).retainedAfter);
    reconnectDelay = 1000;
    setConnectionState('online');
    socialUI.connected();
    void checkSession();
    scheduleThreads();
    scheduleActiveRefresh();
  });
  stream.addEventListener('retention', event => {
    if (source !== stream || !session) return;
    applyRetention(JSON.parse(event.data).retainedAfter);
    void renewSession();
  });
  stream.addEventListener('message', event => {
    if (source !== stream || !session) return;
    const value = JSON.parse(event.data);
    if (retentionCutoff && value.item.createdAt <= retentionCutoff) return;
    if (android) android.showNotice(value, threads); else socialUI.notifyMessage(value);
    const notice = value.item.metadata?.noticeEventId;
    if (notice && !seenNotices.has(notice)) { seenNotices.add(notice); toast(value.item.metadata.questions ? '庭院收到新的来信，已放入「庭院来信」。' : '庭院更新已同步，批次清单已放入「庭院来信」。'); }
    queueMessage(value);
    if (value.item.status === 'complete') scheduleThreads();
  });
  stream.addEventListener('threads', event => {
    const value = JSON.parse(event.data);
    scheduleThreads();
    if (value.threadId === activeThread?.id && value.reason !== 'message') scheduleActiveRefresh();
  });
  for (const topic of ['social', 'profiles', 'agents']) {
    stream.addEventListener(topic, event => {
      const value = JSON.parse(event.data);
      if (topic === 'profiles' && value.key === session?.key) void checkSession();
      scheduleThreads();
      scheduleActiveRefresh();
      socialUI.reloadSurface(topic, value);
    });
  }
  stream.addEventListener('read', scheduleThreads);
  stream.addEventListener('deleted', event => { forgetThread(JSON.parse(event.data).id); scheduleThreads(); });
  stream.onerror = () => {
    if (source !== stream || !session) return;
    setConnectionState('offline');
    socialUI.connected(false);
    if (stream.readyState !== EventSource.CLOSED) return;
    // Chromium stops retrying after an HTTP error. Check session expiry, then reopen with backoff.
    void checkSession();
    reconnectTimer = setTimeout(openChatEvents, reconnectDelay);
    reconnectDelay = Math.min(15000, reconnectDelay * 2);
  };
}
connectionNotice.querySelector('button').onclick = openChatEvents;
function connect() {
  if (android && windowHidden()) return;
  setConnectionState('connecting');
  openChatEvents();
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
async function enter(attempt = ++loginAttempt) {
  const value = await request('/api/chat/session', { signal: signalWithTimeout(12000) });
  if (attempt !== loginAttempt) return;
  if (!value.key) throw new Error('聊天服务暂未就绪，请稍后重试。');
  session = value;
  accountVersion++;
  retentionCutoff = value.retainedAfter || '';
  view = 'chat';
  loginStage.hidden = true; loginStage.replaceChildren(); shell.hidden = false;
  buildComposer(); socialUI.start(); connect(); refreshWebsite(); trackRoute('/chat');
  void loadThreads().catch(error => toast(error.message, 'error'));
  const url = new URL(location.href); section = url.searchParams.get('section') || 'music';
  const wanted = url.pathname === '/chat/manage' ? 'manage' : url.searchParams.get('view') || 'chat';
  if(url.searchParams.get('t')&&wanted!=='chat')await loadThread(url.searchParams.get('t')).catch(()=>{});
  const saved = android?.restore();
  const restored = !url.search && wanted === 'chat' ? saved : null;
  try { await navigate(wanted, { threadId: url.searchParams.get('t') || restored?.thread, section:url.searchParams.get('section')||undefined, panel: url.searchParams.get('panel') || undefined, fromHistory: true, androidList: restored?.list }); }
  catch (error) { toast(error.message, 'error'); await navigate('chat'); }
  if (session) { android?.session(session); android?.read(threads); void renewSession(); }
}
addEventListener('popstate', () => {
  if (!session) return;
  const url = new URL(location.href);
  void navigate(url.searchParams.get('view') || 'chat', { threadId: url.searchParams.get('t'), section: url.searchParams.get('section'), fromHistory: true });
});
addEventListener('focus', () => {
  if (!session) return;
  void checkSession();
  scheduleThreads(); scheduleActiveRefresh(); void refreshWebsite();
  markRead();
});
addEventListener('online', () => { if (session && connectionState === 'offline') openChatEvents(); });
window.hoshifuruDesktop?.onOpenThread?.(id => { if (session) void navigate('chat', { threadId: id }); });
function onVisibilityChanged() {
  const hidden = windowHidden();
  document.documentElement.classList.toggle('page-hidden', hidden);
  if (hidden) {
    clearTimeout(readTimer);
    threadRefresh?.controller.abort();
    pendingMessages.clear();
    if (android) { clearTimeout(reconnectTimer); source?.close(); updates?.close(); source = updates = null; }
  } else if (session) {
    if (android && !source) { connect(); scheduleThreads(); }
    drawSidebar();
    flushMessageQueue();
    if (activeThread && view === 'chat' && !messageOrder.length) void refreshActiveThread();
    else scheduleActiveRefresh();
  }
}
document.addEventListener('visibilitychange', onVisibilityChanged);
window.hoshifuruDesktop?.onVisibility?.(hidden => {
  nativeHidden = hidden;
  onVisibilityChanged();
});
addEventListener('chat-auth-expired', () => void checkSession());
matchMedia('(max-width:760px)').addEventListener('change', () => closeSidebar());
if (android) android.bindSwipe(sidebar, delta => {
  const at = filterOrder.findIndex(([key]) => key === threadKind);
  if (filterOrder[at + delta]) chooseThreadKind(filterOrder[at + delta][0]);
});
if (!android && 'serviceWorker' in navigator) navigator.serviceWorker.register('/chat-worker.js', { scope: '/chat' }).catch(() => {});
setTimeout(() => document.querySelector('#app-boot')?.remove(), 950);
if (android) showLogin(false, null, true);
else enter().catch(error => showLogin(false, error));

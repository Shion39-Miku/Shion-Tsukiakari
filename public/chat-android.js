import { action, el, icon, image, showStatus, toast } from './ui.js';

export const androidHost = /\bTsukiakariAndroid\//.test(navigator.userAgent);

const defaults = { cards: true, sound: true, vibrate: false, groups: true, quiet: false, preview: false, background: false, reduce: false };
const kinds = { ai: 'AI', direct: '好友', group: '群聊' };
const threadPattern = /^[0-9a-f-]{36}$/i;

export function androidClient({ account, request, navigate, contacts, modal, confirm, active, visibility, refreshRead, logout }) {
  if (!androidHost) return null;
  document.body.classList.add('android-app');
  document.body.dataset.androidPane = 'list';
  document.head.append(el('link', { rel: 'stylesheet', href: '/chat-android.css' }));
  const tablet = matchMedia('(min-width: 740px)');
  const cards = el('aside', { class: 'android-notices', 'aria-label': '新消息提示', 'aria-live': 'polite' });
  document.body.append(cards);
  let port, queued = [], preferences = { ...defaults }, pageUpdate, pageDirty = false, cardTimer, owner, shownThread, currentView = 'chat';
  const seen = new Set();

  function send(type, fields = {}) {
    const data = JSON.stringify({ type, ...fields });
    if (port) port.postMessage(data);
    else { queued.push(data); if (queued.length > 20) queued.shift(); }
  }

  addEventListener('message', event => {
    if (event.data !== 'tsukiakari:connect' || !event.ports[0] || port) return;
    port = event.ports[0];
    port.onmessage = incoming => {
      let reply;
      try { reply = JSON.parse(incoming.data); } catch { return; }
      if (reply.type === 'visible') visibility(!reply.value);
      if (reply.type === 'thread' && account() && threadPattern.test(reply.value)) void navigate('chat', { threadId: reply.value });
      if (reply.type === 'farewell' && account()) void navigate('settings', { section: 'farewell' });
      if (reply.type === 'status') { pageDirty = false; if (pageUpdate) pageUpdate(preferences); toast(String(reply.value)); }
      if (reply.type !== 'preferences') return;
      preferences = { ...defaults, ...reply.value };
      document.documentElement.classList.toggle('android-reduce', preferences.reduce);
      if (!pageDirty) pageUpdate?.(preferences);
    };
    port.start(); send('ready');
    for (const data of queued) port.postMessage(data);
    queued = [];
  });

  function restore() {
    try {
      const previous = JSON.parse(localStorage.getItem('android-route:' + account()?.key));
      return threadPattern.test(previous?.thread) ? previous : null;
    } catch { return null; }
  }

  function layout(view, id, options = {}) {
    currentView = view;
    shownThread = id;
    const previous = document.body.dataset.androidPane;
    const pane = view !== 'chat' ? 'page' : options.androidList || !id ? 'list' : 'thread';
    document.body.dataset.androidPane = pane;
    if (previous !== pane && !tablet.matches) {
      TsukiakariDialogs.slide(document.querySelector(pane === 'list' ? '#app-sidebar' : '.app-workspace'), pane === 'list' ? -1 : 1);
    }
    try {
      if (account() && view === 'chat' && id) localStorage.setItem('android-route:' + account().key, JSON.stringify({ thread: id, list: pane === 'list' }));
    } catch {}
    refreshRead();
  }

  const list = () => navigate('chat', { androidList: true });

  function rail(element) {
    if (!element.firstElementChild) {
      const buttons = [
        ['chat', '聊天', 'mail', list],
        ['contacts', '通讯录', 'heart', () => contacts()],
        ['settings', '我的', 'moon', () => navigate('settings', { section: 'home' })],
      ];
      const nav = el('nav', { class: 'android-nav', 'aria-label': '应用功能' });
      for (const [id, name, glyph, run] of buttons) {
        const button = el('button', { class: 'android-nav-item', type: 'button', 'data-android-nav': id, title: name }, icon(glyph, 21), el('span', {}, name));
        button.onclick = run; nav.append(button);
      }
      element.replaceChildren(image('/assets/brand/tsukiakari-64.png', '月明かり', { class: 'android-brand', width: 42, height: 42 }), nav);
    }
    element.querySelectorAll('[data-android-nav]').forEach(button => {
      const selected = button.dataset.androidNav === (currentView === 'chat' ? 'chat' : 'settings');
      if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
  }

  window.tsukiakariAndroidBack = () => {
    const open = Array.from(document.querySelectorAll('dialog[open]')).at(-1);
    if (open) { if (open.requestClose) open.requestClose(); else open.close(); return true; }
    const side = document.querySelector('#conversation-details:not([hidden])');
    if (side) { side.hidden = true; return true; }
    if (!account() || currentView === 'chat' && (tablet.matches || document.body.dataset.androidPane === 'list')) return false;
    document.activeElement?.blur();
    void list(); return true;
  };
  tablet.addEventListener('change', refreshRead);

  function bindSwipe(container, change) {
    let gesture;
    container.addEventListener('touchstart', event => {
      if (event.touches.length !== 1 || event.target.closest('input, textarea, button:not(.thread-button)')) { gesture = null; return; }
      const point = event.touches[0]; gesture = { x: point.clientX, y: point.clientY, time: performance.now() };
    }, { passive: true });
    container.addEventListener('touchcancel', () => { gesture = null; }, { passive: true });
    container.addEventListener('touchend', event => {
      const start = gesture; gesture = null;
      if (!start || performance.now() - start.time > 620) return;
      const point = event.changedTouches[0], dx = point.clientX - start.x, dy = point.clientY - start.y;
      if (Math.abs(dx) >= 65 && Math.abs(dx) > Math.abs(dy) * 1.7) change(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function showNotice(packet, known) {
    const message = packet.item;
    const viewer = account();
    if (!viewer || document.hidden || !message || message.status !== 'complete' || message.senderKey === viewer.key || !threadPattern.test(packet.threadId)) return;
    if (seen.has(message.id)) return;
    seen.add(message.id); if (seen.size > 200) seen.delete(seen.values().next().value);
    if (preferences.quiet || isReading() && active()?.id === packet.threadId) return;
    const summary = known.find(thread => thread.id === packet.threadId);
    const kind = summary?.kind || (message.role === 'assistant' ? 'ai' : null);
    if (!preferences.groups && (!kind || kind === 'group')) return;
    if (preferences.sound || preferences.vibrate) send('alert');
    if (!preferences.cards) return;
    const open = el('button', { type: 'button', class: 'android-notice-link' },
      icon('moon', 20), el('span', {}, el('strong', {}, summary?.title || message.senderName || '新消息'),
        el('small', {}, (kinds[kind] || '来信') + ' · 点按查看')));
    open.onclick = () => { cards.replaceChildren(); void navigate('chat', { threadId: packet.threadId }); };
    const dismiss = action('关闭', undefined, { 'aria-label': '关闭消息提示' });
    dismiss.onclick = () => cards.replaceChildren();
    cards.replaceChildren(el('article', { class: 'android-notice' }, open, dismiss));
    clearTimeout(cardTimer); cardTimer = setTimeout(() => cards.replaceChildren(), 4200);
  }

  function isReading() { return currentView === 'chat' && Boolean(shownThread) && (tablet.matches || document.body.dataset.androidPane === 'thread'); }

  function home(present) {
    const me = account(), entries = [
      ['个人资料', '设置名称、头像和在线状态', () => navigate('settings', { section: 'profile' })],
      ['设备通知', '提示卡片、系统通知与后台连接', () => navigate('settings', { section: 'device' })],
      ['月光庭院', '查看同步的音乐、游戏和猫猫图', () => navigate('library')],
    ];
    if (me.role === 'admin') entries.push(['网站管理', '草稿与发布', () => navigate('manage')], ['软件管理', '账号、群组与服务器 AI', () => navigate('software')]);
    const menu = entries.map(([name, note, run]) => {
      const entry = el('button', { type: 'button', class: 'android-setting-row' }, el('span', {}, el('strong', {}, name), el('small', {}, note)), icon('arrow', 18));
      entry.onclick = run;
      return entry;
    });
    const exit = action('退出登录', 'back'); exit.onclick = logout;
    present('我的', el('div', { class: 'android-profile-card' }, image(me.profile?.avatar?.url || '/assets/brand/tsukiakari-64.png', '', { width: 52, height: 52 }),
      el('span', {}, el('strong', {}, me.profile?.displayName || me.username), el('small', {}, me.role === 'admin' ? '管理员' : '月明かり'))),
    el('div', { class: 'android-setting-menu' }, menu), exit);
  }

  const settings = {
    cards: ['应用内提示卡片', '阅读其他会话时显示来源。'],
    sound: ['消息提示音', '使用月明かり的短提示音。'],
    vibrate: ['振动', '到达提醒可使用短振动。'],
    groups: ['群消息提醒', '关闭后仍可在会话列表查看群聊未读。'],
    quiet: ['免打扰', '暂停这台设备的到达提醒。'],
    preview: ['通知内容预览', '允许系统在其隐私设置许可时显示摘要。'],
    background: ['后台消息连接', '开启后以常驻通知维持消息连接。'],
    reduce: ['减少动效', '停用滑动和提示动画。'],
  };
  function notificationPage(present) {
    const inputs = {}, status = el('p', { class: 'inline-status', role: 'status' });
    const fields = Object.entries(settings).map(([key, [title, note]]) => {
      const input = inputs[key] = el('input', { type: 'checkbox', checked: preferences[key] });
      input.onchange = () => { pageDirty = true; };
      return el('label', { class: 'android-switch' }, el('span', {}, el('strong', {}, title), el('small', {}, note)), input);
    });
    const allow = action('通知权限说明', 'moon');
    allow.onclick = () => {
      const button = action('前往授权', 'check', { class: 'button button-primary' });
      button.onclick = () => {
        document.querySelector('#app-dialog')?.close();
        send(preferences.permissionNeeded && !preferences.notificationAllowed ? 'notificationPermission' : 'notificationSettings');
      };
      modal('接收月下的消息', el('p', {}, '系统通知可在离开聊天时提醒你。默认只显示有新消息。拒绝权限后仍可正常使用聊天。'), button);
    };
    const os = action('系统通知设置'); os.onclick = () => send('notificationSettings');
    const store = action('保存设备设置', 'check', { class: 'button button-primary' });
    store.onclick = () => send('savePreferences', { values: Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.checked])) });
    pageDirty = false;
    pageUpdate = value => {
      for (const [key, input] of Object.entries(inputs)) input.checked = value[key];
      showStatus(status, value.notificationAllowed ? '系统通知已授权。' : '系统通知待授权，前台仍可接收。');
    };
    pageUpdate(preferences); send('preferences');
    present('设备通知', el('p', { class: 'muted' }, '这些偏好只保存在本设备。好友、聊天、已读和个人资料继续由账号同步。'), fields, status,
      el('div', { class: 'form-actions' }, allow, os, store));
  }

  async function exportData(button, status) {
    const me = account();
    if (!me || button.disabled) return;
    button.disabled = true;
    showStatus(status, '正在整理个人资料…');
    try {
      const [profile, friends] = await Promise.all([request('/api/chat/profile'), request('/api/chat/friends')]);
      const threads = [];
      let offset = 0;
      do {
        const page = await request('/api/chat/threads?limit=100&offset=' + offset);
        threads.push(...page.items.map(({ id, title, kind, createdAt }) => ({ id, title, kind, createdAt })));
        offset = page.nextOffset;
      } while (Number.isInteger(offset) && offset > 0 && threads.length < 2500);
      if (me.key !== account()?.key) return;
      if (offset) throw Error('会话目录过大，暂时无法生成导出文件。');
      const prefix = 'chat-input:' + me.key + ':';
      const drafts = Object.keys(localStorage).filter(key => key.startsWith(prefix) && !key.endsWith(':state')).map(key => ({ thread: key.slice(prefix.length), text: localStorage.getItem(key) }));
      const item = profile.item;
      const info = { version: 1, profile: { id: item.id, username: item.username, displayName: item.displayName, status: item.status },
        friends: friends.items.map(friend => ({ id: friend.id, displayName: friend.displayName })), threads, drafts };
      send('export', { json: JSON.stringify(info) });
      showStatus(status, '选择保存位置后写入文件。');
    } catch (error) { showStatus(status, error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function farewell(present) {
    const back = action('返回应用', 'back', { class: 'button button-primary' }); back.onclick = list;
    const save = action('导出个人数据', 'upload');
    const status = el('p', { class: 'inline-status', role: 'status' });
    save.onclick = () => void exportData(save, status);
    const remove = action('卸载应用', 'trash');
    remove.onclick = () => confirm('前往系统卸载', '卸载会清除这台设备的缓存、登录和未同步草稿。账号与服务器聊天仍保留。', '前往系统', async () => send('uninstall'));
    present('暂别月光', el('section', { class: 'farewell-panel' },
      image('/assets/farewell.webp', '月下的詩音与知遥', { width: 760, height: 760, loading: 'eager' }),
      el('div', { class: 'farewell-scene' }, el('h3', {}, '先别道晚安…'),
        el('p', {}, el('strong', {}, '詩音'), '还有一句晚安，没来得及说。'),
        el('p', {}, el('strong', {}, '知遥'), '那就先替你留着，想回来时再说。'))),
    el('p', { class: 'muted' }, '导出内容包括个人资料、好友、会话目录和本机文字草稿。消息、附件及账号继续保存在服务器。卸载由安卓确认。'),
    status, el('div', { class: 'form-actions' }, back, save, remove));
  }

  function page(section, present) {
    pageUpdate = null;
    if (section === 'home') { home(present); return true; }
    if (section === 'device') { notificationPage(present); return true; }
    if (section === 'farewell') { farewell(present); return true; }
    if (section === 'connection') {
      const change = action('更改聊天服务地址'); change.onclick = () => send('connection');
      present('连接状态', el('p', { class: 'muted' }, '账号和聊天由当前连接的服务管理。变更服务后需在新服务重新登录。'), change);
      return true;
    }
    return false;
  }

  return {
    rail, bindSwipe, layout, list, page, isReading, restore, showNotice,
    session(value) { owner = value.key; send('session', { owner }); },
    logout(explicit) { owner = null; cards.replaceChildren(); clearTimeout(cardTimer); seen.clear(); pageUpdate = null; send('logout', { explicit }); },
    loginAction() { const button = action('更改聊天服务地址'); button.onclick = () => send('connection'); return button; },
    read(threads) { if (owner) send('readSummary', { threads: threads.filter(thread => !thread.unread).slice(0, 150).map(thread => thread.id) }); },
  };
}

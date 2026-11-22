import { action, el, iconButton, showStatus, toast } from './ui.js';
import { signalWithTimeout } from './request-signal.js';

const labels = { friends: '好友', search: '搜索用户', requests: '好友申请', invitations: '群邀请' };
const tabs = Object.keys(labels);
const empty = {
  friends: '还没有好友。可在「搜索用户」中发送好友申请。',
  search: '没有匹配的用户。请核对账号或用户 ID。',
  requests: '暂时没有好友申请。',
  invitations: '暂时没有群邀请。',
};
const endpoints = { friends: '/api/chat/friends', search: '/api/chat/users', requests: '/api/chat/friend-requests', invitations: '/api/chat/invitations' };
const cacheFor = 15_000;

export function createContacts({ request, account, personRow, openThread, refresh }) {
  const dialog = document.querySelector('#contacts-dialog');
  const surface = TsukiakariDialogs.bind(dialog, undefined, () => {
    const menu = document.querySelector('#app-header .mobile-menu');
    return menu?.getClientRects().length ? menu : document.querySelector('#conversation');
  });
  const tablist = el('div', { class: 'contacts-tabs', role: 'tablist', 'aria-label': '通讯录栏目' });
  const content = el('div', { class: 'contacts-panes' });
  const close = iconButton('close', '关闭对话框');
  const sections = new Map();
  let active = 'friends', query = '', timer, accountEpoch = 0, visit = 0;

  dialog.replaceChildren(el('div', { class: 'contacts-content' },
    el('header', { class: 'contacts-heading' }, el('h2', { id: 'contacts-title' }, '通讯录'), close), tablist, content));
  close.onclick = () => surface.close();
  dialog.addEventListener('close', () => { visit++; clearTimeout(timer); timer = null; });

  async function operate(button, status, work) {
    if (button.disabled) return;
    button.disabled = true;
    try { await work(); }
    catch (error) { showStatus(status, error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function openChat(id, stamp) {
    if (stamp !== visit || !dialog.open) return;
    void surface.close().then(closed => { if (closed && visit <= stamp + 1) return openThread(id); })
      .catch(error => toast(error.message, 'error'));
  }

  function chatButton(person, section) {
    const button = action('私聊', 'mail');
    button.onclick = () => operate(button, section.feedback, async () => {
      const stamp = visit;
      const result = await request('/api/chat/threads', { method: 'POST', json: { kind: 'direct', members: [person.key] }, key: crypto.randomUUID() });
      openChat(result.item.id, stamp);
    });
    return button;
  }

  function row(section, item) {
    const { name, feedback } = section;
    if (name === 'friends') return personRow(item, chatButton(item, section));
    if (name === 'search') {
      const { relationship } = item;
      const button = action({ self: '这是你', friends: '已添加', outgoing: '已申请', incoming: '处理申请', none: '添加好友' }[relationship]);
      button.disabled = ['self', 'outgoing'].includes(relationship);
      if (relationship === 'friends') return personRow(item, chatButton(item, section));
      button.onclick = () => relationship === 'incoming' ? select('requests', { focus: true })
        : operate(button, feedback, async () => {
          await request('/api/chat/friend-requests', { method: 'POST', json: { target: item.key }, key: crypto.randomUUID() });
          await load(section, { force: true });
        });
      return personRow(item, button);
    }

    const invite = name === 'invitations';
    const target = invite ? item.target : item.to;
    const incoming = target?.key === account()?.key;
    const counterpart = (incoming ? (invite ? item.inviter : item.from) : target) || { displayName: '已停用账号' };
    const buttons = [];
    if (item.state === 'pending') {
      const operations = incoming ? [['accept', invite ? '接受邀请' : '接受'], ['reject', invite ? '拒绝邀请' : '拒绝']]
        : [[invite ? 'revoke' : 'cancel', invite ? '撤销邀请' : '撤销申请']];
      for (const [verb, label] of operations) {
        const button = action(label);
        button.onclick = () => operate(button, feedback, async () => {
          await request(endpoints[name] + '/' + item.id + '/' + verb, { method: 'POST' });
          await Promise.all([load(section, { force: true }), refresh()]);
        });
        buttons.push(button);
      }
    }
    if (invite) {
      if (item.state === 'accepted' && incoming) {
        const button = action('打开群聊');
        button.onclick = () => openChat(item.threadId, visit);
        buttons.push(button);
      }
      const status = { pending: '待接受', accepted: '已加入', rejected: '已拒绝', revoked: '已撤销', expired: '已过期' }[item.state];
      return el('article', { class: 'invite-card' }, el('h3', {}, item.title),
        el('p', {}, (incoming ? counterpart.displayName + ' 邀请你' : '你邀请 ' + counterpart.displayName) + ' · ' + status),
        el('small', {}, '有效期至 ' + new Date(item.expiresAt).toLocaleString()), el('div', { class: 'person-actions' }, buttons));
    }
    const status = { pending: incoming ? '收到好友申请' : '等待对方接受', accepted: '已添加为好友', rejected: '已拒绝', canceled: '已撤销' }[item.state];
    return el('div', {}, el('small', { class: 'relation-state' }, status), personRow(counterpart, buttons));
  }

  function draw(section, items) {
    const { rows, list, placeholder } = section;
    const ids = new Set(items.map(item => item.id || item.key));
    for (const [id, entry] of rows) {
      if (!ids.has(id)) { entry.node.remove(); rows.delete(id); }
    }
    let next = list.firstElementChild;
    for (const item of items) {
      const id = item.id || item.key;
      const signature = JSON.stringify(item);
      let entry = rows.get(id);
      if (!entry || entry.signature !== signature) {
        const node = row(section, item);
        if (entry) {
          const focus = entry.node.contains(document.activeElement);
          entry.node.replaceWith(node);
          if (next === entry.node) next = node;
          if (focus) {
            const target = node.querySelector('button:not(:disabled)') || section.tab;
            target.focus({ preventScroll: true });
          }
        }
        entry = { node, signature };
        rows.set(id, entry);
      }
      if (entry.node !== next) list.insertBefore(entry.node, next);
      next = entry.node.nextElementSibling;
    }
    placeholder.textContent = empty[section.name];
    placeholder.hidden = items.length > 0;
    section.items = items;
  }

  function load(section, { force = false } = {}) {
    const term = section.name === 'search' ? query : '';
    if (section.name === 'search' && !term) return Promise.resolve();
    if (section.pending?.term === term) return section.pending.promise;
    if (!force && section.term === term && Date.now() - section.loaded < cacheFor) return Promise.resolve();
    section.pending?.controller.abort();
    const stamp = accountEpoch, controller = new AbortController();
    const pending = { term, controller, promise: null, version: section.version };
    section.pending = pending;
    section.panel.setAttribute('aria-busy', 'true');
    section.retry.hidden = true;
    showStatus(section.feedback, section.loaded ? '正在更新…' : '正在读取…');
    pending.promise = request(endpoints[section.name] + (term ? '?q=' + encodeURIComponent(term) : ''), {
      signal: signalWithTimeout(12000, controller.signal),
    }).then(result => {
      if (section.pending !== pending || stamp !== accountEpoch || pending.version !== section.version) return;
      draw(section, result.items);
      section.loaded = Date.now();
      section.term = term;
      showStatus(section.feedback, '');
    }).catch(error => {
      if (section.pending !== pending || stamp !== accountEpoch || controller.signal.aborted) return;
      section.retry.hidden = false;
      showStatus(section.feedback, section.loaded ? '更新失败，仍显示上次内容。' : error.message, 'error');
    }).finally(() => {
      if (section.pending === pending) {
        section.pending = null;
        section.panel.removeAttribute('aria-busy');
        if (dialog.open && section.name === active && pending.version !== section.version) void load(section);
      }
    });
    return pending.promise;
  }

  function select(name, { focus = false, update = true } = {}) {
    const direction = tabs.indexOf(name) - tabs.indexOf(active);
    active = name;
    for (const section of sections.values()) {
      const selected = section.name === name;
      section.tab.setAttribute('aria-selected', String(selected));
      section.tab.tabIndex = selected ? 0 : -1;
      section.panel.hidden = !selected;
    }
    const section = sections.get(name);
    if (focus) section.tab.focus({ preventScroll: true });
    if (dialog.open) TsukiakariDialogs.slide(content, direction);
    if (update) void load(section);
  }

  let searchInput;
  for (const [name, label] of Object.entries(labels)) {
    const tab = action(label, undefined, { id: 'contacts-tab-' + name, role: 'tab', 'aria-controls': 'contacts-' + name });
    const feedback = el('span', { class: 'inline-status', role: 'status' });
    const retry = action('重试读取', undefined, { hidden: true });
    const placeholder = el('p', { class: 'quiet-empty' }, name === 'search' ? '输入账号、名称或用户 ID 查找好友。' : '');
    const list = el('div', { class: 'contacts-list' });
    const panel = el('section', { id: 'contacts-' + name, role: 'tabpanel', 'aria-labelledby': tab.id, class: 'contacts-panel', tabindex: 0 },
      el('div', { class: 'contacts-feedback' }, feedback, retry), list, placeholder);
    const section = { name, tab, panel, feedback, retry, list, placeholder, rows: new Map(), loaded: 0, version: 0, items: [] };
    if (name === 'search') {
      searchInput = el('input', { 'aria-label': '用户ID、账号或名称', placeholder: '用户 ID、账号或名称', maxlength: 80 });
      const form = el('form', { class: 'contacts-search' }, searchInput, action('搜索', 'sparkle', { type: 'submit' }));
      form.onsubmit = event => {
        event.preventDefault();
        const value = searchInput.value.trim();
        if (value.length < 2) { showStatus(feedback, '请至少输入两个字符。', 'error'); return; }
        query = value;
        void load(section, { force: true });
      };
      panel.prepend(form);
    }
    tab.onclick = () => select(name);
    retry.onclick = () => load(section, { force: true });
    tablist.append(tab);
    content.append(panel);
    sections.set(name, section);
  }
  tablist.onkeydown = event => {
    const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    if (!Object.hasOwn(moves, event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (tabs.indexOf(active) + moves[event.key] + tabs.length) % tabs.length;
    select(tabs[index], { focus: true });
  };
  select(active, { update: false });

  return {
    open(name = active) {
      if (!dialog.open || dialog.hasAttribute('data-closing')) visit++;
      select(name);
      surface.open(sections.get(name).tab);
    },
    close: surface.close,
    update(topic, value) {
      if (topic === 'agents') return;
      for (const section of sections.values()) {
        if (topic === 'profiles' && section.loaded && !section.items.some(item =>
          [item.key, item.from?.key, item.to?.key, item.inviter?.key, item.target?.key].includes(value.key))) continue;
        section.loaded = section.loaded ? 1 : 0;
        section.version++;
      }
      if (!dialog.open || timer) return;
      timer = setTimeout(() => {
        timer = null;
        const section = sections.get(active);
        if (dialog.open && Date.now() - section.loaded >= cacheFor) void load(section);
      }, 230);
    },
    reset() {
      accountEpoch++;
      surface.close({ immediate: true });
      clearTimeout(timer); timer = null;
      query = searchInput.value = '';
      for (const section of sections.values()) {
        section.pending?.controller.abort();
        section.pending = null;
        section.loaded = 0;
        section.term = null;
        section.rows.clear(); section.items = [];
        section.list.replaceChildren();
        section.panel.scrollTop = 0;
        section.panel.removeAttribute('aria-busy');
        section.retry.hidden = true;
        section.placeholder.hidden = section.name !== 'search';
        showStatus(section.feedback, '');
      }
      select('friends', { update: false });
    },
  };
}

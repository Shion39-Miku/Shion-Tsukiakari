import { action, el, icon, iconButton, image, timeTag } from './ui.js';
import { playSiteSong, showAppImage, showSiteDetail } from './chat-library.js';
import * as player from './player.js';
import { personAvatar } from './chat-social.js';

function inline(text, handlers) {
  const fragment = document.createDocumentFragment(); let at = 0;
  for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g)) {
    fragment.append(text.slice(at, match.index)); at = match.index + match[0].length;
    if (match[1]) fragment.append(el('code', {}, match[1]));
    else if (match[2]) fragment.append(el('strong', {}, match[2]));
    else {
      let url; try { url = new URL(match[4], location.origin); } catch { /* Render invalid links as text. */ }
      if (!url || !['http:', 'https:'].includes(url.protocol)) { fragment.append(match[3]); continue; }
      const link = el('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, match[3]);
      if (url.origin === location.origin) link.onclick = (event) => {
        const section = url.pathname.slice(1) || 'home';
        if (!['home', 'about', 'music', 'games', 'cats', 'questions'].includes(section)) return;
        event.preventDefault();
        if (url.searchParams.has('id') && ['music', 'games', 'cats'].includes(section)) showSiteDetail(section, url.searchParams.get('id'), handlers.request);
        else handlers.showSection(section);
      };
      fragment.append(link);
    }
  }
  fragment.append(text.slice(at)); return fragment;
}

// Deliberately limited Markdown: all submitted/model text enters text nodes.
export function markdown(text, handlers) {
  const fragment = document.createDocumentFragment(); let at = 0;
  const paragraphs = (value) => { for (const line of value.split(/\n\s*\n/)) if (line) fragment.append(el('p', {}, inline(line, handlers))); };
  for (const match of text.matchAll(/```[\w-]*\n?([\s\S]*?)(?:```|$)/g)) {
    paragraphs(text.slice(at, match.index)); fragment.append(el('pre', {}, el('code', {}, match[1]))); at = match.index + match[0].length;
  }
  paragraphs(text.slice(at)); return fragment;
}

export function messageView(item, handlers) {
  const self = item.senderKey === handlers.account().key;
  let avatar = item.senderAvatar ? personAvatar({avatar:item.senderAvatar,displayName:item.senderName}) : el('span', { class: 'account-avatar', 'aria-hidden': true }, item.role === 'assistant' ? icon('sparkle', 17) : item.senderName.slice(0, 1).toUpperCase());
  const sender=el('span',{},item.senderName),identity=el('small',{class:'message-user-id',title:item.senderId||item.senderKey},(item.senderId||'').slice(-8));
  const bubble = el('div', { class: 'message-bubble' });
  const status = el('div', { class: 'message-status' });
  const content = el('div', { class: 'message-content' }, el('div', { class: 'message-caption' }, sender,identity,(item.ai||item.role==='assistant')&&el('span',{class:'ai-member-badge'},'AI'), timeTag(item.createdAt, true)), bubble, status);
  const node = el('article', { class: 'message' + (self ? ' is-self' : '') + (item.role === 'assistant' ? ' assistant' : ''), 'data-message-id': item.id, 'aria-label': item.senderName + '的消息' }, avatar, content);
  let finalMetadata, renderedBody, renderedStatus, renderedHint, retryButton;
  let avatarKey = (item.senderAvatar || '') + '|' + item.senderName;
  const details = el('div'); bubble.after(details);
  function drawExtras(current) {
    const meta = current.metadata || {};
    const signature = JSON.stringify([meta.attachments, meta.items, meta.category, meta.section, meta.questions, meta.drafts, meta.action]);
    if (signature === finalMetadata) return;
    finalMetadata = signature;
    details.replaceChildren();
    if (meta.attachments?.length) details.append(el('div', { class: 'message-attachments' }, meta.attachments.map((file) => {
      if (file.mime.startsWith('image/')) {
        const button = el('button', { class: 'chat-attachment', type: 'button', 'aria-label': '放大附件 ' + file.name }, image(file.url + '/thumb', '', { width: 48, height: 48 }), el('span', {}, file.name)); button.onclick = () => showAppImage({ ...file, url: file.url }, file.name); return button;
      }
      const link = el('a', { class: 'chat-attachment', href: file.url, download: file.name }, icon(file.kind === 'audio' ? 'music' : 'mail', 16), el('span', {}, file.name));
      if (file.kind === 'audio') { const play = iconButton('play', '播放附件 ' + file.name); play.onclick = () => player.toggle({ id: file.id, title: file.name, artist: current.senderName, audio: { id: file.id, url: file.url }, lyrics: '' }); return el('div', { class: 'chat-attachment' }, play, link); }
      return link;
    })));
    if (meta.items) details.append(el('div', { class: 'message-card-list' }, meta.items.map((entry) => {
      const media = entry.cover || entry.logo || entry.image;
      const open = meta.category === 'music' ? iconButton('play', '播放 ' + entry.title) : iconButton('expand', '查看 ' + (entry.title || '猫猫图'));
      open.onclick = () => meta.category === 'music' ? playSiteSong(entry.id, handlers.request) : showSiteDetail(meta.category, entry.id, handlers.request);
      const title = el('button', { type: 'button', class: 'result-title' }, entry.title || '猫猫图'); title.onclick = () => showSiteDetail(meta.category, entry.id, handlers.request);
      return el('div', { class: 'message-result' }, media && image(media, '', { width: 48, height: 48, sizes: '48px' }), el('div', { class: 'result-copy' }, title, el('small', {}, entry.artist || entry.genre || new Date(entry.createdAt).toLocaleDateString('zh-CN'))), open);
    })));
    if (meta.section) { const open = action('打开' + ({ music: '音乐分享', games: '游戏分享', cats: '猫猫图', about: '关于我', questions: '提问箱', home: '首页' }[meta.section] || '栏目'), 'expand'); open.onclick = () => handlers.showSection(meta.section); details.append(open); }
    if (handlers.account().role !== 'admin') return;
    if (meta.questions) details.append(el('div', { class: 'message-card-list' }, meta.questions.length ? meta.questions.map((q) => {
      const reply = action('填写答复', 'mail'); reply.onclick = () => handlers.setInput('/回复 ' + q.id + ' ');
      return el('div', { class: 'message-action' }, el('strong', {}, q.author), el('p', {}, q.question), el('small', {}, q.id), reply);
    }) : el('p', {}, '来信已经整理完毕。')));
    if (meta.drafts) details.append(el('div', { class: 'message-card-list' }, meta.drafts.length ? meta.drafts.map((draft) => {
      const sync = action('核对并同步', 'check'); sync.onclick = () => handlers.confirmAction({ type: 'sync', id: draft.draftId, version: draft.version, title: draft.title || draft.question || '站点修改' }, current, sync);
      return el('div', { class: 'message-action' }, el('p', {}, draft.title || draft.question || draft.category), el('small', {}, '已保存，待同步'), sync);
    }) : el('p', {}, '所有修改都已同步。')));
    if (meta.action) {
      const value = meta.action; const button = action(value.type === 'sync' ? '确认同步' : '确认保存', 'check', { class: 'button button-primary' });
      button.onclick = () => handlers.confirmAction(value, current, button);
      details.append(el('section', { class: 'message-action' }, el('strong', {}, value.type === 'sync' ? '待确认发布' : '待确认草稿'),
        el('pre', {}, value.reply || value.title || JSON.stringify(value.fields, null, 2)), button));
    }
  }
  function update(current) {
    if (sender.textContent !== current.senderName) {
      sender.textContent = current.senderName;
      node.setAttribute('aria-label', current.senderName + '的消息');
    }
    const id = (current.senderId || '').slice(-8);
    if (identity.textContent !== id) identity.textContent = id;
    identity.title = current.senderId || current.senderKey;
    const nextAvatarKey = (current.senderAvatar || '') + '|' + current.senderName;
    if (avatarKey !== nextAvatarKey) {
      const next = current.senderAvatar ? personAvatar({ avatar: current.senderAvatar, displayName: current.senderName }) : el('span',
        { class: 'account-avatar', 'aria-hidden': true }, current.role === 'assistant' ? icon('sparkle', 17) : current.senderName.slice(0, 1).toUpperCase());
      avatar.replaceWith(next);
      avatar = next;
      avatarKey = nextAvatarKey;
    }
    if (renderedStatus !== current.status || renderedBody !== current.body) {
      if (current.status === 'generating') {
        if (current.body) {
          if (bubble.firstChild?.nodeType === Node.TEXT_NODE) bubble.firstChild.data = current.body;
          else bubble.textContent = current.body;
        } else bubble.replaceChildren(el('span', { class: 'typing-dots', 'aria-label': '正在回复' }, el('i'), el('i'), el('i')));
      } else bubble.replaceChildren(markdown(current.body || (current.status === 'stopped' ? '已停止生成。' : '这次回复还没有文字。'), handlers));
    }
    const failed = current.status === 'failed' || current.status === 'stopped';
    const hint = current.status === 'generating' ? (current.metadata?.queued ? '等待回复…' : '正在写下回复…')
      : failed ? current.metadata?.error || '回复已停止。' : '';
    if (renderedStatus !== current.status || renderedHint !== hint) {
      status.textContent = hint;
      status.classList.toggle('error', current.status === 'failed');
      if (failed && current.metadata?.requestedBy === handlers.account().key) {
        retryButton = action('重试回复');
        retryButton.onclick = async () => {
          if (retryButton.disabled) return;
          const button = retryButton;
          button.disabled = true;
          try { await handlers.retry(current); }
          finally { button.disabled = false; }
        };
        status.append(retryButton);
      }
    }
    renderedStatus = current.status;
    renderedBody = current.body;
    renderedHint = hint;
    drawExtras(current);
  }
  update(item); return { node, update };
}

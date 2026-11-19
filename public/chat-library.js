import { action, el, icon, iconButton, image, site, timeTag, toast, reducedMotion } from './ui.js';
import * as player from './player.js';
import { renderLyrics } from './lyrics.js';
import { track, trackRoute } from './activity.js';

export const sectionNames = { home: '首页', about: '关于我', music: '音乐分享', games: '游戏分享', cats: '猫猫图', questions: '提问箱' };
const glyphs = { home: 'moon', about: 'heart', music: 'music', games: 'game', cats: 'cat', questions: 'mail' };
let unsubscribe;
const details = document.querySelector('#detail-dialog'), viewer = document.querySelector('#image-dialog');
details.addEventListener('close', () => { unsubscribe?.(); unsubscribe = null; });

export function showAppImage(media, label = '查看原图') {
  const picture = image(media.url, label, { class: 'app-image-fit', loading: 'eager' });
  const viewport = el('div', { class: 'app-image-viewport', tabindex: 0, 'aria-label': '可缩放图片' }, picture);
  let zoom = 1, pinch;
  const value = el('output', {}, '100%');
  const set = (next) => { zoom = Math.max(1, Math.min(4, next)); picture.style.width = (zoom * 100) + '%'; picture.style.maxWidth = zoom === 1 ? '100%' : 'none'; picture.style.maxHeight = zoom === 1 ? '65dvh' : 'none'; value.textContent = Math.round(zoom * 100) + '%'; };
  const minus = iconButton('minus', '缩小图片'), plus = iconButton('plus', '放大图片'), reset = action('还原尺寸');
  minus.onclick = () => set(zoom / 1.3); plus.onclick = () => set(zoom * 1.3); reset.onclick = () => set(1);
  const distance = (touches) => Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY);
  viewport.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { zoom, distance: distance(e.touches) }; }, { passive: true });
  viewport.addEventListener('touchmove', (e) => { if (e.touches.length === 2 && pinch?.distance) { e.preventDefault(); set(pinch.zoom * distance(e.touches) / pinch.distance); } }, { passive: false });
  viewport.addEventListener('touchend', () => { pinch = null; });
  const close = iconButton('close', '关闭图片'); close.onclick = () => viewer.close();
  viewer.replaceChildren(el('div', { class: 'dialog-frame' }, el('header', { class: 'dialog-bar' }, el('h2', { id: 'image-title' }, label), close), viewport,
    el('div', { class: 'app-image-tools' }, minus, value, plus, reset, el('a', { class: 'button', href: media.url, target: '_blank', rel: 'noopener' }, '原图'))));
  if (!viewer.open) viewer.showModal();
  if (media.id) track('image.open', media.id);
}

export async function playSiteSong(id, request) {
  try { const { item } = await request('/api/public/music/' + id); await player.toggle(item); }
  catch (error) { toast(error.message, 'error'); }
}

export async function showSiteDetail(category, id, request) {
  try {
    const { item } = await request('/api/public/' + category + '/' + id);
    if (category === 'cats') { showAppImage(item.image, new Date(item.createdAt).toLocaleString('zh-CN')); return; }
    unsubscribe?.(); unsubscribe = null;
    const close = iconButton('close', '关闭详情'); close.onclick = () => details.close();
    const cover = category === 'music' ? item.cover : item.logo;
    const art = cover && el('button', { class: 'detail-art-button', type: 'button', 'aria-label': '查看高清封面' }, image(cover.url, item.title, { class: 'detail-art', loading: 'eager' }));
    if (art) art.onclick = () => showAppImage(cover, item.title);
    const frame = el('div', { class: 'dialog-frame' }, el('header', { class: 'dialog-bar' }, el('span', { class: 'eyebrow' }, category === 'music' ? 'THE NIGHT RADIO' : 'AFTER DARK ARCADE'), close),
      el('div', { class: 'detail-head' }, art, el('div', {}, el('p', { class: 'eyebrow' }, item.artist || item.genre), el('h2', { id: 'detail-title' }, item.title), item.translation && el('p', { class: 'translation' }, item.translation))),
      el('p', { class: 'detail-note' }, item.note));
    if (category === 'music') {
      const lyrics = renderLyrics(item.lyrics || ''); const playback = player.detailPlayback(item, lyrics.update); unsubscribe = playback.unsubscribe;
      frame.append(playback.controls, el('div', { class: 'detail-text' }, el('h3', {}, '完整歌词'), lyrics.view));
    } else {
      frame.append(el('p', { class: 'prose' }, item.description), el('div', { class: 'game-images' }, item.images.map((media, n) => {
        const button = el('button', { class: 'game-image', type: 'button', 'aria-label': '放大游戏图片 ' + (n + 1) }, image(media, '', { sizes: '320px' }));
        button.onclick = () => showAppImage(media, item.title); return button;
      })));
    }
    details.replaceChildren(frame); if (!details.open) details.showModal(); track('card.open', id);
  } catch (error) { toast(error.message, 'error'); }
}

export function createLibrary({ root, request, changeSection, account }) {
  let section, filter = '', requestVersion = 0, lastItems = [];
  const panels = new Map();
  const tabs = el('nav', { class: 'app-section-tabs', 'aria-label': '网站栏目' });
  const heading = el('header', { class: 'app-section-heading' });
  const content = el('div');
  root.replaceChildren(heading, tabs, content);
  for (const [key, title] of Object.entries(sectionNames)) {
    const button = action(title, glyphs[key], { role: 'tab', 'aria-selected': 'false' }); button.onclick = () => changeSection(key); button.dataset.section = key; tabs.append(button);
  }
  function letters(items) {
    return el('div', { class: 'app-letter-list' }, items.length ? items.map((q) => el('article', { class: 'app-letter' },
      el('header', {}, el('span', {}, q.author), timeTag(q.publishedAt)), el('h3', {}, q.question), el('p', {}, q.reply))) : el('p', { class: 'app-empty' }, '月色正好，暂时还没有公开的回信。'));
  }
  function questionForm() {
    const text = el('textarea', { rows: 4, maxlength: 1200, required: true, 'aria-label': '想说的话', placeholder: '有什么想问的，留在这里。' });
    const anonymous = el('input', { type: 'checkbox', checked: true, name: 'anonymous' });
    const name = el('input', { maxlength: 40, value: account()?.username || '', 'aria-label': '署名', hidden: true });
    anonymous.onchange = () => { name.hidden = anonymous.checked; };
    const button = action('提交提问', 'mail', { type: 'submit', class: 'button button-primary' });
    const status = el('p', { class: 'inline-status', role: 'status' });
    const form = el('form', { class: 'account-form' }, el('label', { class: 'field' }, el('span', {}, '留一封信'), text),
      el('label', { class: 'check-label' }, anonymous, '匿名投稿'), name, el('div', { class: 'form-actions' }, button, status));
    let key = crypto.randomUUID();
    form.onsubmit = async (event) => { event.preventDefault(); button.disabled = true; try {
      await request('/api/public/questions', { method: 'POST', json: { question: text.value, anonymous: anonymous.checked, author: name.value }, key });
      text.value = ''; key = crypto.randomUUID(); status.textContent = '已收到，等待回复';
    } catch (error) { status.textContent = error.message; } finally { button.disabled = false; } };
    return form;
  }
  function about() {
    const picture = el('button', { class: 'portrait-open', type: 'button', 'aria-label': '查看关于我的完整立绘' }, image(site.about.portraitMedia || site.about.portrait, site.about.portraitAlt));
    picture.onclick = () => showAppImage(site.about.portraitMedia || { url: site.about.portrait }, '詩音与知遥');
    const copy = el('div', {}, el('h3', {}, '你好，我是詩音。'), el('p', {}, site.about.intro), el('h3', {}, '喜欢与不喜欢'), el('p', {}, '喜欢：' + site.about.likes.join('、') + '\n不喜欢：' + site.about.dislikes.join('、')),
      el('h3', {}, '最近在听 · 最近在玩'), el('p', {}, site.about.listening + '\n' + site.about.playing), el('h3', {}, '建站缘由'), el('p', {}, site.about.why));
    const characters = el('div', { class: 'characters' }, (site.characters || []).map((c) => el('article', { class: 'character-card' },
      el('header', { class: 'character-heading' }, el('p', { class: 'eyebrow' }, c.alias), el('h3', {}, c.name)), el('p', { class: 'prose' }, c.summary),
      el('div', { class: 'character-gallery' }, c.images.map((entry) => { const button = el('button', { class: 'character-picture', type: 'button', 'aria-label': entry.label }, image(entry.media, entry.label), el('span', {}, entry.label)); button.onclick = () => showAppImage(entry.media, entry.label); return button; })),
      el('p', { class: 'prose' }, c.appearance), el('p', { class: 'prose' }, [c.human, c.divine, c.world].filter(Boolean).join('\n')))));
    return el('div', {}, el('div', { class: 'app-about-layout' }, picture, copy), characters);
  }
  function drawCards(container, category, items) {
    container.replaceChildren(...(items.length ? items.map((item) => {
      const media = category === 'music' ? item.cover : category === 'games' ? item.logo : item.image;
      const open = el('button', { class: 'app-art-button', type: 'button', 'aria-label': '打开' + (item.title || '猫猫原图') }, media ? image(media, '', { sizes: '(min-width: 1400px) 230px, (min-width: 760px) 28vw, 43vw', width: 360, height: 260 }) : icon(glyphs[category], 38));
      open.onclick = () => showSiteDetail(category, item.id, request);
      if (category === 'cats') return el('article', { class: 'app-media-card app-cat-card' }, open, timeTag(item.createdAt, true));
      const play = category === 'music' ? action('播放', 'play') : action('查看', 'expand');
      play.onclick = () => category === 'music' ? playSiteSong(item.id, request) : showSiteDetail(category, item.id, request);
      return el('article', { class: 'app-media-card' }, open, el('div', { class: 'app-card-copy' }, el('h3', {}, item.title), item.translation && el('p', {}, item.translation), el('p', {}, item.note), el('div', { class: 'app-card-bottom' }, el('small', {}, item.artist || item.genre), play)));
    }) : [el('p', { class: 'app-empty' }, '这一页的收藏还在路上。')]));
  }
  async function refresh() {
    if (!section) return; const version = ++requestVersion, current = section;
    try {
      if (['music', 'games', 'cats'].includes(current)) {
        const { items } = await request('/api/public/' + current); if (version !== requestVersion) return;
        const panel = panels.get(current); if (JSON.stringify(items) === panel.fingerprint) return; panel.fingerprint = JSON.stringify(items); lastItems = items;
        panel.filters?.replaceChildren();
        const values = ['全部', ...new Set(items.map((item) => current === 'music' ? item.artist : item.genre).filter(Boolean))];
        if (filter && !values.includes(filter)) filter = '';
        const draw = () => { drawCards(panel.grid, current, filter ? items.filter((item) => (current === 'music' ? item.artist : item.genre) === filter) : items); panel.filters?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.value === filter))); };
        if (panel.filters) for (const value of values) { const button = action(value, null, { value: value === '全部' ? '' : value }); button.onclick = () => { filter = button.value; draw(); }; panel.filters.append(button); }
        draw();
      } else if (current === 'about') panels.get(current).node.replaceChildren(about());
      else {
        const { items } = await request('/api/public/questions'); if (version !== requestVersion) return;
        const panel = panels.get(current); if (JSON.stringify(items) === panel.fingerprint) return; panel.fingerprint = JSON.stringify(items); panel.letters.replaceChildren(letters(items));
        if (current === 'home') {
          const releases = await request('/api/public/releases'); if (version !== requestVersion) return;
          panel.updates.replaceChildren(el('h3', {}, '最近更新'), releases.items.length ? releases.items.slice(0, 4).map((r) => el('article', { class: 'app-letter' }, timeTag(r.syncedAt || r.publishedAt || r.createdAt), el('p', {}, r.summary || '庭院添了一些新的收藏。'))) : el('p', {}, '今夜安静，等下一次更新。'));
        }
      }
    } catch (error) { if (version === requestVersion) toast(error.message, 'error'); }
  }
  function show(next) {
    if (!Object.hasOwn(sectionNames, next)) next = 'music'; const changed = section !== next; section = next;
    heading.replaceChildren(el('p', { class: 'eyebrow' }, 'SHION’S MOONLIGHT GARDEN'), el('h2', {}, sectionNames[section]), el('p', {}, '收藏与网站实时相连。让旋律与故事，陪你多坐一会儿。'));
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.section === section)));
    if (!panels.has(section)) {
      const node = el('section', { class: 'app-library-panel' }); const panel = { node };
      if (['music', 'games', 'cats'].includes(section)) {
        panel.filters = section !== 'cats' ? el('div', { class: 'filters', 'aria-label': section === 'music' ? '按歌手筛选' : '按游戏类型筛选' }) : null; panel.grid = el('div', { class: 'app-catalog-grid' }); node.append(...[panel.filters, panel.grid].filter(Boolean));
      } else if (section !== 'about') {
        panel.letters = el('div');
        if (section === 'home') { panel.updates = el('div', { class: 'app-letter-list' }); node.append(el('p', { class: 'prose' }, site.motto), panel.updates, el('h3', {}, '月下的回信')); }
        if (section === 'questions') node.append(questionForm()); node.append(panel.letters);
      }
      panels.set(section, panel); content.append(node);
    }
    panels.forEach((p, name) => { p.node.hidden = name !== section; });
    if (changed) { filter = ''; panels.get(section).fingerprint = null; root.scrollTop = 0; trackRoute(section === 'home' ? '/' : '/' + section); }
    refresh();
  }
  return { show, refresh, reset() { panels.clear(); content.replaceChildren(); section = null; lastItems = []; }, get section() { return section; } };
}

import {
  action, api, bindFavicon, brand, el, empty, icon, iconButton, image, mark, showStatus, site, timeTag, toast,
} from './ui.js';
import { fileProgressView, sendMultipart } from './uploads.js';
import { workroom } from './workroom.js';
import { draftControls, globalDraftBar } from './draft-controls.js';
import { materialPicker } from './materials.js';
import { readAudioTags, readLrcTags } from './metadata.js';

const embedded = document.body.classList.contains('chat-body');
const main = document.querySelector(embedded ? '#manage-main' : '#main');
const header = document.querySelector(embedded ? '#manage-header' : '#header');
const dialog = document.querySelector(embedded ? '#manage-confirm-dialog' : '#confirm-dialog');
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('moonlit-updates') : null;
const images = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
const audio = 'audio/mpeg,audio/wav,audio/ogg,.mp3,.wav,.ogg,.opus';
const tabNames = {
  letters: ['来信审核', 'mail', '审核待处理来信，或整理已公开的回信。'],
  music: ['音乐分享', 'music', '上传完整歌曲、封面和可选的 LRC 或纯文本歌词。'],
  games: ['游戏分享', 'game', '记录游戏介绍，配上 Logo 和游戏图片。'],
  cats: ['猫猫图', 'cat', '图库只展示照片和上传时间。'],
  background: ['背景音乐', 'moon', '替换全站在闲时循环播放的背景音乐。'],
  settings: ['站点设置', 'sparkle', '站名、首页图片、Logo、寄语和社交链接。'],
  characters: ['关于我与角色', 'heart', '编辑关于我的文字，以及詩音和知遥的角色设定图。'],
  texts: ['编辑前台文字', 'mail', '按页面与用途修改标题、按钮、提示和空状态。'],
  visitors: ['访客日志', 'moon', '匿名访客、来源、可见停留时间和功能行为。'],
  modifications: ['修改记录', 'lock', '由服务端记录的上传、保存、发布与删除。'],
};
let session;
let activePanel;
let selectPanel;
let mountEpoch = 0;
let websiteConnector;

if (!embedded) bindFavicon();
if (!embedded) document.title = `管理后台 · ${site.browserTitle || site.name}`;

const auth = (path, options = {}) => api(`/api/admin${path}`, {
  ...options, headers: { ...options.headers, 'X-CSRF-Token': session?.csrf || '' },
}).catch(error => {
  if (embedded && error.code === 'website_login_required' && !main.querySelector('.website-connection')) {
    showWebsiteConnection(error, websiteConnector, mountEpoch, true);
  }
  throw error;
});

function drawHeader() {
  if (embedded) { header.replaceChildren(); return; }
  const back = el('a', { href: '/', class: 'button admin-back' }, icon('back', 16), el('span', {}, '返回主页面'));
  const logout = action('退出登录', null, { class: 'button' });
  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      await auth('/logout', { method: 'POST' });
      session = null;
      showLogin();
    } catch (error) {
      toast(error.message, 'error');
      logout.disabled = false;
    }
  });
  header.replaceChildren(el('div', { class: 'frame admin-header-frame' },
    el('div', { class: 'admin-identity' }, brand(), el('span', { class: 'tag' }, '管理后台')),
    el('div', { class: 'admin-header-actions' }, back, session && logout)));
}

function labeled(label, input, hint) {
  return el('label', { class: 'field' }, el('span', {}, label), input,
    hint && el('small', { class: 'muted' }, hint));
}

function textField(name, label, maxlength, { required, rows, placeholder, hint } = {}) {
  return labeled(label, el(rows ? 'textarea' : 'input', { name, maxlength, required, rows, placeholder }), hint);
}

function showLogin() {
  if (embedded) { dispatchEvent(new Event('chat-auth-expired')); return; }
  drawHeader();
  const username = el('input', { name: 'username', required: true, autocomplete: 'username', maxlength: 40, placeholder: '管理员账号' });
  const password = el('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password', maxlength: 256, placeholder: '管理员密码' });
  const submit = action('登录后台', 'lock', { type: 'submit', class: 'button button-primary' });
  const status = el('p', { class: 'inline-status', role: 'status', hidden: true });
  const form = el('form', { class: 'login-card panel' },
    mark(57), el('p', { class: 'eyebrow' }, 'MOONLIT / KEEPERS ONLY'),
    el('h1', {}, '管理后台'),
    el('p', { class: 'muted login-copy' }, '登录后上传收藏、整理来信。'),
    labeled('账号', username), labeled('密码', password),
    el('div', { class: 'form-actions' }, submit, status),
    el('p', { class: 'login-note' }, '首次使用请在本机运行 ', el('code', {}, 'pnpm admin:init'), ' 创建管理员。'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    showStatus(status, '正在核验…', 'info');
    try {
      session = await api('/api/admin/login', { method: 'POST', json: { username: username.value.trim(), password: password.value } });
      password.value = '';
      if (location.pathname !== '/admin') history.replaceState(null, '', '/admin');
      showWorkspace();
    } catch (error) {
      showStatus(status, error.message, 'error');
    } finally {
      submit.disabled = false;
    }
  });
  const illustration = site.heroImage && image(site.heroImage, '', { class: 'login-art', loading: 'eager' });
  main.replaceChildren(el('div', { class: 'login-stage' }, illustration, el('div', { class: 'frame login-frame' }, form)));
}

function previewAudio(url, name) {
  const audioElement = el('audio', { src: url, preload: 'none' });
  const play = iconButton('play', `播放本地预览 · ${name}`);
  const sync = () => {
    const paused = audioElement.paused;
    const label = `${paused ? '播放' : '暂停'}本地预览 · ${name}`;
    play.setAttribute('aria-label', label);
    play.title = label;
    play.replaceChildren(icon(paused ? 'play' : 'pause', 17));
  };
  for (const event of ['play', 'pause', 'ended']) audioElement.addEventListener(event, sync);
  play.addEventListener('click', () => {
    if (audioElement.paused) {
      main.querySelectorAll('audio').forEach((other) => { if (other !== audioElement) other.pause(); });
      audioElement.play().catch(() => toast('本地文件无法播放。', 'error'));
    } else {
      audioElement.pause();
    }
  });
  return el('div', { class: 'local-audio' }, play, el('span', {}, name), audioElement);
}

function fileField(name, title, help, { accept, kind = 'image', required, multiple } = {}) {
  const input = el('input', { type: 'file', name, accept, required, multiple, 'aria-label': title });
  const filename = el('small', { class: 'file-help' }, help);
  const preview = el('div', { class: 'file-previews', hidden: true });
  let urls = [];
  let version = 0;
  const draw = () => {
    const current = ++version;
    preview.querySelectorAll('audio').forEach((audio) => audio.pause());
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [];
    const files = [...input.files];
    const limit = kind === 'audio' ? 100_000_000 : kind === 'text' ? 64 * 1024 : 8 * 1024 * 1024;
    const oversized = files.find((file) => file.size > limit);
    input.setCustomValidity(oversized ? (kind === 'audio' ? '单个音频最大为 100,000,000 字节。' : '文件超过大小限制。') : '');
    clear.hidden = !files.length;
    filename.textContent = files.length ? files.map((file) => file.name).join(' · ') : help;
    preview.hidden = !files.length;
    preview.replaceChildren();
    if (oversized) { preview.hidden = false; preview.append(el('p', { class: 'inline-status', 'data-status': 'error' }, oversized.name + '：' + input.validationMessage)); return; }
    for (const file of files.slice(0, 5)) {
      if (kind === 'text') {
        if (file.size > 64 * 1024) {
          preview.append(el('p', { class: 'inline-status', 'data-status': 'error' }, '歌词文件超过 64 KiB。'));
        } else {
          const sample = el('pre', { class: 'lyric-preview' }, '正在读取本地歌词…');
          preview.append(sample);
          file.text().then((text) => {
            if (current === version) sample.textContent = text.slice(0, 700);
          }).catch(() => { sample.textContent = '无法预览此文件。'; });
        }
      } else {
        const url = URL.createObjectURL(file);
        urls.push(url);
        preview.append(kind === 'audio' ? previewAudio(url, file.name)
          : image(url, `本地预览 · ${file.name}`, { class: 'local-image', loading: 'eager' }));
      }
    }
  };
  input.addEventListener('change', draw);
  const clear = action('移除所选文件', null, { class: 'button file-clear', hidden: true });
  clear.addEventListener('click', () => { input.value = ''; draw(); clear.hidden = true; input.dispatchEvent(new Event('change', { bubbles: true })); });
  input.addEventListener('change', () => { clear.hidden = !input.files.length; });
  return {
    view: el('div', { class: 'file-field' }, el('label', { class: 'file-tile' },
      input, el('span', { class: 'file-icon' }, icon('upload', 18)),
      el('span', { class: 'file-copy' }, el('strong', {}, title), filename),
      el('span', { class: 'tag file-choose', 'aria-hidden': 'true' }, '选择文件')),
    preview, clear),
    input,
    reset: draw,
  };
}

function uploadPanel(category, existing = null, onSaved) {
  const manual = new Set(existing ? ['title', 'artist', 'producer'] : []);
  const ranks = {};
  const files = [];
  const addFile = (...args) => {
    const field = fileField(...args);
    files.push(field);
    return field.view;
  };
  const imageProps = { accept: images };
  const audioProps = { accept: audio, kind: 'audio', required: category === 'background' ? !existing?.audio : !existing };
  const fields = el('fieldset', { class: 'upload-fields' });
  const submit = action(existing ? '保存修改' : '确认上传', existing ? 'check' : 'upload', { type: 'submit', class: 'button button-primary' });
  const status = el('p', { class: 'inline-status', role: 'status', hidden: true });
  const percent = el('progress', { max: 100, value: 0, 'aria-label': '上传进度' });
  const meter = el('div', { class: 'upload-meter', hidden: true }, percent);
  const fileTransfers = el('div', { class: 'file-transfers' }); meter.append(fileTransfers);
  let picker;
  let producerPicker;
  let coverPicker;
  let background;
  const common = (name) => el('div', { class: 'input-grid' },
    textField('title', name, 100, { required: true }), textField('translation', '译名（可选）', 100));
  const note = () => textField('note', '寄语', 500, { rows: 3, required: true });
  if (category === 'music') {
    const artist = materialPicker({ auth, kind: 'artists', label: '歌手／演唱署名', idName: 'artistId', newName: 'artistName', initialId: existing?.artistId, initialName: existing?.artist || '', onManual: () => manual.add('artist') });
    const artistPicture = fileField('artistImage', '新署名图片（可选）', '新建歌手时可上传；复用署名时保留原图片。', { accept: images });
    const newArtist = el('fieldset', { class: 'new-artist-image' }, artistPicture.view);
    const artistView = el('div', {}, artist.view, newArtist);
    const syncArtist = () => { newArtist.hidden = newArtist.disabled = Boolean(artist.id); };
    artistView.addEventListener('change', syncArtist); syncArtist();
    picker = { view: artistView, setName: (name) => { artist.setName(name); syncArtist(); }, ready: artist.ready, reset: artistPicture.reset, loadArtists: artist.load };
    producerPicker = materialPicker({ auth, kind: 'producers', label: 'P 主（明确署名，可选）', idName: 'producerId', newName: 'producer', initialId: existing?.producerId, initialName: existing?.producer || '', onManual: () => manual.add('producer') });
    coverPicker = materialPicker({ auth, kind: 'covers', label: '复用已有封面（可选）', idName: 'coverId', initialId: existing?.cover?.id });
    fields.append(common('歌名'), picker.view,
      el('div', { class: 'input-grid' }, producerPicker.view, textField('lyricist', '作词（可选）', 80)),
      note(), addFile('audio', '歌曲音频', 'MP3 / WAV / Ogg，最大 100 MB（100,000,000 字节）', audioProps),
      coverPicker.view,
      addFile('cover', '独立歌曲封面（可选）', 'JPEG / PNG / WebP，最大 8 MiB', imageProps),
      addFile('lyricsFile', '歌词文件（可选）', 'UTF-8 .lrc / .txt，最大 64 KiB', { kind: 'text', accept: '.lrc,.txt,text/plain' }),
      textField('lyrics', '或粘贴歌词（可选）', 24000, { rows: 5, placeholder: '[00:08.00] 第一行歌词', hint: '上传歌词文件与粘贴歌词可任选其一。' }));
  } else if (category === 'games') {
    const genre = materialPicker({ auth, kind: 'genres', label: '游戏分类', idName: 'genreId', newName: 'genre', initialId: existing?.genreId, initialName: existing?.genre || '' });
    fields.append(common('游戏名'), genre.view, note(),
      textField('description', '完整游戏介绍', 6000, { rows: 6, required: true }),
      addFile('logo', '游戏 Logo', 'JPEG / PNG / WebP，最大 8 MiB；编辑时可保留已有图片', { ...imageProps, required: !existing }),
      addFile('images', '游戏介绍图片', '共 1 至 5 张，每张最大 8 MiB；编辑时新图追加到保留图片之后', { ...imageProps, required: !existing, multiple: true }));
    if (existing) {
      const keep = el('input', { type: 'hidden', name: 'keepImages', value: JSON.stringify(existing.images.map((item) => item.id)) });
      const checks = existing.images.map((item, index) => {
        const check = el('input', { type: 'checkbox', checked: true });
        check.addEventListener('change', () => { keep.value = JSON.stringify(existing.images.filter((_entry, i) => checks[i].querySelector('input').checked).map((entry) => entry.id)); });
        return el('label', { class: 'existing-image' }, image(item.thumbnail, '', { width: 90, height: 70 }), el('span', { class: 'check-label' }, check, '保留图片 ' + (index + 1)));
      });
      fields.append(el('div', { class: 'existing-images' }, checks, keep));
    }
  } else if (category === 'cats') {
    fields.append(addFile('image', '猫猫原图', 'JPEG / PNG / WebP，最大 8 MiB', { ...imageProps, required: !existing }));
  } else {
    background = el('p', { class: 'background-state muted' }, '正在读取背景音乐…');
    const remove = action('删除背景音乐', 'trash', { class: 'button button-danger' });
    remove.addEventListener('click', () => confirm('删除背景音乐', '确认后，前台会停止播放背景音乐。', '删除', true, async () => { await auth('/background', { method: 'DELETE' }); await refreshBackground(); toast('背景音乐已删除'); }));
    const volume = el('input', { name: 'volumePercent', type: 'number', min: 0, max: 100, step: 1, required: true, 'aria-label': '背景音乐音量（%）', value: Math.round((existing?.volume ?? .05) * 100) });
    fields.append(background, labeled('背景音乐音量（%）', volume, '默认 5%。保存并同步后生效；前台仅提供开关。'), addFile('audio', '新的背景音乐', 'MP3 / WAV / Ogg，最大 100 MB（100,000,000 字节）', audioProps), remove);
  }

  async function refreshBackground() {
    if (!background) return;
    try {
      const { item } = await api('/api/public/background');
      background.textContent = item ? `当前已配置 · ${item.mime} · ${(item.size / 1024 / 1024).toFixed(2)} MiB` : '当前未配置背景音乐。';
    } catch (error) {
      background.textContent = error.message;
    }
  }

  const form = el('form', { class: 'upload-form panel' }, fields, meter, el('div', { class: 'form-actions' }, submit, status));
  const controls = draftControls({ root: form, initial: existing && (category !== 'background' || existing.audio) && (existing.version || existing.draftId) ? existing : null, auth, save: submit, status,
    restore: (value) => {
      if (onSaved) return onSaved(value);
      else { form.reset(); files.forEach((file) => file.reset()); }
    }, synced: (value) => onSaved?.(value) });
  form.querySelector('.form-actions').remove(); form.append(controls.view, status);
  if (existing) {
    fields.prepend(el('p', { class: 'editing-note' }, '正在编辑 · ' + (existing.title || (category === 'background' ? '背景音乐' : '猫猫图')) + '。未选择新文件时会保留已有媒体。'),
      el('input', { type: 'hidden', name: 'version', value: existing.version }));
    for (const name of ['title', 'translation', 'producer', 'lyricist', 'note', 'lyrics', 'genre', 'description']) {
      const input = form.elements.namedItem(name);
      if (input) input.value = existing[name] || '';
    }
    const media = existing.cover || existing.logo || existing.image;
    if (media) fields.prepend(image(media.thumbnail, '当前已保存的图片', { class: 'current-cover', width: 150, height: 100 }));
  }
  const lyricsFile = form.elements.namedItem('lyricsFile');
  lyricsFile?.addEventListener('change', () => { form.elements.namedItem('lyrics').disabled = Boolean(lyricsFile.files[0]); });
  form.elements.namedItem('cover')?.addEventListener('change', () => { if (form.elements.namedItem('cover').files[0]) coverPicker?.clear(); });
  coverPicker?.view.addEventListener('change', () => {
    const cover = form.elements.namedItem('cover');
    if (coverPicker.id && cover.files.length) { cover.value = ''; files.find((field) => field.input?.name === 'cover')?.reset(); }
  });
  if (category === 'music') {
    const recognition = el('p', { class: 'recognition-status', role: 'status' }, '选择音频或 LRC 后会在本机解析信息；请核对后保存。');
    fields.prepend(recognition); let audioGeneration = 0; let lrcGeneration = 0;
    form.addEventListener('input', (event) => { if (event.target.name === 'title') manual.add('title'); });
    const apply = async (tags, rank) => {
      await picker.ready;
      const title = form.elements.namedItem('title');
      if (tags.title && !manual.has('title') && rank >= (ranks.title || 0)) { title.value = tags.title; ranks.title = rank; }
      if (tags.artist && !manual.has('artist') && rank >= (ranks.artist || 0)) { picker.setName(tags.artist); ranks.artist = rank; }
      if (tags.producer && !manual.has('producer') && rank >= (ranks.producer || 0)) { producerPicker.setName(tags.producer); ranks.producer = rank; }
      form.dispatchEvent(new Event('input', { bubbles: true }));
    };
    form.elements.namedItem('audio').addEventListener('change', async (event) => {
      const file = event.target.files[0]; if (!file) return; const generation = ++audioGeneration;
      if (file.size > 100_000_000) { recognition.textContent = '音频超过 100 MB（100,000,000 字节），请更换后再解析。'; return; }
      if (!manual.has('title')) { form.elements.namedItem('title').value = ''; ranks.title = 0; }
      if (!manual.has('artist')) { picker.setName(''); ranks.artist = 0; }
      if (!manual.has('producer')) { producerPicker.clear(); ranks.producer = 0; }
      recognition.textContent = '正在本地解析音频标签…（尚未上传）';
      try {
        const tags = await readAudioTags(file); if (generation !== audioGeneration) return;
        if (tags.title || tags.artist || tags.producer) await apply(tags, 3);
        if (lyricsFile.files[0] && lyricsFile.files[0].size <= 64 * 1024) await apply(readLrcTags(await lyricsFile.files[0].text()), 2);
        if (!tags.title) await apply({ title: tags.fallbackTitle }, 1);
        recognition.textContent = '本地解析完成 · ' + (tags.source || '文件名备用信息') + '：'
          + [tags.title && '歌名 ' + tags.title, tags.artist && '歌手 ' + tags.artist, tags.producer && 'P 主 ' + tags.producer].filter(Boolean).join('；')
          + '。已手动填写的字段保留；未识别到明确 P 主时请手动选择。';
      } catch { recognition.textContent = '未能解析标签，可手动填写；文件尚未上传。'; }
    });
    lyricsFile.addEventListener('change', async () => {
      const file = lyricsFile.files[0]; if (!file) return; const generation = ++lrcGeneration;
      if (file.size > 64 * 1024) { recognition.textContent = '歌词文件超过 64 KiB，请更换后再解析。'; return; }
      try { const tags = readLrcTags(await file.text()); if (generation !== lrcGeneration) return; await apply(tags, 2); recognition.textContent = 'LRC 标签已在本机解析，可补充标题和歌手；手动修改的字段保留。'; }
      catch { recognition.textContent = '无法解析 LRC 信息，可手动填写。'; }
    });
  }
  let key;
  const edit = () => {
    key = undefined;
    meter.hidden = true;
    showStatus(status, '');
  };
  form.addEventListener('input', edit);
  form.addEventListener('change', edit);
  controls.preflight = () => {
    if (category === 'music' && !form.elements.namedItem('artistId').value && !form.elements.namedItem('artistName').value) {
      showStatus(status, '请先选择已有歌手，或确认新建署名。', 'error'); return form.querySelector('[data-material-picker] input:not([type="hidden"])') || form.querySelector('input:not([type="hidden"])');
    }
    if (category === 'games') {
      if (!form.elements.namedItem('genreId').value && !form.elements.namedItem('genre').value) { showStatus(status, '请先选择已有游戏分类，或确认新建分类。', 'error'); return form.querySelector('input:not([type="hidden"])'); }
      const kept = JSON.parse(form.elements.namedItem('keepImages')?.value || '[]').length;
      const count = kept + form.elements.namedItem('images').files.length;
      if (count < 1 || count > 5) { showStatus(status, '请保留或选择 1 至 5 张游戏介绍图片。', 'error'); return form.elements.namedItem('images'); }
    }
  };
  controls.onSave = async () => {
    const formData = new FormData(form);
    if (category === 'background') { formData.set('volume', String(Number(formData.get('volumePercent')) / 100)); formData.delete('volumePercent'); }
    for (const [name, value] of [...formData]) {
      if (value instanceof File && !value.name) formData.delete(name);
    }
    key ??= crypto.randomUUID();
    fields.querySelectorAll('audio').forEach((item) => item.pause());
    fields.disabled = submit.disabled = true;
    controls.busy(true);
    meter.hidden = false;
    percent.value = 0;
    showStatus(status, '上传中 0%', 'info');
    try {
      const path = existing && category !== 'background' ? `/api/admin/content/${category}/${existing.id}` : `/api/admin/uploads/${category}`;
      const item = await sendMultipart(path, existing && category !== 'background' ? 'PUT' : 'POST', formData, key, session.csrf, (value) => {
        percent.value = value;
        showStatus(status, `上传中 ${value}%`, 'info');
      }, () => {
        percent.value = 100;
        showStatus(status, '正在保存', 'info');
      }, { onFileProgress: fileProgressView(fileTransfers) });
      form.reset();
      key = undefined;
      files.forEach((file) => file.reset());
      picker?.reset();
      picker?.loadArtists();
      refreshBackground();
      controls.saved(item);
      toast('已保存，待同步');
      await onSaved?.(item);
    } catch (error) {
      showStatus(status, error.message, 'error');
    } finally {
      fields.disabled = submit.disabled = false;
      controls.busy(false);
    }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); if (!submit.disabled) controls.submit(); });
  picker?.loadArtists();
  refreshBackground();
  if (existing?._transfers?.length) {
    meter.hidden = false; percent.value = 100;
    const update = fileProgressView(fileTransfers); existing._transfers.forEach(update);
  }
  return form;
}

function backgroundPanel() {
  const view = el('div', {}, empty('正在读取背景音乐草稿…'));
  const draw = (item) => view.replaceChildren(uploadPanel('background', item, (next) => next ? draw(next) : load()));
  async function load() { try { draw((await auth('/background')).item); } catch (error) { view.replaceChildren(empty(error.message)); } }
  load(); return view;
}

function confirm(title, description, label, danger, submit) {
  const cancel = action('取消');
  cancel.addEventListener('click', () => dialog.close());
  const accept = action(label, danger ? 'trash' : 'check', { class: `button ${danger ? 'button-danger' : 'button-primary'}` });
  const status = el('p', { class: 'inline-status', role: 'status', hidden: true });
  const close = iconButton('close', '关闭');
  close.addEventListener('click', () => dialog.close());
  let busy = false;
  dialog.oncancel = (event) => { if (busy) event.preventDefault(); };
  accept.addEventListener('click', async () => {
    busy = accept.disabled = cancel.disabled = close.disabled = true;
    showStatus(status, '正在保存…', 'info');
    try {
      await submit();
      dialog.close();
    } catch (error) {
      showStatus(status, error.message, 'error');
    } finally {
      busy = accept.disabled = cancel.disabled = close.disabled = false;
    }
  });
  dialog.replaceChildren(el('div', { class: 'dialog-frame' },
    el('div', { class: 'dialog-bar' }, el('h2', { id: 'confirm-title' }, title), close),
    el('p', { class: 'prose confirm-copy' }, description),
    el('div', { class: 'form-actions confirm-actions' }, cancel, accept, status)));
  dialog.showModal();
}

function moderationPanel() {
  let state = 'pending';
  let groups = { pending: [], published: [] };
  let version = 0;
  const edits = new Map();
  const list = el('div', { class: 'review-list' }, empty('正在读取来信…', 'mail'));
  const filter = el('div', { class: 'filters', role: 'group', 'aria-label': '审核分组' });
  const status = el('p', { class: 'inline-status', role: 'status', hidden: true });
  for (const [value, label] of [['pending', '待处理'], ['published', '已发布']]) {
    const button = action(label, null, { class: 'filter', value, 'aria-pressed': String(state === value) });
    button.addEventListener('click', () => { state = value; draw(); load(); });
    filter.append(button);
  }
  const reload = action('刷新来信', null, { class: 'button' });
  reload.addEventListener('click', () => load());

  function draw() {
    for (const button of filter.children) {
      button.setAttribute('aria-pressed', String(state === button.value));
      button.textContent = `${button.value === 'pending' ? '待处理' : '已发布'} ${groups[button.value].length}`;
    }
    list.replaceChildren(...(groups[state].length ? groups[state].map(reviewCard)
      : [empty(state === 'pending' ? '暂无待处理来信。' : '暂无已发布回信。', 'mail')]));
  }

  async function load() {
    const request = ++version;
    try {
      const [pending, published] = await Promise.all([
        auth('/questions?state=pending'), auth('/questions?state=published'),
      ]);
      if (request !== version) return;
      groups = { pending: pending.items, published: published.items };
      for (const id of edits.keys()) if (![...groups.pending, ...groups.published].some((item) => item.id === id)) edits.delete(id);
      draw();
      showStatus(status, '');
    } catch (error) {
      if (request === version) showStatus(status, error.message, 'error');
    }
  }

  function reviewCard(item) {
    const endpoint = `/questions/${item.id}`;
    const remove = action('删除', 'trash', { class: 'button button-danger' });
    remove.addEventListener('click', () => confirm('删除来信', '这封来信将从后台移除。若已发布，首页与提问箱也会移除它。',
      '确认删除', true, async () => {
        await auth(endpoint, { method: 'DELETE' });
        edits.delete(item.id);
        channel?.postMessage('questions');
        await load();
        toast('来信已删除');
      }));
    const card = el('article', { class: 'review-card panel' },
      el('header', { class: 'letter-meta' }, el('span', {}, icon('mail', 15), item.author),
        timeTag(item.createdAt, true)), el('p', { class: 'review-question' }, item.question));
    if (item.state === 'published') {
      card.append(el('div', { class: 'letter-reply' }, el('span', { class: 'mono reply-label' }, '已同步的回信'), el('p', {}, item.publishedReply || item.reply)));
    }

    const reply = el('textarea', { maxlength: 2400, rows: 4, placeholder: '写下给这封来信的回复…' });
    reply.value = edits.get(item.id) ?? item.reply ?? '';
    reply.addEventListener('input', () => edits.set(item.id, reply.value));
    const feedback = el('p', { class: 'inline-status', role: 'status', hidden: true });
    const draft = action('保存修改');
    const editor = el('div', { class: 'reply-editor' }, labeled('回复', reply));
    card.append(editor);
    let key;
    const controls = draftControls({ root: editor, initial: item.draftId || item.state === 'published' ? item : null,
      auth, save: draft, status: feedback, restore: (saved) => { reply.value = saved?.reply || ''; edits.delete(item.id); },
      synced: async () => { edits.delete(item.id); await load(); } });
    editor.append(controls.view, feedback, el('div', { class: 'form-actions' }, remove));
    reply.addEventListener('input', () => { key = undefined; });
    if (edits.has(item.id) && edits.get(item.id) !== (item.reply || '')) reply.dispatchEvent(new Event('input', { bubbles: true }));
    controls.onSave = async () => {
      // A tab switch can leave an older inbox fetch in flight. Its eventual
      // response must not replace the editor whose reply is being saved.
      version++;
      controls.busy(true); reply.disabled = remove.disabled = true;
      const text = reply.value;
      key ??= crypto.randomUUID();
      try {
        const result = await auth(`${endpoint}/draft`, { method: 'PUT', json: { reply: text, version: item.version }, headers: { 'Idempotency-Key': key } });
        if (reply.value === text) edits.delete(item.id);
        Object.assign(item, result.item); controls.saved(item); key = undefined;
      } catch (error) {
        showStatus(feedback, error.message, 'error');
      } finally {
        controls.busy(false); reply.disabled = remove.disabled = false;
      }
    };
    draft.addEventListener('click', controls.submit);
    return card;
  }

  return {
    view: el('div', { class: 'review-panel' }, el('div', { class: 'review-tools' }, filter, reload), status, list),
    load,
  };
}

function showWorkspace() {
  drawHeader();
  const navigation = el('nav', { class: 'admin-tabs', 'aria-label': '后台栏目' });
  const content = el('div', { class: 'admin-content' });
  const panels = new Map();
  const reviews = moderationPanel();
  const extra = workroom({ auth, session: () => session, fileField, confirm });
  const select = (name) => {
    if (!Object.hasOwn(tabNames, name)) name = 'letters';
    if (activePanel === name && panels.has(name)) return;
    content.querySelectorAll('audio').forEach((audio) => audio.pause());
    activePanel = name;
    if (!panels.has(name)) {
      const [label, glyph, copy] = tabNames[name];
      const panel = el('section', { class: 'admin-panel', id: `panel-${name}`, 'aria-label': label },
        el('header', { class: 'admin-panel-head' },
          el('div', {}, el('p', { class: 'eyebrow' }, name === 'letters' ? 'INCOMING LETTERS' : 'MEDIA STUDIO'),
            el('h2', {}, label), el('p', { class: 'muted' }, copy)), el('span', { class: 'admin-glyph' }, icon(glyph, 24))),
        name === 'letters' ? reviews.view
          : ['settings', 'characters', 'texts'].includes(name) ? extra.settingsPanel(name)
            : ['visitors', 'modifications'].includes(name) ? extra.logsPanel(name)
              : name === 'background' ? backgroundPanel() : extra.library(name, uploadPanel));
      panels.set(name, panel);
      content.append(panel);
    }
    for (const [key, panel] of panels) panel.hidden = key !== name;
    for (const button of navigation.children) button.setAttribute('aria-pressed', String(button.value === name));
    if (embedded) main.scrollTo({ top: 0, behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
    if (name === 'letters') reviews.load();
  };
  for (const [name, [label, glyph]] of Object.entries(tabNames)) {
    const tab = action(label, glyph, { class: 'button admin-tab', value: name, 'aria-pressed': 'false' });
    tab.addEventListener('click', () => select(name));
    navigation.append(tab);
  }
  main.replaceChildren(el('div', { class: 'frame admin-workspace' },
    el('div', { class: 'admin-welcome' }, el('div', {}, el('p', { class: 'eyebrow' }, site.englishName, ' / WORKROOM'),
      el('h1', {}, site.name, '工作室')), el('span', { class: 'tag' }, icon('lock', 13), session.username)),
    globalDraftBar({ auth, locate: (root) => { if (typeof root === 'string') return select(root === 'questions' ? 'letters' : root); const panel = root.closest('.admin-panel'); if (panel) select(panel.id.slice(6)); } }),
    el('div', { class: 'admin-layout' }, navigation, content)));
  selectPanel = select;
  select('letters');
}

export function activateAdminPanel(name) { selectPanel?.(name); }

function showWebsiteConnection(error, connectWebsite, epoch, preserveWorkspace = false) {
  const accountExpired = error.code === 'login_required' && error.status === 401;
  if (accountExpired) dispatchEvent(new Event('chat-auth-expired'));
  const username = el('input', { required: true, autocomplete: 'username', maxlength: 40, 'aria-label': '网站管理员账号' });
  const password = el('input', { type: 'password', required: true, autocomplete: 'current-password', maxlength: 256, 'aria-label': '网站管理员密码' });
  const submit = action('连接网站后台', 'lock', { type: 'submit', class: 'button button-primary' });
  const retry = action('重试连接');
  const status = el('p', { class: 'inline-status', role: 'status' });
  showStatus(status, error.message, 'error');
  const form = el('form', { class: 'website-connection' },
    el('h2', {}, '网站后台连接'),
    el('p', { class: 'muted' }, '使用詩音の月光庭院的管理员账号。聊天账号继续有效。'),
    connectWebsite && labeled('网站管理员账号', username),
    connectWebsite && labeled('网站管理员密码', password),
    status, el('div', { class: 'form-actions' }, connectWebsite && submit, retry));
  const connect = async (signedIn) => {
    if (submit.disabled) return;
    submit.disabled = retry.disabled = true;
    showStatus(status, '正在连接网站后台…');
    try {
      if (signedIn) await connectWebsite({ username: username.value.trim(), password: password.value });
      password.value = '';
      const verified = await api('/api/admin/session', { signal: AbortSignal.timeout(10000) });
      if (epoch !== mountEpoch) return;
      session = verified;
      if (preserveWorkspace) { form.parentElement.remove(); toast('网站后台已重新连接，可以继续保存。'); }
      else showWorkspace();
    } catch (err) { showStatus(status, err.message, 'error'); }
    finally { submit.disabled = retry.disabled = false; }
  };
  retry.onclick = () => connect(false);
  form.onsubmit = event => { event.preventDefault(); if (connectWebsite) void connect(true); };
  const panel = el('div', { class: 'frame admin-loading' }, form);
  if (preserveWorkspace) { main.prepend(panel); main.scrollTop = 0; }
  else main.replaceChildren(panel);
}

export async function mountAdmin({ connectWebsite } = {}) {
  const epoch = ++mountEpoch;
  websiteConnector = connectWebsite;
  activePanel = null;
  selectPanel = null;
  drawHeader();
  main.replaceChildren(el('div', { class: 'frame admin-loading' }, empty('正在读取会话…')));
  try {
    const next = await api('/api/admin/session', { signal: AbortSignal.timeout(10000) });
    if (epoch !== mountEpoch) return;
    session = next; showWorkspace();
  } catch (error) {
    if (epoch !== mountEpoch) return;
    if (embedded) showWebsiteConnection(error, connectWebsite, epoch);
    else showLogin();
  }
}
export function unmountAdmin() { mountEpoch++; session = null; activePanel = null; selectPanel = null; websiteConnector = null; main.replaceChildren(); header.replaceChildren(); }
if (!embedded) mountAdmin();

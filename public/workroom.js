import { action, el, empty, icon, image, showStatus, site, timeTag, toast, updateSite } from './ui.js';
import { fileProgressView, sendMultipart } from './uploads.js';
import { draftControls } from './draft-controls.js';

const images = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';
export function workroom({ auth, session, fileField, confirm }) {
  function field(label, value, { rows, max = 5000, type = 'text', required } = {}) {
    const input = el(rows ? 'textarea' : 'input', { rows, maxlength: max, type: rows ? null : type, required });
    input.value = value ?? '';
    return { input, view: el('label', { class: 'field' }, el('span', {}, label), input) };
  }

  function settingsPanel(mode) {
    const container = el('div', { class: 'settings-container' }, empty('正在展开工作笺…'));
    let latest, fields, loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try { const result = await auth('/settings'); latest = result.item; fields = result.fields; draw(); }
      catch (error) { container.replaceChildren(empty(error.message)); }
      finally { loading = false; }
    }
    function draw() {
      const inputs = [];
      const fileFields = [];
      let fileNumber = 0;
      const fieldsBox = el('fieldset', { class: 'upload-fields' });
      function add(label, value, options, parent = fieldsBox) {
        const result = field(label, value, options); parent.append(result.view); inputs.push(result.input); return result.input;
      }
      function asset(label, media, parent, reference, required = false) {
        const name = 'asset' + fileNumber++;
        const file = fileField(name, label, '仅本地预览；保存修改后才会上传。JPEG / PNG / WebP，最大 8 MiB', { accept: images, required });
        const input = file.view.querySelector('input');
        const current = el('div', { class: 'settings-image' }, media && image(media, label, { sizes: '330px' }));
        parent.append(current, file.view);
        fileFields.push({ name, input, reset: file.reset });
        return () => input.files[0] ? 'file:' + name : reference;
      }
      let build;
      if (mode === 'settings') {
        const name = add('站名', latest.name, { max: 120, required: true });
        const browserTitle = add('浏览器标签名称', latest.browserTitle || '詩音の月光庭院', { max: 120 });
        const englishName = add('英文站名', latest.englishName, { max: 120 });
        const heroTitle = add('首页主标题', latest.heroTitle, { max: 120 });
        const motto = add('首页寄语', latest.motto, { rows: 3, max: 600 });
        const heroCredit = add('首页图片说明', latest.heroCredit, { max: 120 });
        const demoLabel = add('站点状态文字', latest.demoLabel, { max: 120 });
        const hero = asset('替换首页图片', latest.heroOriginal, fieldsBox, latest.heroMediaId);
        const logo = asset('替换 Logo（可选）', latest.logo, fieldsBox, latest.logoMediaId);
        const socialInputs = {};
        for (const [key, label] of [['bilibili', 'Bilibili'], ['steam', 'Steam'], ['x', 'X'], ['discord', 'Discord（DC）']]) socialInputs[key] = add(label + ' 链接（留空显示未配置）', latest.socials[key], { max: 500, type: 'url' });
        build = () => ({ name: name.value, browserTitle: browserTitle.value, englishName: englishName.value, heroTitle: heroTitle.value, motto: motto.value,
          heroCredit: heroCredit.value, demoLabel: demoLabel.value, heroMediaId: hero(), logoMediaId: logo(),
          socials: Object.fromEntries(Object.entries(socialInputs).map(([key, input]) => [key, input.value])) });
      } else if (mode === 'characters') {
        const aboutBox = el('section', { class: 'settings-block' }, el('h3', {}, '关于我的文字与展示立绘'));
        fieldsBox.append(aboutBox);
        const about = {};
        for (const [key, label, rows] of [['intro', '自我介绍', 4], ['likes', '喜欢的事物（每行一项）', 3], ['dislikes', '讨厌的事物（每行一项）', 3], ['listening', '最近在听'], ['playing', '最近在玩'], ['why', '建站缘由', 4], ['portraitCredit', '立绘说明'], ['portraitAlt', '立绘替代文字']]) {
          about[key] = add(label, Array.isArray(latest.about[key]) ? latest.about[key].join('\n') : latest.about[key], { rows }, aboutBox);
        }
        const portrait = asset('替换关于我展示图', latest.about.portraitMedia, aboutBox, latest.about.portraitMediaId);
        const characters = latest.characters.map((character) => {
          const box = el('section', { class: 'settings-block character-editor', 'data-character-editor': character.id }, el('h3', {}, character.name + '的角色设定'));
          fieldsBox.append(box);
          const values = {};
          for (const [key, label, rows] of [['name', '角色名称'], ['alias', '别名'], ['role', '角色身份'], ['summary', '角色简介', 3], ['appearance', '外貌与服装特征', 4], ['world', '世界观说明', 4], ...(character.id === 'shion' ? [['human', '人类侧说明', 3], ['divine', '神明侧说明', 3]] : [])]) values[key] = add(label, character[key], { rows, required: key === 'name' }, box);
          const rows = el('div', { class: 'character-image-rows' });
          box.append(rows);
          const entries = [];
          function imageRow(entry) {
            const wrapper = el('div', { class: 'character-image-editor' });
            rows.append(wrapper);
            const label = add('设定图说明', entry.label || '新的角色设定图', { max: 120, required: true }, wrapper);
            const getId = asset('替换／上传这张设定图', entry.media, wrapper, entry.mediaId, !entry.mediaId);
            const keep = el('input', { type: 'checkbox', checked: true });
            keep.addEventListener('change', () => { wrapper.querySelector('input[type="file"]').disabled = !keep.checked; label.disabled = !keep.checked; });
            wrapper.append(el('label', { class: 'check-label' }, keep, '保留这张图片（取消后于保存时移除）'));
            entries.push(() => keep.checked ? { mediaId: getId(), label: label.value } : null);
          }
          character.images.forEach(imageRow);
          const addImage = action('添加设定图／三视图', 'plus');
          addImage.addEventListener('click', () => {
            if (entries.length >= 8) return toast('每组角色最多保存 8 张设定图。', 'error');
            imageRow({});
          });
          box.append(addImage);
          return () => ({ ...character, ...Object.fromEntries(Object.entries(values).map(([key, input]) => [key, input.value])),
            images: entries.map((get) => get()).filter(Boolean).map(({ mediaId, label }) => ({ mediaId, label })) });
        });
        build = () => ({ about: { ...Object.fromEntries(Object.entries(about).map(([key, input]) => [key, ['likes', 'dislikes'].includes(key) ? input.value.split('\n').map((text) => text.trim()).filter(Boolean) : input.value])), portraitMediaId: portrait() }, characters: characters.map((get) => get()) });
      } else {
        const groups = new Map();
        const textInputs = new Map();
        for (const [group, key, label, fallback] of fields) {
          if (!groups.has(group)) {
            const section = el('details', { class: 'text-group', open: ['首页', '导航与页脚'].includes(group) }, el('summary', {}, group));
            const area = el('div', { class: 'text-fields' }); section.append(area); groups.set(group, area); fieldsBox.append(section);
          }
          textInputs.set(key, add(label, latest.texts[key] || fallback, { rows: (latest.texts[key] || fallback).length > 32 ? 2 : null, max: 600 }, groups.get(group)));
        }
        fieldsBox.prepend(el('p', { class: 'muted' }, '文字按页面与用途分组。修改按钮名称只改变显示文字，按钮仍执行对应功能。'));
        build = () => ({ texts: Object.fromEntries([...textInputs].map(([key, input]) => [key, input.value])) });
      }
      const status = el('p', { class: 'inline-status', role: 'status' }, '当前内容已保存');
      const submit = action('保存修改', 'check', { type: 'submit', class: 'button button-primary' });
      const reload = action('重新读取（放弃未保存修改）');
      reload.addEventListener('click', load);
      const progress = el('progress', { max: 100, value: 0, 'aria-label': '保存上传进度' });
      const meter = el('div', { class: 'upload-meter', hidden: true }, progress);
      const transfers = el('div', { class: 'file-transfers' }); meter.append(transfers);
      const form = el('form', { class: 'panel upload-form settings-form', 'data-settings-mode': mode }, fieldsBox, meter, el('div', { class: 'form-actions' }, submit, status, reload));
      const controls = draftControls({ root: form, initial: latest, auth, save: submit, status, restore: load,
        synced: (item) => { latest = item; updateSite(item); draw(); } });
      form.querySelector('.form-actions').remove(); form.append(controls.view, status);
      if (latest._transfers?.length) { meter.hidden = false; progress.value = 100; const update = fileProgressView(transfers); latest._transfers.forEach(update); }
      let key;
      const edit = () => { key = undefined; meter.hidden = true; showStatus(status, '有未保存修改', 'info'); };
      form.addEventListener('input', edit); form.addEventListener('change', edit);
      controls.onSave = async () => {
        const data = new FormData();
        try { data.set('patch', JSON.stringify(build())); } catch (error) { return showStatus(status, error.message, 'error'); }
        data.set('version', controls.version);
        for (const file of fileFields) if (file.input.files[0]) data.set(file.name, file.input.files[0]);
        key ??= crypto.randomUUID();
        fieldsBox.disabled = submit.disabled = reload.disabled = true; meter.hidden = false; progress.value = 0;
        controls.busy(true);
        showStatus(status, '上传中 0%', 'info');
        try {
          latest = await sendMultipart('/api/admin/settings', 'PUT', data, key, session().csrf,
            (value) => { progress.value = value; showStatus(status, '上传中 ' + value + '%', 'info'); },
            () => { progress.value = 100; showStatus(status, '正在保存', 'info'); }, { onFileProgress: fileProgressView(transfers) });
          controls.saved(latest); draw(); toast('已保存，待同步');
        } catch (error) { showStatus(status, error.message, 'error'); }
        finally { fieldsBox.disabled = submit.disabled = reload.disabled = false; controls.busy(false); }
      };
      form.addEventListener('submit', (event) => { event.preventDefault(); if (!submit.disabled) controls.submit(); });
      container.replaceChildren(form);
    }
    load(); return container;
  }

  function library(category, makeForm) {
    const editor = el('div', { class: 'library-editor' });
    const list = el('div', { class: 'library-items' });
    const add = action('新增内容', 'plus');
    const refresh = action('刷新内容与草稿');
    async function saved(item) { await load(); editor.replaceChildren(makeForm(category, item || null, saved)); }
    const create = () => editor.replaceChildren(makeForm(category, null, saved));
    add.addEventListener('click', create); refresh.addEventListener('click', load);
    async function load() {
      try {
        const { items } = await auth('/content/' + category);
        list.replaceChildren(...(items.length ? items.map((item) => {
          const media = item.cover || item.logo || item.image;
          const edit = action('编辑', null, { class: 'button' });
          edit.addEventListener('click', async () => {
            edit.disabled = true; editor.inert = true; list.inert = true;
            add.disabled = refresh.disabled = true; editor.setAttribute('aria-busy', 'true');
            try { const result = await auth('/content/' + category + '/' + item.id); editor.replaceChildren(makeForm(category, result.item, saved)); editor.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
            catch (error) { toast(error.message, 'error'); } finally { edit.disabled = false; editor.inert = list.inert = false; add.disabled = refresh.disabled = false; editor.removeAttribute('aria-busy'); }
          });
          const remove = action('删除', 'trash', { class: 'button button-danger' });
          remove.addEventListener('click', () => confirm('删除收藏', '删除后，前台会自动移除这项内容。', '删除', true, async () => {
            await auth('/content/' + category + '/' + item.id, { method: 'DELETE' }); await load(); toast('已删除'); create();
          }));
          return el('article', { class: 'library-row' }, media && image(media, '', { width: 70, height: 55, sizes: '70px' }),
            el('div', { class: 'library-label' }, el('strong', {}, item.title || '猫猫图'), el('span', { class: 'tag' }, item.status === 'draft' ? '已保存待同步' : '已同步'), timeTag(item.createdAt, true)), el('div', { class: 'form-actions' }, edit, remove));
        }) : [empty('这里还没有已发布的内容。')]));
      } catch (error) { list.replaceChildren(empty(error.message)); }
    }
    create(); load();
    return el('div', { class: 'library' }, el('div', { class: 'library-toolbar' }, add, refresh), editor,
      el('section', { class: 'library-section' }, el('h3', {}, '内容与草稿'), list));
  }

  function logsPanel(kind) {
    const status = el('p', { class: 'inline-status', role: 'status' });
    const from = el('input', { type: 'datetime-local', 'aria-label': '开始时间' });
    const to = el('input', { type: 'datetime-local', 'aria-label': '结束时间' });
    const pageFilter = el('select', { 'aria-label': kind === 'visitors' ? '按页面筛选' : '按内容类型筛选' }, el('option', { value: '' }, '全部页面／内容'));
    const options = kind === 'visitors' ? [['/', '首页'], ['/about', '关于我'], ['/music', '音乐'], ['/games', '游戏'], ['/cats', '猫猫图'], ['/questions', '提问箱']]
      : [['settings', '站点与文字'], ['music', '音乐'], ['games', '游戏'], ['cats', '猫猫图'], ['background', '背景音乐'], ['questions', '提问']];
    options.forEach(([value, label]) => pageFilter.append(el('option', { value }, label)));
    const type = el('select', { 'aria-label': '按事件类型筛选' }, el('option', { value: '' }, '全部事件'));
    const names = { 'page.enter': '访问页面', 'card.open': '打开卡片', 'image.open': '查看图片', 'song.play': '播放歌曲', 'song.pause': '暂停歌曲', 'song.stop': '停止歌曲', 'question.submit': '提交提问', 'social.open': '社交跳转', upload: '上传', edit: '编辑', delete: '删除', 'settings.save': '保存设置／文字', 'reply.draft': '保存答复草稿', 'reply.publish': '确认发布答复', 'file.upload': '上传文件', 'draft.save': '保存草稿', 'draft.sync': '同步发布' };
    (kind === 'visitors' ? ['page.enter', 'card.open', 'image.open', 'song.play', 'song.pause', 'song.stop', 'question.submit', 'social.open'] : ['file.upload', 'draft.save', 'draft.sync', 'upload', 'edit', 'delete', 'settings.save', 'reply.draft', 'reply.publish']).forEach((value) => type.append(el('option', { value }, names[value])));
    const rows = el('div', { class: 'log-rows' });
    const filter = action('查询日志', null, { type: 'submit', class: 'button button-primary' });
    const previous = action('上一页'); const next = action('下一页');
    const count = el('span', { class: 'muted' }); let page = 1;
    const filters = el('form', { class: 'log-filters panel' },
      el('label', { class: 'field' }, el('span', {}, '开始时间'), from), el('label', { class: 'field' }, el('span', {}, '结束时间'), to),
      el('span', { class: 'select-wrap' }, pageFilter, icon('down', 16)), el('span', { class: 'select-wrap' }, type, icon('down', 16)), filter);
    filters.addEventListener('submit', (event) => { event.preventDefault(); page = 1; load(); });
    previous.addEventListener('click', () => { page--; load(); }); next.addEventListener('click', () => { page++; load(); });
    async function load() {
      filter.disabled = previous.disabled = next.disabled = true;
      showStatus(status, '正在翻阅记录…');
      const params = new URLSearchParams({ page, limit: 30, path: pageFilter.value, type: type.value });
      if (from.value) params.set('from', new Date(from.value).toISOString());
      if (to.value) params.set('to', new Date(to.value).toISOString());
      try {
        const result = await auth('/logs/' + kind + '?' + params);
        count.textContent = '第 ' + result.page + ' / ' + result.pages + ' 页 · 共 ' + result.total + ' 条';
        rows.replaceChildren(...(result.items.length ? result.items.map((item) => kind === 'visitors'
          ? el('article', { class: 'log-row panel' },
            el('header', {}, el('strong', {}, names[item.type] || item.type), el('span', { class: 'tag' }, item.path), timeTag(new Date(item.created_at).toISOString(), true)),
            el('p', {}, '匿名访客 ' + item.visitor_id + ' · 入口 ' + item.entry_path),
            el('p', { class: 'muted' }, item.source + ' · ' + item.browser + ' · ' + item.device),
            el('p', { class: 'visitor-location' }, item.location_kind === 'local' ? '本地／内网访问'
              : item.location_kind === 'estimated' ? '国家：' + (item.country || '位置未知') + ' · 省份：' + (item.province || '位置未知') + ' · 城市：' + (item.city || '位置未知') + '（IP 归属地估算）' : '位置未知'),
            el('p', { class: 'log-detail' }, item.source_basis),
            item.type === 'page.enter' ? el('p', { class: 'log-detail' }, '有效停留 ' + (item.visible_ms / 1000).toFixed(1) + ' 秒' + (item.estimated ? '（按最后有效心跳估算）' : '（已补报）') + ' · 30 秒内进入 ' + item.repeats + ' 次')
              : el('code', {}, '内容 ID：' + (item.target_id || '—')))
          : el('article', { class: 'log-row panel' },
            el('header', {}, el('strong', {}, names[item.action] || item.action), el('span', { class: 'tag' }, item.result === 'success' ? '完成' : '失败'), timeTag(item.created_at, true)),
            el('p', {}, item.actor + ' · ' + item.category), el('p', { class: 'muted' }, item.summary), el('code', {}, '内容 ID：' + (item.object_id || '—')), item.batch_id && el('code', {}, '批次：' + item.batch_id)))
          : [empty('这个时间段里，还没有留下记录。')]));
        previous.disabled = page <= 1; next.disabled = page >= result.pages; showStatus(status, '');
      } catch (error) { showStatus(status, error.message, 'error'); }
      finally { filter.disabled = false; }
    }
    load();
    return el('div', { class: 'logs-panel' }, filters, status, rows, el('div', { class: 'form-actions log-pagination' }, previous, count, next));
  }
  return { settingsPanel, library, logsPanel };
}

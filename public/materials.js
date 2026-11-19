import { action, el, image, showStatus } from './ui.js';

export function materialPicker({ auth, kind, label, idName, newName, initialId = '', initialName = '', onManual = () => {} }) {
  const id = el('input', { type: 'hidden', name: idName, value: initialId });
  const fresh = newName && el('input', { type: 'hidden', name: newName, value: initialId ? '' : initialName });
  const search = el('input', { type: 'search', placeholder: '搜索已有素材' + (newName ? '，也可新建' : ''), 'aria-label': label + '搜索', role: 'combobox', 'aria-expanded': 'false', autocomplete: 'off' });
  search.value = initialName;
  const options = el('div', { class: 'material-options', role: 'listbox', hidden: true, id: 'picker-' + crypto.randomUUID() });
  search.setAttribute('aria-controls', options.id);
  const preview = el('div', { class: 'material-preview' });
  const status = el('small', { class: 'muted' }, initialId ? '已选择已有素材' : initialName ? '新建署名／分类，保存时入库' : '尚未选择');
  let items = []; let sequence = 0; let timer; let active = -1;
  const view = el('div', { class: 'material-picker' }, el('label', { class: 'field' }, el('span', {}, label), search), id, fresh, options, preview, status);
  function choose(item, manual = true, emit = true) {
    id.value = item?.id || ''; if (fresh) fresh.value = item?.id ? '' : item?.name || '';
    search.value = item?.name || ''; preview.replaceChildren();
    const media = item?.image;
    if (media) preview.append(image(media, '所选素材预览', { sizes: '110px', width: 110, height: 80 }));
    status.textContent = item ? item.id ? '复用已有素材引用' : '新建署名／分类，保存时入库' : '尚未选择';
    options.hidden = true; search.setAttribute('aria-expanded', 'false');
    if (emit) view.dispatchEvent(new Event('change', { bubbles: true })); if (manual) onManual();
  }
  function draw() {
    const query = search.value.trim(); active = -1;
    const visible = items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
    const values = [...visible.slice(0, 40), ...(newName && query && !items.some((item) => item.name.toLowerCase() === query.toLowerCase()) ? [{ name: query, new: true }] : [])];
    options.replaceChildren(...values.map((item) => {
      const button = action(item.new ? '新建「' + item.name + '」' : item.name, null, { class: 'material-option', role: 'option', 'aria-selected': String(id.value === item.id) });
      if (item.image) button.prepend(image(item.image, '', { width: 42, height: 35, sizes: '42px' }));
      button.addEventListener('click', () => choose(item)); return button;
    }));
    if (!values.length) options.append(el('p', { class: 'muted' }, '没有匹配的素材' + (newName ? '，可输入新名称。' : '，可上传新图片。')));
    options.hidden = false; search.setAttribute('aria-expanded', 'true');
  }
  async function load() {
    const current = ++sequence;
    try {
      const result = await auth('/materials?kind=' + kind + '&q=' + encodeURIComponent(search.value.trim()));
      if (current !== sequence) return; items = result.items;
      if (initialId && !search.value) {
        const item = items.find((item) => item.id === initialId); if (item) choose(item, false, false);
      } else if (id.value) {
        const item = items.find((item) => item.id === id.value); if (item?.image && !preview.children.length) preview.append(image(item.image, '', { width: 110, height: 80, sizes: '110px' }));
      }
      if (document.activeElement === search) draw();
    } catch (error) { showStatus(status, error.message, 'error'); }
  }
  search.addEventListener('input', () => {
    // Typing a new name is itself an explicit choice; selecting a result reuses its ID.
    id.value = ''; if (fresh) fresh.value = ''; preview.replaceChildren(); status.textContent = '请选择已有项' + (newName ? '，或点击新建确认名称。' : '。'); onManual();
    view.dispatchEvent(new Event('change', { bubbles: true }));
    clearTimeout(timer); timer = setTimeout(load, 100); draw();
  });
  search.addEventListener('focus', () => { draw(); load(); });
  search.addEventListener('keydown', (event) => {
    const buttons = [...options.querySelectorAll('button')];
    if (event.key === 'Escape') { options.hidden = true; search.setAttribute('aria-expanded', 'false'); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); active = Math.max(0, Math.min(buttons.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
      buttons.forEach((button, index) => button.classList.toggle('highlighted', index === active));
      buttons[active]?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter' && !options.hidden) { event.preventDefault(); (buttons[active] || buttons[0])?.click(); }
  });
  document.addEventListener('click', (event) => { if (!view.contains(event.target)) { options.hidden = true; search.setAttribute('aria-expanded', 'false'); } });
  const ready = load();
  return { view, ready, load, get id() { return id.value; }, get name() { return search.value.trim(); },
    setName(name) { const found = items.find((item) => item.name.toLowerCase() === name.toLowerCase()); choose(found || { name }, false); },
    clear() { choose(null, false); },
  };
}

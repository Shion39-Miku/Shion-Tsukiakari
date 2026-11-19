import { action, el, showStatus, toast } from './ui.js';

const editors = new Set();
const ownedVersions = new Map();
let manager;
const connected = () => [...editors].filter((editor) => editor.root.isConnected);
function notify() { manager?.reflect(); }

export function draftControls({ root, initial, auth, save, status, restore, synced, group }) {
  let saved = initial; let dirty = false; let busy = false;
  const state = el('span', { class: 'draft-state', role: 'status' });
  const batch = el('p', { class: 'batch-summary' });
  save.hidden = true; save.replaceChildren('保存修改');
  group ||= root.closest('[data-settings-mode]') ? 'settings' : undefined;
  const editor = {
    root, group, status,
    get dirty() { return dirty; }, get savedItem() { return saved; },
    get version() { return Math.max(saved?.version || 0, group ? ownedVersions.get(group) || 0 : 0); },
    validate() {
      const invalid = [...root.querySelectorAll('input,textarea,select')].find((input) => input.willValidate && !input.checkValidity());
      if (invalid) {
        invalid.setAttribute('aria-invalid', 'true');
        showStatus(status, '请核对：' + (invalid.getAttribute('aria-label') || invalid.labels?.[0]?.querySelector('span')?.textContent || invalid.name || '此字段'), 'error');
        return invalid;
      }
      return editor.preflight?.();
    },
    async runSave() {
      if (!dirty) return;
      if (!editor.onSave) throw new Error('表单尚未准备完成，请稍后重试。');
      await editor.onSave();
      if (dirty) throw new Error(status.textContent || '此栏目尚未保存。');
    },
    submit() { manager?.requestSave(); },
    async reset() { await restore(saved); dirty = false; reflect(); },
    async published(item) {
      if (!saved?.draftId || item.draftId !== saved.draftId) return;
      saved = item; dirty = false; reflect(); await synced?.(item);
    },
    view: el('div', { class: 'draft-actions' }, save, state, batch),
    saved(value) {
      saved = value; dirty = false;
      if (group) ownedVersions.set(group, value.version);
      reflect(); showStatus(status, '已保存，待同步', 'success');
    },
    busy(value) { busy = value; reflect(); },
  };
  function reflect() {
    state.textContent = dirty ? '未保存' : saved?.status === 'draft' ? '已保存待同步' : saved ? '已同步' : '等待填写';
    state.dataset.state = dirty ? 'dirty' : saved?.status || 'synced';
    save.disabled = busy;
    batch.textContent = saved?.batchId ? '批次 ' + saved.batchId : '';
    notify();
  }
  root.addEventListener('input', () => { dirty = true; reflect(); });
  root.addEventListener('change', () => { dirty = true; reflect(); });
  if (group && initial?.version) ownedVersions.set(group, Math.max(initial.version, ownedVersions.get(group) || 0));
  editors.add(editor);
  // Several review cards are built before their parent is attached. Pruning
  // during construction would discard every new editor except the last one.
  reflect(); setTimeout(() => {
    for (const old of editors) if (!old.root.isConnected) editors.delete(old);
    notify(); manager?.refresh().catch(() => {});
  }, 0);
  return editor;
}

export function globalDraftBar({ auth, locate }) {
  editors.clear(); ownedVersions.clear();
  let pending = []; let busy = false; let revision = 0;
  const reset = action('还原修改');
  const save = action('保存修改', 'check');
  const sync = action('同步修改', 'sparkle', { class: 'button button-primary' });
  const counts = el('span', { class: 'global-draft-counts', role: 'status' });
  const feedback = el('p', { class: 'global-draft-feedback', role: 'status' });
  const view = el('div', { class: 'global-draft-bar', 'aria-label': '全部栏目操作' },
    el('div', { class: 'global-draft-main' }, el('div', { class: 'form-actions' }, reset, save, sync), counts), feedback);
  function reflect() {
    const active = connected(); const dirty = active.filter((editor) => editor.dirty).length;
    const ids = new Set(pending.map((item) => item.draftId));
    active.forEach((editor) => { if (editor.savedItem?.status === 'draft') ids.add(editor.savedItem.draftId); });
    counts.textContent = '未保存 ' + dirty + ' 项 · 待同步 ' + ids.size + ' 项';
    counts.dataset.unsaved = dirty; counts.dataset.pending = ids.size;
    if (dirty && !busy && feedback.dataset.status === 'success') showStatus(feedback, '有未保存修改，保存后再同步。', 'info');
    reset.disabled = save.disabled = sync.disabled = busy;
  }
  async function refresh() { const attempt = ++revision; const result = await auth('/drafts'); if (attempt === revision) pending = result.items.filter((item) => item.status === 'draft'); reflect(); }
  async function run(work) {
    if (busy) return;
    busy = true; reflect(); showStatus(feedback, '正在处理全部栏目…', 'info');
    // Freeze all mounted editors, including hidden panels, while a global action
    // runs. This prevents input during an upload from being marked saved by it.
    const disabled = connected().flatMap((editor) => [...editor.root.querySelectorAll('input,textarea,select,button')].map((node) => [node, node.disabled]));
    const layout = view.parentElement?.querySelector('.admin-layout');
    try { await work(disabled); await refresh(); }
    catch (error) { showStatus(feedback, error.message, 'error'); }
    finally { disabled.forEach(([node, previous]) => { if (node.isConnected) node.disabled = previous; }); if (layout) layout.inert = false; busy = false; reflect(); }
  }
  reset.addEventListener('click', () => run(async () => {
    view.parentElement.querySelector('.admin-layout').inert = true;
    for (const editor of connected().filter((item) => item.dirty)) await editor.reset();
    showStatus(feedback, '全部未保存修改已还原；已保存草稿保留。', 'success');
  }));
  save.addEventListener('click', () => run(async (disabled) => {
    const changed = connected().filter((editor) => editor.dirty);
    // Validate every dirty section before the first network write.
    const errors = changed.map((editor) => [editor, editor.validate()]).filter(([, field]) => field);
    if (errors.length) {
      const [editor, field] = errors[0]; locate(editor.root); field.closest('details')?.setAttribute('open', '');
      field.scrollIntoView({ block: 'center' }); field.focus();
      throw new Error('有 ' + errors.length + ' 个栏目需要核对，已定位到首个错误。');
    }
    disabled.forEach(([node]) => { node.disabled = true; });
    view.parentElement.querySelector('.admin-layout').inert = true;
    // Disable the other sections, but let each save construct its FormData before
    // its own fields become disabled.
    for (const editor of changed) {
      disabled.filter(([node]) => editor.root.contains(node)).forEach(([node, previous]) => { node.disabled = previous; });
      try { await editor.runSave(); }
      catch (error) { locate(editor.root); editor.root.querySelector('.inline-status[data-status="error"]')?.scrollIntoView({ block: 'center' }); throw error; }
    }
    showStatus(feedback, changed.length ? '全部修改已保存，待同步。' : '没有未保存修改。', 'success');
  }));
  sync.addEventListener('click', () => run(async (disabled) => {
    const dirty = connected().find((editor) => editor.dirty);
    if (dirty) { locate(dirty.root); throw new Error('请先保存全部未保存修改，再同步。'); }
    view.parentElement.querySelector('.admin-layout').inert = true;
    await refresh();
    if (!pending.length) { showStatus(feedback, '所有栏目已同步。', 'success'); return; }
    disabled.forEach(([node]) => { node.disabled = true; });
    view.parentElement.querySelector('.admin-layout').inert = true;
    const empty = pending.find((item) => item.category === 'questions' && !item.reply.trim());
    if (empty) { const editor = connected().find((item) => item.savedItem?.draftId === empty.draftId); locate(editor?.root || 'questions'); throw new Error('有回信尚未填写回复，请在来信审核中补充并保存。'); }
    const result = await auth('/drafts/sync-all', { method: 'POST', json: { items: pending.map((item) => ({ id: item.draftId, version: item.version })) } });
    for (const record of result.items) for (const editor of connected()) await editor.published(record.item);
    showStatus(feedback, '同步完成，共 ' + result.items.length + ' 项。刷新前台即可查看。', 'success');
    toast('同步完成，刷新前台查看');
  }));
  manager = { reflect, refresh, requestSave: () => save.click() };
  refresh().catch((error) => showStatus(feedback, error.message, 'error'));
  return view;
}

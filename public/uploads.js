// Every file has its own measured XHR transfer. Request bodies are encoded once so
// aggregate progress uses actual byte counts, including multipart boundaries.
const uploaded = new WeakMap();
function xhrRequest(path, method, body, type, headers, progress, sent) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open(method, path); xhr.responseType = 'json'; xhr.timeout = 900000;
    if (type) xhr.setRequestHeader('Content-Type', type);
    Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
    xhr.upload.addEventListener('progress', (event) => { if (event.lengthComputable) progress?.(event.loaded, event.total); });
    xhr.upload.addEventListener('load', sent);
    xhr.addEventListener('load', () => xhr.status >= 200 && xhr.status < 300 && xhr.response
      ? resolve(xhr.response) : reject(new Error(xhr.response?.error?.message || '服务端还未确认保存，请保留表单重试。')));
    xhr.addEventListener('error', () => reject(new Error('连接中断，请保留输入并重试。')));
    xhr.addEventListener('timeout', () => reject(new Error('保存超时，请保留输入并重试。')));
    xhr.send(body);
  });
}
export function fileProgressView(container) {
  container.replaceChildren(); const rows = new Map();
  return (event) => {
    const key = event.index;
    if (!rows.has(key)) {
      const row = document.createElement('div'); row.className = 'file-transfer';
      const label = document.createElement('strong'); label.textContent = event.name;
      const status = document.createElement('span'); status.className = 'file-transfer-status';
      const progress = document.createElement('progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', event.name + '上传进度');
      row.append(label, status, progress); container.append(row); rows.set(key, { progress, status });
    }
    const row = rows.get(key); row.progress.value = event.percent;
    row.status.textContent = event.percent + '% · ' + event.status;
    row.status.dataset.status = event.status.startsWith('失败') ? 'error' : 'info';
  };
}
export async function sendMultipart(path, method, form, key, csrf, onProgress = () => {}, onSaving = () => {}, { onFileProgress = () => {} } = {}) {
  const fields = {}; const files = {}; const plans = [];
  for (const [name, value] of form) {
    if (!(value instanceof File)) { fields[name] = value; continue; }
    if (!value.name) continue;
    const index = plans.length; const cached = uploaded.get(value);
    const kind = name === 'lyricsFile' ? 'lyrics' : name === 'audio' ? 'audio' : 'image';
    const limit = kind === 'lyrics' ? 64 * 1024 : kind === 'audio' ? 100_000_000 : 8 * 1024 * 1024;
    if (value.size > limit) throw new Error(value.name + ' 超过大小限制，请更换文件后重试。');
    let blob, type;
    if (!cached) {
      const part = new FormData(); part.set('kind', kind); part.set('file', value);
      const encoded = new Request(location.origin + '/api/admin/files', { method: 'POST', body: part });
      type = encoded.headers.get('Content-Type'); blob = await encoded.blob();
    }
    plans.push({ name, file: value, index, cached, blob, type });
    (files[name] ??= []).push(cached?.id || '00000000-0000-4000-8000-000000000000');
    onFileProgress({ index, name: value.name, percent: cached ? 100 : 0, status: cached ? '已完成（复用已上传文件）' : '等待上传' });
  }
  const estimatedJson = new Blob([JSON.stringify({ fields, files })], { type: 'application/json' });
  const total = plans.reduce((n, plan) => n + (plan.blob?.size || 0), estimatedJson.size);
  let completed = 0;
  const headers = { 'X-CSRF-Token': csrf };
  for (const plan of plans) {
    if (plan.cached) continue;
    let percent = 0;
    try {
      const response = await xhrRequest('/api/admin/files', 'POST', plan.blob, plan.type, { ...headers, 'Idempotency-Key': key + '_file_' + plan.index },
        (loaded, size) => {
          percent = Math.min(100, Math.floor(loaded / size * 100));
          onFileProgress({ index: plan.index, name: plan.file.name, percent, status: '上传中' });
          onProgress(Math.min(100, Math.floor((completed + loaded) / total * 100)));
        }, () => onFileProgress({ index: plan.index, name: plan.file.name, percent: 100, status: '正在保存' }));
      plan.cached = response.item; uploaded.set(plan.file, response.item); completed += plan.blob.size;
      onFileProgress({ index: plan.index, name: plan.file.name, percent: 100, status: '已完成' });
    } catch (error) { onFileProgress({ index: plan.index, name: plan.file.name, percent, status: '失败，可重试' }); throw error; }
  }
  for (const name of Object.keys(files)) files[name] = plans.filter((plan) => plan.name === name).map((plan) => plan.cached.id);
  const body = new Blob([JSON.stringify({ fields, files })], { type: 'application/json' });
  const result = await xhrRequest(path, method, body, 'application/json', { ...headers, 'Idempotency-Key': key },
    (loaded) => onProgress(Math.min(100, Math.floor((completed + loaded) / (completed + body.size) * 100))), onSaving);
  result.item._transfers = plans.map((plan) => ({ index: plan.index, name: plan.file.name, percent: 100, status: '已完成' }));
  return result.item;
}

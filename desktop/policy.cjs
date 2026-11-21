'use strict';
const { resolve, join } = require('node:path');
const { existsSync, realpathSync } = require('node:fs');
const { fileURLToPath, pathToFileURL } = require('node:url');

function dataDirectory({ explicit, portable, appData }) {
  // Keep the complete old profile in place: cookies, encrypted credentials,
  // drafts and both databases must move together, never only one SQLite file.
  const legacy=portable?join(portable,'星降る夜に-data'):join(appData,'HoshifuruYoruNi');
  return resolve(explicit || (existsSync(legacy)?legacy:portable?join(portable,'Tsukiakari-data'):join(appData,'Tsukiakari')));
}
function localNavigation(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}
function trustedDocument(value, expected) {
  try {
    if (value === pathToFileURL(expected).href) return true;
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.host || url.search || url.hash) return false;
    const path = fileURLToPath(url);
    // Chromium and Node can spell the same Windows file differently, including
    // drive casing and short paths. Electron's realpath also resolves ASAR files.
    return path === expected || (process.platform === 'win32' && /^[a-z]:\\/i.test(path)
      && realpathSync.native(path) === realpathSync.native(expected));
  } catch { return false; }
}
function externalLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
function modelConfig(value, current = {}) {
  const apiBase = String(value?.apiBase || '').trim().replace(/\/+$/, '');
  let url; try { url = new URL(apiBase); } catch { throw new Error('请填写有效的模型接口地址。'); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('模型接口须为 HTTPS，或本机 HTTP 地址，且不含账号或查询参数。');
  const apiKey = String(value?.apiKey || current.apiKey || '').trim(), model = String(value?.model || '').trim();
  if (!apiKey || apiKey.length > 4096 || /[\r\n\x00]/.test(apiKey)) throw new Error('请填写有效的模型密钥。');
  if (!model || model.length > 200 || /[\r\n\x00]/.test(model)) throw new Error('请填写有效的模型名称。');
  return { apiBase, apiKey, model };
}
module.exports = { dataDirectory, localNavigation, trustedDocument, externalLink, modelConfig };

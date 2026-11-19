'use strict';
const form = document.querySelector('#settings'), statusLine = document.querySelector('#status');
window.modelSettings.read().then((value) => {
  document.querySelector('#api-base').value = value.apiBase; document.querySelector('#model').value = value.model;
  document.querySelector('#api-key').required = !value.hasKey;
  document.querySelector('#key-hint').textContent = value.hasKey ? '已有密钥。留空可沿用；填写新值将替换。' : '尚未设置密钥。';
}).catch(() => { statusLine.textContent = '暂时无法读取设置，请关闭后重试。'; });
form.addEventListener('submit', async (event) => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; statusLine.textContent = '';
  try {
    const result = await window.modelSettings.save({ apiBase: document.querySelector('#api-base').value, model: document.querySelector('#model').value, apiKey: document.querySelector('#api-key').value });
    if (result.ok) document.querySelector('#api-key').value = '';
    statusLine.textContent = result.error || (result.canceled ? '尚未保存。' : '已保存，正在重新启动…');
  } catch { statusLine.textContent = '保存失败，输入仍保留，请重试。'; }
  finally { button.disabled = false; }
});

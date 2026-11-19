'use strict';
const { randomUUID } = require('node:crypto');

function createWindowPrompts({ BrowserWindow, ipcMain }, allowed) {
  const windows = new WeakSet(), pending = new Map(), checks = new Map();
  function sender(event) {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !windows.has(window) || event.senderFrame !== event.sender.mainFrame || !allowed(event.senderFrame?.url)) return null;
    return window;
  }
  ipcMain.on('hoshifuru:prompt:shown', (event, id) => {
    const request = pending.get(sender(event)?.id);
    if (request?.id === id) clearTimeout(request.timer);
  });
  ipcMain.on('hoshifuru:prompt:reply', (event, result) => {
    const request = pending.get(sender(event)?.id);
    if (!request || request.id !== result?.id || !request.choices.has(result.choice)) return;
    request.finish({ choice: result.choice, remember: request.remember && result.choice !== 'cancel' && result.remember === true });
  });
  ipcMain.on('hoshifuru:quit-check:reply', (event, result) => {
    const check = checks.get(sender(event)?.id);
    if (check && check.id === result?.id) check.finish(result.blocked === true);
  });

  function attach(window) {
    if (windows.has(window)) return;
    windows.add(window);
    const cancel = () => {
      pending.get(window.id)?.finish({ choice: 'cancel', remember: false });
      checks.get(window.id)?.finish(false);
    };
    window.once('closed', cancel);
    window.webContents.on('did-navigate', cancel);
    window.webContents.on('render-process-gone', cancel);
  }

  function ask(window, spec) {
    const cancel = { choice: 'cancel', remember: false };
    if (!window || window.isDestroyed() || !allowed(window.webContents.getURL())) return Promise.resolve(cancel);
    attach(window);
    if (pending.has(window.id)) return Promise.resolve(cancel);
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
    const id = randomUUID();
    return new Promise(resolve => {
      function finish(value) {
        if (pending.get(window.id) !== request) return;
        pending.delete(window.id);
        clearTimeout(request.timer);
        resolve(value);
      }
      const request = {
        id, remember: Boolean(spec.remember), choices: new Set(['cancel', ...spec.actions.map(action => action.id)]), finish,
        timer: setTimeout(() => finish(cancel), 4500),
      };
      pending.set(window.id, request);
      try { window.webContents.send('hoshifuru:prompt', { ...spec, id }); }
      catch { finish(cancel); }
    });
  }

  function checkUnfinished(window) {
    if (!window || window.isDestroyed() || !allowed(window.webContents.getURL())) return Promise.resolve(false);
    const id = randomUUID();
    return new Promise(resolve => {
      function finish(blocked) {
        if (checks.get(window.id)?.id !== id) return;
        checks.delete(window.id);
        clearTimeout(timer);
        resolve(blocked);
      }
      const timer = setTimeout(() => finish(false), 1000);
      checks.set(window.id, { id, finish });
      try { window.webContents.send('hoshifuru:quit-check', id); }
      catch { finish(false); }
    });
  }

  return { attach, ask, checkUnfinished };
}

module.exports = { createWindowPrompts };

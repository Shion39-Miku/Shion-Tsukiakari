'use strict';
const { contextBridge,ipcRenderer } = require('electron');
let closingGuard;
if (location.protocol === 'file:' && location.pathname.endsWith('/settings.html')) {
  contextBridge.exposeInMainWorld('modelSettings', Object.freeze({
    read: () => ipcRenderer.invoke('hoshifuru:model:read'),
    save: value => ipcRenderer.invoke('hoshifuru:model:save', { apiBase: value.apiBase, apiKey: value.apiKey, model: value.model }),
  }));
}
contextBridge.exposeInMainWorld('hoshifuruDesktop', Object.freeze({ platform: process.platform, desktop: true,
 setClosingGuard: handler => { if (typeof handler === 'function') closingGuard = handler; },
 getPreferences:()=>ipcRenderer.invoke('hoshifuru:preferences:get'),setPreferences:value=>ipcRenderer.invoke('hoshifuru:preferences:set',{closeAction:value.closeAction}),
 setContext:value=>ipcRenderer.invoke('hoshifuru:context',{threadId:value.threadId||null}).catch(()=>{}),
 setUnread:value=>ipcRenderer.invoke('hoshifuru:unread',{count:value.count,accountKey:value.accountKey,taskbar:value.taskbar}).catch(()=>{}),
 onVisibility:handler=>{
  let broadcast=false;
  const listener=(_event,hidden)=>{broadcast=true;handler(Boolean(hidden));};
  ipcRenderer.on('hoshifuru:visibility',listener);
  ipcRenderer.invoke('hoshifuru:visibility').then(hidden=>{if(!broadcast)handler(Boolean(hidden));}).catch(()=>{});
  return()=>ipcRenderer.removeListener('hoshifuru:visibility',listener);
 },
 notify:value=>ipcRenderer.invoke('hoshifuru:notify',{threadId:value.threadId,messageId:value.messageId,sender:value.sender,body:value.body,preferences:value.preferences}).catch(()=>{}),
 onOpenThread:handler=>{const listener=(_event,id)=>{if(/^[0-9a-f-]{36}$/i.test(id))handler(id);};ipcRenderer.on('hoshifuru:open-thread',listener);return()=>ipcRenderer.removeListener('hoshifuru:open-thread',listener);}
}));
ipcRenderer.on('hoshifuru:quit-check', (_event, id) => {
  let blocked = false;
  try { blocked = Boolean(closingGuard?.()); } catch { blocked = true; }
  ipcRenderer.send('hoshifuru:quit-check:reply', { id, blocked });
});
ipcRenderer.on('hoshifuru:message-sound',()=>{if(/^https?:$/.test(location.protocol)){const audio=new Audio(location.origin+'/assets/message.wav');audio.volume=.35;audio.play().catch(()=>{});}});

let promptId;
function showPrompt(spec) {
  if (promptId) return;
  promptId = spec.id;
  const make = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  };
  const host = make('div');
  host.id = 'tsukiakari-window-prompt';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = new CSSStyleSheet();
  style.replaceSync(nativePromptStyles);
  shadow.adoptedStyleSheets = [style];
  const dialog = make('dialog', 'tsuki-native-prompt');
  dialog.setAttribute('aria-labelledby', 'prompt-title');
  if (document.documentElement.classList.contains('reduce-motion')) dialog.setAttribute('data-static', '');
  const content = make('div', 'tsuki-prompt-content');
  const header = make('div', 'tsuki-prompt-header');
  const title = make('h2', null, spec.title);
  title.id = 'prompt-title';
  const close = make('button', 'prompt-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭提示');
  header.append(title, close);
  content.append(header, make('p', 'tsuki-prompt-copy', spec.message));
  if (spec.detail) content.append(make('p', 'tsuki-prompt-note', spec.detail));
  const remember = make('input');
  remember.type = 'checkbox';
  if (spec.remember) {
    const label = make('label', 'tsuki-prompt-remember');
    label.append(remember, make('span', null, '记住我的选择'));
    content.append(label);
  }
  const buttons = make('div', 'tsuki-prompt-actions');
  let focusTarget;
  for (const action of spec.actions) {
    const button = make('button', action.tone ? 'prompt-' + action.tone : null, action.label);
    button.type = 'button';
    button.onclick = () => answer(action.id);
    if (!focusTarget || action.id === 'cancel') focusTarget = button;
    buttons.append(button);
  }
  content.append(buttons);
  dialog.append(content);
  shadow.append(dialog);
  document.body.append(host);
  const surface = TsukiakariDialogs.bind(dialog, () => answer('cancel'));
  let answered = false;
  async function answer(choice) {
    if (answered) return;
    answered = true;
    const checked = remember.checked;
    await surface.close();
    // Keep the opener connected until the dialog's focus restoration has run.
    setTimeout(() => host.remove(), 0);
    promptId = null;
    ipcRenderer.send('hoshifuru:prompt:reply', { id: spec.id, choice, remember: checked });
  }
  close.onclick = () => answer('cancel');
  surface.open(focusTarget);
  ipcRenderer.send('hoshifuru:prompt:shown', spec.id);
}

ipcRenderer.on('hoshifuru:prompt', (_event, spec) => {
  if (document.body) showPrompt(spec);
  else window.addEventListener('DOMContentLoaded', () => showPrompt(spec), { once: true });
});

window.addEventListener('DOMContentLoaded', () => {
  if (!/^https?:$/.test(window.location.protocol)) return;
  document.body.classList.add('desktop-host');
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/desktop.css'; document.head.append(style);
  const bar = document.createElement('div'); bar.className = 'desktop-titlebar';
  const icon = document.createElement('img'); icon.src = '/assets/brand/tsukiakari-192.png'; icon.alt = ''; icon.width = 18; icon.height = 18;
  const label = document.createElement('span'); label.textContent = '月明かり';
  bar.append(icon, label); document.body.append(bar);
});

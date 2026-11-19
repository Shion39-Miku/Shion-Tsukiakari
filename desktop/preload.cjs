'use strict';
const { contextBridge,ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hoshifuruDesktop', Object.freeze({ platform: process.platform, desktop: true,
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
ipcRenderer.on('hoshifuru:message-sound',()=>{if(/^https?:$/.test(location.protocol)){const audio=new Audio(location.origin+'/assets/message.wav');audio.volume=.35;audio.play().catch(()=>{});}});
window.addEventListener('DOMContentLoaded', () => {
  if (!/^https?:$/.test(window.location.protocol)) return;
  document.body.classList.add('desktop-host');
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/desktop.css'; document.head.append(style);
  const bar = document.createElement('div'); bar.className = 'desktop-titlebar';
  const icon = document.createElement('img'); icon.src = '/assets/brand/tsukiakari-192.png'; icon.alt = ''; icon.width = 18; icon.height = 18;
  const label = document.createElement('span'); label.textContent = '月明かり';
  bar.append(icon, label); document.body.append(bar);
});

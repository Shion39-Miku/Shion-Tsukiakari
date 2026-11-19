'use strict';
const {execFile}=require('node:child_process');
const {deflateSync}=require('node:zlib');
const {join}=require('node:path');
const WINDOWS_NOTIFICATION_QUERY=`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class HoshifuruNotify{[DllImport("shell32.dll")]public static extern int SHQueryUserNotificationState(out int state);}'; $s=0; $r=[HoshifuruNotify]::SHQueryUserNotificationState([ref]$s); if($r -eq 0){[Console]::Write($s)}`;

function crc32(buffer){let c=0xffffffff;for(const b of buffer){c^=b;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;}return(c^0xffffffff)>>>0;}
function badgePng(count){const width=32,raw=Buffer.alloc((width*4+1)*width);const glyphs=['111101101101111','010110010010111','111001111100111','111001111001111','101101111001001','111100111001111','111100111101111','111001001001001','111101111101111','111101111001111'];const digits=String(Math.min(count,99)),bits=digits.split('').map(d=>glyphs[+d]);
 for(let y=0;y<width;y++)for(let x=0;x<width;x++){const at=y*(width*4+1)+1+x*4;const inside=(x-15.5)**2+(y-15.5)**2<225;raw[at]=219;raw[at+1]=164;raw[at+2]=200;raw[at+3]=inside?255:0;}
 const scale=3,total=digits.length*3*scale+(digits.length-1)*scale,start=Math.floor((32-total)/2);for(let d=0;d<bits.length;d++)for(let y=0;y<5;y++)for(let x=0;x<3;x++)if(bits[d][y*3+x]==='1')for(let yy=0;yy<scale;yy++)for(let xx=0;xx<scale;xx++){const at=(8+y*scale+yy)*(width*4+1)+1+(start+d*4*scale+x*scale+xx)*4;raw[at]=39;raw[at+1]=25;raw[at+2]=48;raw[at+3]=255;}
 function chunk(type,data){const name=Buffer.from(type),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([head,name,data,tail]);}const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(width,4);ihdr[8]=8;ihdr[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
function createDesktopFeatures(electron,{preferences,save,origin,authorize,iconPath,trayPath=iconPath}){
 const {app,BrowserWindow,Tray,Menu,Notification,nativeImage,ipcMain,dialog}=electron;
 const states=new Map(),nativeNotices=new Map();
 let tray,explicit=false,asking=false,dndCache={at:0,value:false},dndQuery,quitting=false,trayCount=0;
 const trusted=event=>{try{return event.senderFrame===event.sender.mainFrame&&new URL(event.senderFrame.url).origin===origin();}catch{return false;}};
 async function identity(event){if(!trusted(event))throw Error('不接受此窗口的请求。');const window=BrowserWindow.fromWebContents(event.sender);const user=await authorize(window);if(!user)throw Error('请先登录。');return{window,user};}
 const show=window=>{if(!window||window.isDestroyed())window=[...states.keys()].map(id=>BrowserWindow.fromId(id)).find(w=>w&&!w.isDestroyed());if(!window)return;if(window.isMinimized())window.restore();window.show();window.focus();};
 function unread(){const accounts=new Map();for(const s of states.values())if(s.accountKey)accounts.set(s.accountKey,Math.max(accounts.get(s.accountKey)||0,s.count||0));return[...accounts.values()].reduce((a,b)=>a+b,0);}
 function update(){
  const total=unread();
  if(tray && total!==trayCount){
   trayCount=total;
   tray.setImage(total?nativeImage.createFromBuffer(badgePng(total)).resize({width:20,height:20}):nativeImage.createFromPath(trayPath).resize({width:20,height:20}));
   tray.setToolTip('月明かり'+(total?' · '+total+'条未读':''));
   app.setBadgeCount(total);
  }
  for(const[id,state]of states){
   const window=BrowserWindow.fromId(id);
   if(!window||window.isDestroyed())continue;
   const count=state.taskbar===false?0:state.count;
   if(state.overlayCount===count)continue;
   state.overlayCount=count;
   window.setOverlayIcon(count?nativeImage.createFromBuffer(badgePng(count)):null,count?count+'条未读':'无未读消息');
   if(!count)window.flashFrame(false);
  }
 }
 function ensureTray(){if(tray)return;tray=new Tray(nativeImage.createFromPath(trayPath).resize({width:20,height:20}));tray.setToolTip('月明かり');tray.setContextMenu(Menu.buildFromTemplate([{label:'打开月明かり',click:()=>show()},{label:'退出软件',click:()=>app.quit()}]));tray.on('double-click',()=>show());tray.on('click',()=>show());}
 const windowHidden=window=>!window?.isVisible()||window.isMinimized();
 function attach(window){ensureTray();states.set(window.id,{count:0,threadId:null});window.on('closed',()=>{states.delete(window.id);update();});window.on('focus',()=>window.flashFrame(false));
  const visibility=()=>{if(!window.isDestroyed())window.webContents.send('hoshifuru:visibility',windowHidden(window));};
  for(const event of ['show','hide','minimize','restore'])window.on(event,visibility);
  window.on('query-session-end',()=>save());window.on('session-end',()=>{explicit=true;save();});
  window.on('close',async event=>{if(explicit||quitting)return;event.preventDefault();if(asking)return;const action=preferences.closeAction||'ask';if(action==='background'){window.hide();update();return;}if(action==='exit'){app.quit();return;}
   asking=true;try{const answer=await dialog.showMessageBox(window,{type:'question',title:'让星光继续陪伴',message:'关闭窗口后，要继续在后台接收消息吗？',detail:'后台运行会保留托盘入口、连接与消息提醒。',buttons:['后台运行','退出软件','取消'],defaultId:0,cancelId:2,checkboxLabel:'记住我的选择',checkboxChecked:false});if(answer.response===2)return;if(answer.checkboxChecked){preferences.closeAction=answer.response===0?'background':'exit';save();}if(answer.response===0){window.hide();update();}else app.quit();}finally{asking=false;}
  });
 }
 async function dndAllowsSound(){
  if(process.platform!=='win32')return true;
  if(Date.now()-dndCache.at<15000)return dndCache.value;
  if(dndQuery)return dndQuery;
  dndQuery=new Promise(resolve=>execFile(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',WINDOWS_NOTIFICATION_QUERY],{windowsHide:true,timeout:5000},(error,stdout)=>resolve(!error&&String(stdout).trim()==='5')))
   .then(value=>{dndCache={at:Date.now(),value};return value;})
   .finally(()=>{dndQuery=null;});
  return dndQuery;
 }
 ipcMain.handle('hoshifuru:preferences:get',event=>{if(!trusted(event))throw Error('不接受此窗口。');return{closeAction:preferences.closeAction||'ask'};});
 ipcMain.handle('hoshifuru:visibility',event=>trusted(event)&&windowHidden(BrowserWindow.fromWebContents(event.sender)));
 ipcMain.handle('hoshifuru:preferences:set',(event,value)=>{if(!trusted(event)||!['ask','background','exit'].includes(value?.closeAction))throw Error('关闭行为无效。');preferences.closeAction=value.closeAction;save();return{closeAction:value.closeAction};});
 ipcMain.handle('hoshifuru:context',async(event,value)=>{const{window,user}=await identity(event);if(value.threadId!==null&&!/^[0-9a-f-]{36}$/i.test(value.threadId||''))return;const s=states.get(window.id);if(s){s.accountKey=user.key;s.threadId=value.threadId;}return{ok:true};});
 ipcMain.handle('hoshifuru:unread',async(event,value)=>{
  if(!trusted(event))return;
  const window=BrowserWindow.fromWebContents(event.sender),state=states.get(window?.id);
  if(!state)return;
  const revision=state.badgeRevision=(state.badgeRevision||0)+1;
  if(value?.count===0){
   state.count=0;state.taskbar=value.taskbar;
   if(!value.accountKey){state.accountKey=null;state.threadId=null;}
   update();return;
  }
  const{user}=await identity(event);
  if(state.badgeRevision!==revision||window.isDestroyed()||value.accountKey&&user.key!==value.accountKey)return;
  state.accountKey=user.key;state.count=Math.max(0,Math.min(99999,Number(value.count)||0));state.taskbar=value.taskbar;
  update();return{ok:true};
 });
 ipcMain.handle('hoshifuru:notify',async(event,value)=>{const{window,user}=await identity(event);if(!value||!/^[0-9a-f-]{36}$/i.test(value.threadId)||!Number.isSafeInteger(value.messageId))return;
  for(const[id,s]of states){const w=BrowserWindow.fromId(id);if(s.accountKey===user.key&&s.threadId===value.threadId&&w?.isFocused()&&w.isVisible()&&!w.isMinimized())return{suppressed:true};}
  const prefs=value.preferences||{};
  if(!prefs.sound&&!prefs.taskbar&&!prefs.desktop)return{suppressed:true};
  const allowed=(prefs.sound||prefs.taskbar)&&await dndAllowsSound();
  if(window.isDestroyed())return;
  if(prefs.taskbar&&allowed)window.flashFrame(true);
  if(prefs.sound&&allowed)window.webContents.send('hoshifuru:message-sound');
  if(prefs.desktop&&Notification.isSupported()){
   const notice=new Notification({title:'月明かり · '+String(value.sender||'新消息').slice(0,40),body:String(value.body||'收到一条新消息').slice(0,140),silent:true,icon:iconPath});nativeNotices.set(value.messageId,notice);
   notice.on('click',()=>{show(window);window.webContents.send('hoshifuru:open-thread',value.threadId);});notice.on('close',()=>nativeNotices.delete(value.messageId));notice.on('failed',()=>nativeNotices.delete(value.messageId));notice.show();
  }update();return{notified:true,sound:!!prefs.sound&&allowed,taskbar:!!prefs.taskbar&&allowed};
 });
 app.on('before-quit',()=>{explicit=true;});
 return{attach,show,update,beginExit(){explicit=true;},cancelQuit(){explicit=false;},close(){quitting=true;for(const n of nativeNotices.values())n.close();nativeNotices.clear();if(tray){tray.destroy();tray=null;}},diagnostics(){return{tray:!!tray,unread:unread(),closeAction:preferences.closeAction||'ask',windows:states.size,notifications:nativeNotices.size};}};
}
module.exports={createDesktopFeatures,badgePng,WINDOWS_NOTIFICATION_QUERY};

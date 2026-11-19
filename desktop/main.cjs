'use strict';
const { app, BrowserWindow, Menu, dialog, shell, session, ipcMain, safeStorage, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const { join, dirname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { dataDirectory, localNavigation, externalLink, modelConfig } = require('./policy.cjs');
const {createDesktopFeatures}=require('./features.cjs');

app.setName('月明かり');
app.setAppUserModelId('wiki.shion.hoshifuru');
const dataDir = dataDirectory({ explicit: process.env.TSUKIAKARI_DESKTOP_DATA||process.env.HOSHIFURU_DESKTOP_DATA, portable: process.env.PORTABLE_EXECUTABLE_DIR, appData: app.getPath('appData') });
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const resources = app.isPackaged ? process.resourcesPath : join(__dirname, '.generated');
const backendDir = join(resources, 'backend'), databasePath = join(dataDir, 'data', 'chat.sqlite');
const configPath = join(dataDir, 'desktop-settings.json'), secretPath = join(dataDir, 'model-credentials.json');
let win, settingsWin, settingsOwner, child, origin, quitting = false, ready = false, pendingRelaunch = false;
let accessToken, accountWindowNumber = 0;
let desktopFeatures;
const state = global.__hoshifuruDesktop = { dataDir, databasePath, backendPid: null, origin: null, ready: false, packaged: app.isPackaged };

function readJson(path, fallback = {}) { try { return JSON.parse(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; } }
let preferences = readJson(configPath);
function writeJson(path, value) {
  const temporary = path + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, path);
}
function log(message) {
  try {
    const path = join(dataDir, 'desktop.log');
    if (fs.existsSync(path) && fs.statSync(path).size > 1024 * 1024) fs.renameSync(path, path + '.previous');
    fs.appendFileSync(path, new Date().toISOString() + ' ' + message + '\n');
  } catch { /* Logging must not prevent startup. */ }
}
function savedModel() {
  if (fs.existsSync(secretPath)) {
    try {
      const encrypted = readJson(secretPath).encrypted;
      return JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    } catch { log('模型凭据无法解密，请在应用菜单重新设置。'); return {}; }
  }
  const reference = readJson(join(resources, 'initial-model.json'));
  const path = process.env.TSUKIAKARI_MODEL_FILE||process.env.HOSHIFURU_DESKTOP_MODEL_FILE || reference.file || (dataDir.endsWith('HoshifuruYoruNi')?join(app.getPath('home'),'.codex','secrets','hoshifuru-ai.json'):null);
  return path ? readJson(path) : {};
}
function relaunch() {
  pendingRelaunch = true; app.quit();
}
async function availablePort(preferred) {
  const port = Number.isInteger(preferred) && preferred >= 1024 && preferred <= 65535 ? preferred : 4180;
  for (let offset = 0; offset < 20; offset++) {
    const candidate = offset ? 0 : port, probe = createServer();
    const found = await new Promise((done) => {
      probe.once('error', () => done(null));
      probe.listen(candidate, '127.0.0.1', () => { const actual = probe.address().port; probe.close(() => done(actual)); });
    });
    if (found) return found;
  }
  throw new Error('无法开启本机服务端口。');
}
function seedDatabase() {
  fs.mkdirSync(dirname(databasePath), { recursive: true });
}
async function startBackend() {
  const remoteServer=process.env.TSUKIAKARI_CHAT_SERVER_URL||process.env.HOSHIFURU_CHAT_SERVER_URL;
  if(remoteServer){const url=new URL(remoteServer);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/')throw Error('远程聊天后端须为HTTPS站点根地址。');origin=url.origin;state.origin=origin;state.serverMode='remote';ready=true;state.ready=true;configureSession(session.defaultSession);return;}
  seedDatabase();
  const port = await availablePort(preferences.port); accessToken = randomBytes(32).toString('hex');
  origin = 'http://127.0.0.1:' + port; state.origin = origin;
  configureSession(session.defaultSession);
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  child = spawn(join(backendDir, 'runtime', 'node.exe'), ['--disable-warning=ExperimentalWarning', join(backendDir, 'desktop-backend.mjs')], {
    cwd: backendDir, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  state.backendPid = child.pid;
  child.on('message',value=>{if(value?.type!=='connection-save')return;try{if(!safeStorage.isEncryptionAvailable())throw Error('系统凭据加密不可用。');writeJson(join(dataDir,'connection-credentials.json'),{encrypted:safeStorage.encryptString(JSON.stringify(value.value)).toString('base64')});child.send({type:'connection-saved',id:value.id});}catch{child.send({type:'connection-saved',id:value.id,error:'连接凭据安全保存失败，原配置保留。'});}});
  child.stdout.on('data', (data) => log('service: ' + String(data).trim()));
  child.stderr.on('data', (data) => log('service: ' + String(data).trim()));
  child.on('error', (error) => log('service: ' + error.message));
  child.on('exit', (code) => {
    state.backendPid = null;
    if (ready && !quitting) { log('本地服务退出，code=' + code); dialog.showErrorBox('本地服务已停止', '聊天与数据已保存在本机，请重新启动月明かり。若仍失败，可在应用数据文件夹查看 desktop.log。'); app.quit(); }
  });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('本地服务启动超时。')), 45_000);
    const finish = (error) => { clearTimeout(timer); child.off('exit', earlyExit); child.off('error', finish); child.off('message', message); error ? reject(error) : done(); };
    const earlyExit = () => finish(new Error('本地服务未能启动，请查看数据文件夹内的 desktop.log。'));
    const message = (value) => { if (value?.type === 'ready' && value.port === port) {state.websiteOrigin=value.websitePort?'http://127.0.0.1:'+value.websitePort:null;finish();} else if (value?.type === 'failed') earlyExit(); };
    child.once('error', finish); child.once('exit', earlyExit); child.on('message', message);
    const model = savedModel();
    const astrbotReference=readJson(join(resources,'initial-astrbot.json'));
    const astrbotFile=process.env.TSUKIAKARI_ASTRBOT_FILE||process.env.HOSHIFURU_DESKTOP_ASTRBOT_FILE||astrbotReference.file||(dataDir.endsWith('HoshifuruYoruNi')?join(app.getPath('home'),'.codex','secrets','hoshifuru-astrbot.json'):null);
    let astrbot=astrbotFile?readJson(astrbotFile):{};const saved=readJson(join(dataDir,'connection-credentials.json'));if(saved.encrypted&&!process.env.TSUKIAKARI_ASTRBOT_FILE&&!process.env.HOSHIFURU_DESKTOP_ASTRBOT_FILE)try{astrbot=JSON.parse(safeStorage.decryptString(Buffer.from(saved.encrypted,'base64')));}catch{log('连接凭据不可解密，原文件保留。');}
    child.send({ type: 'start', port, dbPath: databasePath, accessToken,astrbot,legacyDbPath:join(dataDir,'data','moonlit.sqlite'),seedDbPath:join(resources,'seed','moonlit.sqlite'),websiteSeedDbPath:join(resources,'seed','website.sqlite'),websiteDbPath:join(dataDir,'data','website.sqlite'),
      chat: { apiBase: model.apiBase || '', apiKey: model.apiKey || '', model: model.model || '', assistantName: '大肥鱼' } });
  });
  preferences.port = port; writeJson(configPath, preferences);
  ready = true; state.ready = true;
}
function configureSession(accountSession) {
  accountSession.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, (details, done) => done({ requestHeaders: { ...details.requestHeaders,...(accessToken?{'X-Hoshifuru-Desktop':accessToken}:{}) } }));
  accountSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  accountSession.setPermissionCheckHandler(() => false);
}
async function newAccountWindow() {
  if (!ready || quitting) return;
  const partition = 'persist:account-window-' + (++accountWindowNumber);
  configureSession(session.fromPartition(partition));
  const extra = new BrowserWindow({ width: 1100, height: 820, minWidth: 720, minHeight: 540, title: '月明かり', show: false, backgroundColor: '#101321',
    icon: join(__dirname, 'icon.ico'), autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#11141f', symbolColor: '#dec9e1', height: 32 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, navigateOnDragDrop: false } });
  safeWebContents(extra); extra.once('ready-to-show', () => extra.show()); await extra.loadURL(origin + '/chat');
}
async function stopBackend() {
  if (!child || child.exitCode !== null) return;
  await new Promise((done) => {
    const processToStop = child;
    const timeout = setTimeout(() => { processToStop.kill(); done(); }, 6500);
    processToStop.once('exit', () => { clearTimeout(timeout); done(); });
    try { processToStop.send({ type: 'shutdown' }); } catch { processToStop.kill(); }
  });
}
function safeWebContents(window) {
  desktopFeatures?.attach(window);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (externalLink(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!origin || !localNavigation(url, origin)) { event.preventDefault(); if (externalLink(url)) shell.openExternal(url).catch(() => {}); } });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window, { type: 'question', title: '保留这一刻', message: '有尚未保存的修改，仍要退出吗？', buttons: ['继续编辑', '退出'], defaultId: 0, cancelId: 0 });
    if (choice === 1) event.preventDefault();
    else {pendingRelaunch = false;desktopFeatures?.cancelQuit();}
  });
}
async function verifiedAdmin(window) {
  if (!ready || !window || window.isDestroyed() || !localNavigation(window.webContents.getURL(), origin)) return false;
  try {
    const cookies = await window.webContents.session.cookies.get({ url: origin });
    const response = await fetch(origin + '/api/chat/session', { headers: { 'X-Hoshifuru-Desktop': accessToken, Cookie: cookies.map(({ name, value }) => name + '=' + value).join('; ') }, signal: AbortSignal.timeout(3000) });
    return response.ok && (await response.json()).role === 'admin';
  } catch { return false; }
}
async function verifiedAccount(window){
 if(!ready||!window||window.isDestroyed()||!localNavigation(window.webContents.getURL(),origin))return null;
 try{const cookies=await window.webContents.session.cookies.get({url:origin});const r=await fetch(origin+'/api/chat/session',{headers:{'X-Hoshifuru-Desktop':accessToken,Cookie:cookies.map(({name,value})=>name+'='+value).join('; ')},signal:AbortSignal.timeout(3000)});return r.ok?await r.json():null;}catch{return null;}
}
async function adminNativeAction(action) {
  const window = BrowserWindow.getFocusedWindow() || win;
  if (!await verifiedAdmin(window)) { await dialog.showMessageBox(window || undefined, { type: 'info', title: '需要管理员账号', message: '请在当前窗口登录管理员账号后使用此功能。' }); return; }
  return action(window);
}
async function showSettings() {
  const owner = BrowserWindow.getFocusedWindow() === settingsWin ? settingsOwner : BrowserWindow.getFocusedWindow() || win;
  if (!await verifiedAdmin(owner)) { await dialog.showMessageBox(owner || undefined, { type: 'info', title: '需要管理员账号', message: '请在当前窗口登录管理员账号后修改模型连接。' }); return; }
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsOwner = owner;
  settingsWin = new BrowserWindow({ parent: owner, modal: true, width: 540, height: 570, resizable: false, title: '备用模型连接 · 月明かり', backgroundColor: '#141623', autoHideMenuBar: true,
    icon: join(__dirname, 'icon.ico'), webPreferences: { preload: join(__dirname, 'settings-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
  settingsWin.setMenu(null); settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.webContents.on('will-navigate', (event) => event.preventDefault());
  settingsWin.on('closed', () => { settingsWin = null; settingsOwner = null; }); settingsWin.loadFile(join(__dirname, 'settings.html'));
}
function settingSender(event) {
  return settingsWin && event.sender === settingsWin.webContents && event.senderFrame === settingsWin.webContents.mainFrame && event.senderFrame.url === pathToFileURL(join(__dirname, 'settings.html')).href;
}
ipcMain.handle('hoshifuru:model:read', async (event) => {
  if (!settingSender(event) || !await verifiedAdmin(settingsOwner)) throw new Error('无权读取设置。');
  const model = savedModel(); return { apiBase: model.apiBase || 'https://api.deepseek.com/v1', model: model.model || '', hasKey: Boolean(model.apiKey) };
});
ipcMain.handle('hoshifuru:model:save', async (event, value) => {
  if (!settingSender(event) || !await verifiedAdmin(settingsOwner)) throw new Error('无权修改设置。');
  try {
    const model = modelConfig(value, savedModel());
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密暂不可用，尚未保存密钥。');
    const result = await dialog.showMessageBox(settingsWin, { type: 'question', title: '保存模型连接', message: '保存后需要重新启动应用。请先确认没有正在上传或等待的回复。', buttons: ['保存并重启', '取消'], defaultId: 1, cancelId: 1 });
    if (result.response !== 0) return { canceled: true };
    writeJson(secretPath, { encrypted: safeStorage.encryptString(JSON.stringify(model)).toString('base64') });
    setTimeout(() => relaunch(), 100); return { ok: true };
  } catch (error) { return { error: error.message }; }
});
function setMenu() {
  const template = [
    { label: '月明かり', submenu: [ { label: '新建登录窗口', accelerator: 'CmdOrCtrl+Shift+N', click: () => newAccountWindow().catch((error) => log(error.message)) }, { label: '备用模型连接设置…', click: () => showSettings().catch((error) => log(error.message)) }, { type: 'separator' }, { label: '打开数据文件夹', click: () => adminNativeAction(() => shell.openPath(dataDir)).catch((error) => log(error.message)) },
      { label: '关于月明かり', click: () => dialog.showMessageBox(win, { title: '月明かり', message: '月明かり', detail: '版本 ' + app.getVersion() + '\n聊天、月光庭院与网站管理。\n全部本地数据保存在：\n' + dataDir, icon: join(__dirname, 'icon.png') }) }, { type: 'separator' }, { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() } ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '视图', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大界面' }, { role: 'zoomOut', label: '缩小界面' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' }, { role: 'minimize', label: '最小化' }] },
  ]; Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
async function main() {
  await app.whenReady(); nativeTheme.themeSource = 'dark';
  desktopFeatures=createDesktopFeatures(require('electron'),{preferences,save:()=>writeJson(configPath,preferences),origin:()=>origin,authorize:verifiedAccount,iconPath:join(__dirname,'icon.png'),trayPath:join(__dirname,'tray.png')});
  state.features=()=>desktopFeatures.diagnostics();
  const bounds = preferences.window || {};
  win = new BrowserWindow({ width: Math.max(880, Math.min(2560, bounds.width || 1320)), height: Math.max(600, Math.min(1600, bounds.height || 900)), minWidth: 800, minHeight: 580,
    title: '月明かり', icon: join(__dirname, 'icon.ico'), backgroundColor: '#101321', show: false, autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#11141f', symbolColor: '#dec9e1', height: 32 },
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, navigateOnDragDrop: false } });
  setMenu();
  win.on('close', () => { if (!win.isDestroyed()) { preferences.window = { ...win.getNormalBounds(), maximized: win.isMaximized() }; writeJson(configPath, preferences); } });
  win.on('closed', () => { win = null; });
  win.webContents.on('render-process-gone', (_event, details) => { if (!quitting) log('界面进程退出：' + details.reason); });
  win.once('ready-to-show', () => { win.show(); if (bounds.maximized) win.maximize(); });
  await win.loadFile(join(__dirname, 'splash.html'));
  try { await startBackend(); safeWebContents(win); await win.loadURL(origin + '/chat'); }
  catch (error) { log(error.message); dialog.showErrorBox('月明かり未能启动', error.message + '\n数据保留在：' + dataDir); app.quit(); }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', (event) => {
    if (!child || child.exitCode !== null) {
      desktopFeatures?.close();
      if (pendingRelaunch) app.relaunch({ execPath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [] });
      return;
    }
    event.preventDefault(); if (quitting) return; quitting = true;
    stopBackend().finally(() => { child = null;desktopFeatures?.close(); app.quit(); });
  });
  main().catch((error) => { log(error.message); dialog.showErrorBox('启动失败', '请查看应用数据文件夹中的 desktop.log。'); app.quit(); });
}

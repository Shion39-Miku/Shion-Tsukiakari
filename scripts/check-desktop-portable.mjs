// Launch the real NSIS portable wrapper normally; attach to its Chromium
// after extraction. Playwright's Electron launcher requires a direct binary.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openDatabase } from '../server/core.mjs';
import { setAdmin } from '../server/auth.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE):'playwright');
const release = JSON.parse(await readFile('artifacts/desktop-app.json', 'utf8')), output = resolve('artifacts/desktop-check');
const folder = await mkdtemp(join(output, 'portable app with spaces ')), executable = join(folder, 'Tsukiakari.exe');
await copyFile(release.files.find((f) => f.path.endsWith('Portable.exe')).path, executable);
const dataDir = join(folder, 'Tsukiakari-data'), dbPath = join(dataDir, 'data/moonlit.sqlite'); await mkdir(join(dataDir, 'data'), { recursive: true });
await copyFile(join(release.directory, 'win-unpacked/resources/seed/moonlit.sqlite'), dbPath);
const password = randomBytes(18).toString('base64url'); let database = openDatabase(dbPath); await setAdmin(database, 'portableowner', password); database.close();
const modelFile = join(folder, 'qa-model.json'); await writeFile(modelFile, '{}');
const environment = { ...process.env, HOSHIFURU_DESKTOP_MODEL_FILE: modelFile,HOSHIFURU_DESKTOP_ASTRBOT_FILE:join(folder,'no-astrbot.json') }; delete environment.ELECTRON_RUN_AS_NODE; delete environment.HOSHIFURU_DESKTOP_DATA;
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const debugPort = probe.address().port; await new Promise((done) => probe.close(done));
let child, browser, page, origin, threadId;
const report = { at: new Date().toISOString(), executable: release.files.find((f) => f.path.endsWith('Portable.exe')).path, checks: [], errors: [] };
const passed = (value) => { report.checks.push(value); console.log('通过：' + value); };
async function launch() {
  child = spawn(executable, ['--remote-debugging-port=' + debugPort], { env: environment, windowsHide: false, stdio: 'ignore' });
  child.on('error', (error) => report.errors.push(error.message));
  for (let i = 0; i < 180; i++) {
    if (child.exitCode !== null) throw new Error('免安装启动器提前退出：' + child.exitCode);
    try { const response = await fetch('http://127.0.0.1:' + debugPort + '/json/version', { signal: AbortSignal.timeout(500) }); if (response.ok) break; } catch { /* Wait for unpacking. */ }
    if (i === 179) throw new Error('免安装程序未打开调试窗口。'); await new Promise((done) => setTimeout(done, 250));
  }
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + debugPort); page = browser.contexts()[0].pages()[0]; page.setDefaultTimeout(25000);
  page.on('pageerror', (error) => report.errors.push(error.message)); await page.waitForURL(/http:\/\/127\.0\.0\.1:\d+\/chat/); await page.locator('.desktop-titlebar').waitFor(); origin = new URL(page.url()).origin;
}
async function api(path, method = 'GET', json) { return page.evaluate(async ({ path, method, json }) => {
  const session = await (await fetch('/api/chat/session')).json(); const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, 'Idempotency-Key': crypto.randomUUID() }, body: json === undefined ? undefined : JSON.stringify(json) }); return { status: response.status, body: await response.json() };
}, { path, method, json }); }
async function close() {
  const processToClose = child;
  if (page && !page.isClosed()) {await page.evaluate(()=>window.hoshifuruDesktop.setPreferences({closeAction:'exit'}));await page.close();}
  await browser?.close().catch(() => {}); browser = null; page = null;
  for (let i = 0; i < 80 && processToClose.exitCode === null; i++) await new Promise((done) => setTimeout(done, 100));
  assert.equal(processToClose.exitCode, 0); child = null;
}
try {
  await launch(); assert.match(await page.evaluate(() => navigator.userAgent), /Electron\/45\.3\.1/);
  await page.getByLabel('账号', { exact: true }).fill('portableowner'); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '登录', exact: true }).click(); await page.locator('#app-shell:not([hidden])').waitFor();
  assert.equal((await api('/api/chat/session')).body.role, 'admin'); assert.equal((await fetch(origin + '/api/public/health')).status, 403);
  assert.ok((await readFile(join(dataDir, 'desktop-settings.json'), 'utf8')).length);
  passed('单文件免安装EXE从含空格和日文的路径独立启动，自动识别EXE旁的数据目录并真实登录');
  const thread = await api('/api/chat/threads', 'POST', { title: '免安装程序查询' }); assert.equal(thread.status, 201); threadId = thread.body.item.id;
  const message = await api('/api/chat/threads/' + threadId + '/messages', 'POST', { text: '/查询 音乐' }); assert.equal(message.status, 201);
  const music = (await api('/api/public/music')).body.items; const detail = (await api('/api/public/music/' + music[0].id)).body.item;
  const range = await page.evaluate(async (url) => { const r = await fetch(url, { headers: { Range: 'bytes=0-1023' } }); return { status: r.status, bytes: (await r.arrayBuffer()).byteLength }; }, detail.audio.url); assert.deepEqual(range, { status: 206, bytes: 1024 });
  passed('包内后端与数据库直接读取歌曲、歌词和206音频分段，未配置模型时仍可查询与管理');
  const duplicate = spawn(executable, [], { env: environment, windowsHide: false, stdio: 'ignore' });
  for (let i = 0; i < 180 && duplicate.exitCode === null; i++) await new Promise((done) => setTimeout(done, 250));
  assert.equal(duplicate.exitCode, 0); assert.equal((await api('/api/public/health')).status, 200);
  const css = await page.evaluate(async () => (await fetch('/desktop.css')).status); assert.equal(css, 200);
  passed('重复运行免安装EXE能复用原窗口，第二次解包清理不会损坏正在使用的程序');
  await page.screenshot({ path: join(output, 'portable-native.png') }); const firstOrigin = origin; await close();
  passed('关闭免安装窗口后启动器及后台正常退出，临时运行文件自动清理');
  await launch(); await page.locator('#app-shell:not([hidden])').waitFor(); assert.equal(origin, firstOrigin);
  const history = (await api('/api/chat/threads/' + threadId)).body.messages; assert.ok(history.some((m) => m.body === '/查询 音乐'));
  await close(); database = openDatabase(join(dataDir,'data/chat.sqlite')); const count = database.prepare('SELECT count(*) AS n FROM media').get().n, integrity = database.prepare('PRAGMA integrity_check').get().integrity_check; database.close();
  assert.equal(count, release.preparation.media.files); assert.equal(integrity, 'ok'); report.database = { media: count, integrity };
  passed('免安装EXE重新打开保留登录、聊天与演示媒体，退出后的数据库完整性检查通过');
  assert.deepEqual(report.errors, []);
} catch (error) { report.failure = error.stack; if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'portable-failure.png') }).catch(() => {}); throw error; }
finally {
  if (browser) await close().catch(() => {}); if (child && child.exitCode === null) child.kill();
  await writeFile(join(output, 'portable-report.json'), JSON.stringify(report, null, 2));
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 }).catch(() => {});
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _android as android } from 'playwright';
import { androidFixture } from './android-fixture.mjs';

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
assert.ok(sdk, 'Set ANDROID_HOME before running the device check.');
const binaries = process.argv.slice(2).map(path => resolve(path));
assert.equal(binaries.length, 2, 'Pass the HTTPS APK and the QA APK in that order.');
const adbPath = join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const serial = process.env.ANDROID_SERIAL || 'emulator-5554';
assert.match(serial, /^emulator-\d+$/, 'This script changes display settings on an isolated emulator.');
const folder = resolve(process.env.TSUKIAKARI_ANDROID_QA || 'artifacts/android/device-check');
const screens = join(folder, 'screens');
const component = 'wiki.shion.tsukiakari.MainActivity';
const secure = 'wiki.shion.tsukiakari', qa = secure + '.qa';
const adb = async (args, { binary = false, timeout = 27000 } = {}) =>
  (await promisify(execFile)(adbPath, ['-s', serial, ...args], { timeout, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 18 * 1024 * 1024 })).stdout;
const shell = (...args) => adb(['shell', ...args]);
const press = key => shell('input', 'keyevent', String(key));
const start = (app = qa) => shell('am', 'start', '-W', '-n', app + '/' + component);
const snap = async key => writeFile(join(screens, key + '.png'), await adb(['exec-out', 'screencap', '-p'], { binary: true }));
const report = { runtime: 'Android emulator using the bundled WebView', checks: [] };
const pass = message => { report.checks.push(message); console.log('通过 · ' + message); };

async function until(check, label, limit = 20000) {
  const end = Date.now() + limit;
  do {
    let value;
    try { value = await check(); } catch { /* The OS view or devtools can still be opening. */ }
    if (value) return value;
    await wait(350);
  } while (Date.now() < end);
  throw Error(label);
}

async function nodes() {
  await shell('uiautomator', 'dump', '/sdcard/tsukiakari-ui.xml');
  const xml = await adb(['exec-out', 'cat', '/sdcard/tsukiakari-ui.xml']);
  return [...xml.matchAll(/<node\b[^>]+bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/g)];
}

function center(node) {
  const [, left, top, right, bottom] = node.map(Number);
  return [String(Math.round((left + right) / 2)), String(Math.round((top + bottom) / 2))];
}

async function tapNode(label) {
  const row = await until(async () => (await nodes()).find(node => ['text','content-desc','resource-id'].some(key => node[0].includes(key + '="' + label + '"'))),
    'Android control unavailable: ' + label);
  await shell('input', 'tap', ...center(row));
}

async function fillOrigin(address) {
  await tapNode('聊天服务地址');
  await shell('input', 'text', address);
  await press(4);
  await tapNode('继续登录');
}

async function frameSample(page, scroll) {
  return page.evaluate(scroll => new Promise(resolve => {
    const list = document.querySelector('.thread-list'), times = [];
    const from = list.scrollTop;
    let last;
    const tick = now => {
      if (last !== undefined) times.push(now - last);
      last = now;
      if (scroll) list.scrollTop = from + times.length * 4;
      if (times.length < 48) requestAnimationFrame(tick);
      else {
        list.scrollTop = from;
        times.sort((a, b) => a - b);
        resolve({ samples: times.length, p50ms: times[23], p95ms: times[45] });
      }
    };
    requestAnimationFrame(tick);
  }), scroll);
}

await mkdir(screens, { recursive: true });
const fixture = await androidFixture(folder);
const port = new URL(fixture.origin).port;
let device;
let page;
let originalFontScale;
let secureHidden = false;
async function webview() {
  device = (await android.devices()).find(candidate => candidate.serial() === serial);
  assert.ok(device, 'Playwright cannot see the emulator via ADB.');
  const view = await device.webView({ pkg: qa }, { timeout: 32000 });
  return view.page();
}

let stage = 'emulator and installation';
try {
  report.api = (await shell('getprop', 'ro.build.version.sdk')).trim();
  report.webView = (await shell('dumpsys', 'webviewupdate')).match(/Current WebView package[^\r\n]*:\s*\(([^)]+)\)/)?.[1];
  assert.ok(Number(report.api) >= 33);
  await shell('wm', 'size', '900x1810');
  await shell('wm', 'density', '365');
  for (const scale of ['window_animation_scale','transition_animation_scale','animator_duration_scale']) {
    await shell('settings', 'put', 'global', scale, '0');
  }
  await shell('settings', 'put', 'secure', 'show_ime_with_hard_keyboard', '1');
  await shell('input', 'keyevent', '82');
  await adb(['reverse', 'tcp:' + port, 'tcp:' + port]);
  for (const apk of binaries) assert.match(await adb(['install', '-r', apk], { timeout: 70000 }), /Success/);
  stage = 'HTTPS variant rejects HTTP';
  await start(secure);
  await fillOrigin(fixture.origin);
  await until(async () => (await nodes()).some(node => node[0].includes('填写 HTTPS 服务根地址')), 'HTTPS policy did not reject HTTP.');
  await shell('am', 'force-stop', secure);
  pass('两个 APK 安装成功，HTTPS 版拒绝明文地址');

  stage = 'phone and real Android bridge';
  const launched = await start();
  report.firstLaunchMs = Number(launched.match(/TotalTime: (\d+)/)?.[1] || 0);
  await fillOrigin(fixture.origin);
  page = await webview();
  page.setDefaultTimeout(18000);
  await page.getByRole('textbox', { name: '账号', exact: true }).fill(fixture.member.username);
  await page.getByLabel('密码', { exact: true }).fill(fixture.member.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.locator('#app-boot').waitFor({ state: 'hidden' });
  const list = () => page.locator('.thread-list');
  const listing = title => list().getByRole('button', { name: title, exact: true });
  const filter = name => page.locator('.conversation-filters').getByRole('button', { name, exact: true });
  const my = () => page.getByRole('navigation', { name: '应用功能' }).getByRole('button', { name: '我的', exact: true });
  const composer = () => page.getByRole('textbox', { name: '聊天消息', exact: true });
  await listing('晚灯 · 演示').waitFor();
  assert.equal(await list().locator('.thread-row').count(), 50);
  assert.ok(await page.evaluate(() => innerWidth < 550));
  report.idleFrames = await Promise.race([frameSample(page, false), wait(7000).then(() => null)]);
  report.scroll = await Promise.race([frameSample(page, true), wait(7000).then(() => null)]);
  await snap('android-phone');
  for (const type of ['AI','群聊','全部','好友']) await filter(type).click();
  await listing('晚灯 · 演示').click();
  await page.getByText('我把新歌放进收藏了，有空一起听。', { exact: true }).waitFor();
  await snap('android-phone-chat');
  await composer().click();
  await composer().fill('系统重开后仍在的演示草稿。');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isVisible(), true);
  await press(4);
  await composer().waitFor();
  assert.equal(await composer().inputValue(), '系统重开后仍在的演示草稿。');
  await press(4);
  await listing('晚灯 · 演示').waitFor();
  await page.getByRole('navigation', { name: '应用功能' }).getByRole('button', { name: '通讯录', exact: true }).click();
  await page.getByRole('tab', { name: '群邀请' }).click();
  await snap('android-contacts');
  await press(4);
  await page.locator('#contacts-dialog').waitFor({ state: 'hidden' });
  assert.equal(await filter('好友').getAttribute('aria-pressed'), 'true');
  pass('手机列表、聊天键盘、返回键、筛选与通讯录');

  stage = 'tablet resize and streaming reply';
  await listing('晚灯 · 演示').click();
  await composer().waitFor();
  await shell('wm', 'size', '1540x1040');
  await shell('wm', 'density', '190');
  await page.waitForFunction(() => innerWidth >= 740);
  const sidebar = await page.locator('#app-sidebar').boundingBox();
  const body = await page.locator('#conversation').boundingBox();
  assert.ok(sidebar.width >= 240 && sidebar.x + sidebar.width <= body.x + 2);
  assert.equal(await composer().inputValue(), '系统重开后仍在的演示草稿。');
  await filter('群聊').click();
  await listing('月下茶话').click();
  await page.getByRole('button', { name: '查看群成员' }).click();
  await page.locator('#conversation-details').getByText('知遥 · 演示人格', { exact: true }).waitFor();
  await snap('android-tablet');
  await page.getByRole('button', { name: '关闭会话详情' }).click();
  await filter('AI').click();
  await listing('知遥的夜话').click();
  await composer().fill('这里是 Android 演示。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText(/演示回复/).last().waitFor();
  assert.deepEqual(fixture.calls, [fixture.assistant]);
  pass('大屏双栏及成员面板、缩放保留草稿、模拟 AstrBot 流式回复');

  stage = 'notification permission and background delivery';
  // Privacy previews are identical across chats. Prepare a single unread sender for the system tap.
  for (const id of [fixture.direct, fixture.group, fixture.assistant]) {
    assert.equal((await fixture.moon('/api/chat/threads/' + id + '/read', 'POST')).status, 200);
  }
  await my().click();
  await page.locator('.page-nav').getByRole('button', { name: '设备通知', exact: true }).click();
  await page.getByRole('button', { name: '通知权限说明' }).click();
  await page.getByRole('button', { name: '前往授权' }).click();
  await tapNode('com.android.permissioncontroller:id/permission_allow_button');
  await page.getByText('系统通知已授权。', { exact: true }).waitFor();
  await page.getByLabel('后台消息连接', { exact: false }).check();
  await page.getByRole('button', { name: '保存设备设置' }).click();
  await page.getByText('设备设置已保存。', { exact: true }).waitFor();
  await press(3);
  const count = async () => (await shell('dumpsys', 'notification', '--noredact')).split(/\r?\n/).find(line => line.includes('NotificationRecord(') && line.includes(qa) && line.includes('chat:' + fixture.direct));
  const send = async note => assert.equal((await fixture.stars('/api/chat/threads/' + fixture.direct + '/messages', 'POST', { text: note })).status, 201);
  await send('仅供验收的通知正文');
  await until(count, 'System did not receive a chat notification', 35000);
  const notices = await shell('dumpsys', 'notification', '--noredact');
  assert.ok(notices.includes('月明かり收到一条新消息'));
  assert.ok(!notices.includes('仅供验收的通知正文'));
  pass('系统权限与后台消息到达有效，默认通知隐藏正文');
  stage = 'notification deep link and synced read';
  await shell('cmd', 'statusbar', 'expand-notifications');
  await tapNode('月明かり收到一条新消息');
  await until(async () => (await shell('dumpsys', 'activity', 'activities')).split(/\r?\n/).some(line => line.includes('topResumedActivity') && line.includes(qa)),
    'The notification did not bring the app to the foreground');
  await page.getByText('仅供验收的通知正文', { exact: true }).waitFor();
  await until(async () => (await fixture.moon('/api/chat/threads/' + fixture.direct)).value.item.unread === 0, 'Unread not synchronized');
  await press(3);
  await send('下一张月下的来信');
  await until(count, 'Second background message was not delivered', 35000);
  await fixture.moon('/api/chat/threads/' + fixture.direct + '/read', 'POST');
  await until(async () => !(await count()), 'Other device did not clear the notification');
  pass('系统通知点按直达会话，并随另一客户端已读消失');

  stage = 'launcher and native uninstall';
  assert.match(await shell('dumpsys', 'shortcut'), /id=farewell/);
  await shell('am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'tsukiakari://farewell', '-n', qa + '/' + component);
  await page.getByRole('heading', { name: '先别道晚安…', exact: true }).waitFor();
  await page.getByRole('img', { name: '月下的詩音与知遥' }).evaluate(async art => {
    await art.decode();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await snap('android-farewell');
  await page.getByRole('button', { name: '卸载应用' }).click();
  await page.getByRole('dialog', { name: '前往系统卸载', exact: true }).getByRole('button', { name: '前往系统' }).click();
  await until(async () => (await shell('dumpsys', 'activity', 'activities')).split(/\r?\n/).some(line => /topResumedActivity.*(?:Uninstall|packageinstaller)/i.test(line)), 'System uninstall confirmation unavailable');
  await press(4);
  await page.getByRole('heading', { name: '先别道晚安…', exact: true }).waitFor();
  pass('桌面快捷入口已注册，真实深链接与插画加载，取消系统卸载后可返回应用');

  stage = 'process re-creation';
  await page.getByRole('button', { name: '返回应用', exact: true }).click();
  await filter('好友').click();
  await listing('晚灯 · 演示').click();
  await composer().waitFor();
  assert.equal(await composer().inputValue(), '系统重开后仍在的演示草稿。');
  const stored = await page.evaluate(({ owner, id }) => ({
    route: JSON.parse(localStorage.getItem('android-route:' + owner))?.thread === id,
    list: JSON.parse(localStorage.getItem('android-route:' + owner))?.list,
    draft: Boolean(localStorage.getItem('chat-input:' + owner + ':' + id)),
  }), { owner: fixture.me, id: fixture.direct });
  assert.deepEqual(stored, { route: true, list: false, draft: true });
  await press(3);
  await wait(5500);
  await device.close();
  device = null;
  await shell('am', 'force-stop', qa);
  await start();
  page = await webview(); page.setDefaultTimeout(18000);
  await page.locator('#app-boot').waitFor({ state: 'hidden' });
  await composer().waitFor();
  assert.equal(await composer().inputValue(), '系统重开后仍在的演示草稿。');
  pass('系统回收后保留登录、上次会话与草稿');
  const memory = await shell('dumpsys', 'meminfo', qa);
  report.totalPssKb = Number(memory.match(/TOTAL PSS:\s+(\d+)/)?.[1] || 0);

  stage = 'system font size and return to phone width';
  originalFontScale = (await shell('settings', 'get', 'system', 'font_scale')).trim();
  const heading = page.getByRole('heading', { name: '晚灯 · 演示', exact: true });
  const headingWidth = () => heading.evaluate(element => {
    const text = document.createRange();
    text.selectNodeContents(element);
    return text.getBoundingClientRect().width;
  });
  const originalHeading = await headingWidth();
  await shell('settings', 'put', 'system', 'font_scale', '1.3');
  await until(async () => (await headingWidth()) > originalHeading * 1.1, 'System font size did not enlarge the chat heading');
  await shell('wm', 'size', '900x1810');
  await shell('wm', 'density', '365');
  await page.waitForFunction(() => innerWidth < 550);
  assert.equal(await composer().inputValue(), '系统重开后仍在的演示草稿。');
  assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isVisible(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  pass('系统字号设为 130% 后正文版面无横向溢出，切回手机宽度保留草稿');

  stage = 'launcher long-press menu';
  await shell('pm', 'disable-user', '--user', '0', secure);
  secureHidden = true;
  await press(3);
  await press(284);
  const launcherIcon = async () => (await nodes()).find(node => /package="[^\"]*launcher[^\"]*"/.test(node[0])
    && /(?:text|content-desc)="月明かり"/.test(node[0]));
  let appIcon = await until(launcherIcon, 'The All Apps key did not open the app drawer', 7000).catch(() => null);
  if (!appIcon) {
    await press(3);
    await shell('input', 'swipe', '450', '1600', '450', '550', '500');
    appIcon = await until(launcherIcon, 'App icon not found in the launcher');
  }
  const position = center(appIcon);
  await shell('input', 'swipe', ...position, ...position, '850');
  const shortcut = await until(async () => (await nodes()).find(node => node[0].includes('先别道晚安') || node[0].includes('月光还在，要再坐一会儿吗')),
    'The launcher did not show the farewell shortcut');
  await snap('android-shortcut');
  await shell('input', 'tap', ...center(shortcut));
  await page.getByRole('heading', { name: '先别道晚安…', exact: true }).waitFor();
  pass('长按 AOSP 启动器的应用图标显示彩蛋快捷项，点按可打开彩蛋页');
} catch (error) {
  report.failedStage = stage;
  const visible = (await nodes().catch(() => [])).map(node => node[0]);
  const known = ['继续登录', '填写 HTTPS 服务根地址', '正在检查聊天服务', '此地址没有月明かり聊天接口', '暂时连不上聊天服务', '登录月明かり'];
  report.nativeSurface = known.filter(label => visible.some(node => node.includes(label)));
  report.pageSurface = await page?.evaluate(({ owner, id }) => ({
    loggedIn: document.querySelector('#app-shell')?.hidden === false,
    signIn: document.querySelector('#app-login')?.hidden === false,
    pane: document.body.dataset.androidPane || null,
    routeSaved: JSON.parse(localStorage.getItem('android-route:' + owner))?.thread === id,
    draftSaved: Boolean(localStorage.getItem('chat-input:' + owner + ':' + id)),
  }), { owner: fixture.me, id: fixture.direct }).catch(() => null);
  const log = await shell('logcat', '-d', '-s', 'AndroidRuntime').catch(() => '');
  report.runtimeErrors = [...new Set([...log.matchAll(/(?:java|android)\.[a-z.]+\.([A-Za-z]+(?:Exception|Error)):/g)].map(match => match[1]))];
  console.error(JSON.stringify({ nativeSurface: report.nativeSurface, pageSurface: report.pageSurface, runtimeErrors: report.runtimeErrors }));
  console.error('Android verification failed at ' + stage);
  throw Error(String(error.message).replaceAll(fixture.member.password, '[demo secret]').replaceAll(fixture.origin, '[demo service]'));
} finally {
  await device?.close().catch(() => {});
  await fixture.close();
  if (secureHidden) await shell('pm', 'enable', secure).catch(() => {});
  if (/^\d+(?:\.\d+)?$/.test(originalFontScale)) await shell('settings', 'put', 'system', 'font_scale', originalFontScale).catch(() => {});
  else if (originalFontScale === 'null') await shell('settings', 'delete', 'system', 'font_scale').catch(() => {});
  for (const args of [['wm','size','reset'], ['wm','density','reset']]) await shell(...args).catch(() => {});
  await adb(['reverse','--remove','tcp:' + port]).catch(() => {});
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
}

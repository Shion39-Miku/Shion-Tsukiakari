import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { androidFixture } from './android-fixture.mjs';

const output = resolve(process.env.TSUKIAKARI_ANDROID_QA || 'artifacts/android/ui-check');
await mkdir(output, { recursive: true });
const report = { checks: [], runtime: 'Playwright Android viewport with local native bridge simulator' };
const fixture = await androidFixture(output);
let browser, page;
const pass = text => { report.checks.push(text); console.log('通过 · ' + text); };

async function account(context, credentials) {
  await context.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const { port1, port2 } = new MessageChannel();
      let settings = { notificationAllowed: false, permissionNeeded: true };
      window.androidFixtureEvents = [];
      window.androidFixtureNative = (type, value) => port1.postMessage(JSON.stringify({ type, value }));
      port1.onmessage = event => {
        const item = JSON.parse(event.data);
        window.androidFixtureEvents.push(item.type);
        if (item.type === 'savePreferences') settings = { ...settings, ...item.values };
        if (['session','preferences','savePreferences'].includes(item.type)) window.androidFixtureNative('preferences', settings);
        if (item.type === 'savePreferences') window.androidFixtureNative('status', '设备设置已保存。');
      };
      window.postMessage('tsukiakari:connect', location.origin, [port2]);
    });
  });
  const active = await context.newPage();
  active.setDefaultTimeout(18000);
  await active.goto(fixture.origin + '/chat');
  await active.getByRole('textbox', { name: '账号', exact: true }).fill(credentials.username);
  await active.getByLabel('密码', { exact: true }).fill(credentials.password);
  await active.getByRole('button', { name: '登录', exact: true }).click();
  await active.locator('#app-shell:not([hidden])').waitFor();
  await active.locator('#app-boot').waitFor({ state: 'hidden' });
  await active.locator('.conversation-filters').waitFor({ state: 'attached' });
  return active;
}

try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.TSUKIAKARI_QA_BROWSER || undefined });
  const context = await browser.newContext({ viewport: { width: 390, height: 820 }, userAgent: 'Chromium TsukiakariAndroid/0.1.0',
    isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  page = await account(context, fixture.member);
  const contacts = page.locator('#contacts-dialog');
  const nav = page.getByRole('navigation', { name: '应用功能' });
  const pick = exact => page.locator('.conversation-filters').getByRole('button', { name: exact, exact: true });
  const friend = () => page.locator('.thread-list').getByRole('button', { name: '晚灯 · 演示', exact: true });
  const draft = page.getByRole('textbox', { name: '聊天消息', exact: true });
  await friend().waitFor();
  assert.equal(await page.locator('.thread-row').count(), 50);
  assert.equal(await page.locator('#composer').isVisible(), false);
  const widths = await page.locator('.conversation-filters button').evaluateAll(items => items.map(item => item.getBoundingClientRect().width));
  assert.ok(Math.min(...widths) > 65 && Math.max(...widths) - Math.min(...widths) < 2);
  for (const kind of ['AI','群聊','全部','好友']) await pick(kind).click();
  await friend().click(); await page.getByText('我把新歌放进收藏了，有空一起听。').waitFor();
  const historyRequest = Promise.withResolvers(), lateResponse = Promise.withResolvers();
  await page.route('**/api/chat/threads/' + fixture.direct + '?before=*', async route => {
    const response = await route.fetch();
    historyRequest.resolve();
    await lateResponse.promise;
    await route.fulfill({ response }).catch(() => {});
  }, { times: 1 });
  const older = page.getByRole('button', { name: '查看更早的消息', exact: true });
  await older.click();
  try {
    await historyRequest.promise;
    await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
    await friend().click();
    await older.click();
    await page.getByText('演示历史 · 第 1 条', { exact: true }).waitFor();
  } finally { lateResponse.resolve(); }
  assert.equal(await page.getByText('演示历史 · 第 1 条', { exact: true }).count(), 1);
  pass('切页取消旧历史请求，返回后继续分页且不重复消息');
  await draft.fill('留到下一次相见的草稿 🌙');
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  assert.equal(await pick('好友').getAttribute('aria-pressed'), 'true');
  await nav.getByRole('button', { name: '通讯录', exact: true }).click();
  await contacts.getByRole('tab', { name: '好友申请', exact: true }).click();
  assert.ok(await contacts.getByRole('tab', { name: '群邀请' }).isVisible());
  const sheet = await contacts.boundingBox(); assert.ok(sheet.y > 15 && sheet.y + sheet.height <= 821);
  await page.evaluate(() => window.tsukiakariAndroidBack());
  await contacts.waitFor({ state: 'hidden' });
  await friend().click(); assert.equal(await draft.inputValue(), '留到下一次相见的草稿 🌙');
  pass('手机导航、50 条会话、等宽筛选、全屏聊天、通讯录浮层与聊天草稿');

  const input = page.getByLabel('选择聊天附件');
  const icon = await readFile('public/assets/brand/tsukiakari-64.png');
  await input.setInputFiles({ name: '月光演示.png', mimeType: 'image/png', buffer: icon });
  await page.getByRole('button', { name: '移除附件 月光演示.png' }).waitFor();
  await page.waitForTimeout(400);
  await page.reload();
  await page.getByRole('button', { name: '移除附件 月光演示.png' }).waitFor();
  assert.equal(await draft.inputValue(), '留到下一次相见的草稿 🌙');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.message-bubble').getByText('留到下一次相见的草稿 🌙', { exact: true }).waitFor();
  assert.equal((await fixture.moon('/api/chat/threads/' + fixture.direct)).value.messages.filter(message => message.body.includes('下一次相见')).length, 1);
  pass('重新加载后恢复文字与图片附件，真实媒体上传与服务端落库');

  const sentText = '只落库一次的弱网演示';
  await page.route('**/api/chat/threads/' + fixture.direct + '/messages', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const accepted = await route.fetch();
    assert.equal(accepted.status(), 201);
    await route.abort('failed');
  }, { times: 1 });
  await draft.fill(sentText);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.composer-status').filter({ hasText: '草稿已保留' }).waitFor();
  await page.reload();
  await draft.waitFor();
  assert.equal(await draft.inputValue(), sentText);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#composer textarea').value === '');
  assert.equal((await fixture.moon('/api/chat/threads/' + fixture.direct)).value.messages.filter(message => message.body === sentText).length, 1);
  pass('响应丢失后重新打开仍复用幂等键，消息不重复');

  await page.setViewportSize({ width: 1130, height: 820 });
  await page.locator('#app-sidebar').waitFor();
  assert.equal(await page.locator('#conversation').isVisible(), true);
  const split = await page.locator('#app-sidebar').boundingBox();
  const which = await page.locator('#conversation').boundingBox();
  assert.ok(split.x + split.width <= which.x + 2);
  await pick('群聊').click();
  await page.locator('.thread-list').getByRole('button', { name: '月下茶话', exact: true }).click();
  await page.getByRole('button', { name: '查看群成员' }).click();
  await page.locator('#conversation-details').getByText('知遥 · 演示人格', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭会话详情', exact: true }).click();
  const peer = await fixture.stars('/api/chat/threads/' + fixture.direct + '/messages', 'POST', { text: '一封月下的演示来信。' });
  assert.equal(peer.status, 201);
  await page.locator('.android-notice').getByText('晚灯 · 演示', { exact: true }).waitFor();
  assert.equal(await page.locator('.android-notice').getByText('一封月下的演示来信。').count(), 0);
  await page.locator('.android-notice-link').click();
  await page.getByText('一封月下的演示来信。', { exact: true }).waitFor();
  await page.waitForFunction(async id => (await (await fetch('/api/chat/threads/' + id)).json()).item.unread === 0, fixture.direct);
  pass('平板双栏与群成员，跨客户端新消息卡片及服务端已读同步');

  await page.locator('.conversation-filters').getByRole('button', { name: 'AI', exact: true }).click();
  await page.locator('.thread-list').getByRole('button', { name: '知遥的夜话', exact: true }).click();
  await draft.fill('请留一句可公开的月色示例。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByText(/演示回复/).last().waitFor();
  assert.deepEqual(fixture.calls, [fixture.assistant]);
  assert.equal((await fixture.moon('/api/chat/admin/overview')).status, 403);
  await nav.getByRole('button', { name: '我的', exact: true }).click();
  await page.locator('.page-nav').getByRole('button', { name: '设备通知', exact: true }).click();
  await page.getByLabel('减少动效', { exact: false }).check();
  await page.getByRole('button', { name: '保存设备设置' }).click();
  await page.getByText('设备设置已保存。', { exact: true }).waitFor();
  assert.equal(await page.locator('html.android-reduce').count(), 1);
  await page.evaluate(() => window.androidFixtureNative('farewell', true));
  await page.getByRole('heading', { name: '先别道晚安…', exact: true }).waitFor();
  await page.getByRole('button', { name: '导出个人数据' }).click();
  await page.waitForFunction(() => window.androidFixtureEvents.includes('export'));
  await page.getByRole('button', { name: '卸载应用' }).click();
  await page.getByRole('dialog', { name: '前往系统卸载', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => window.androidFixtureEvents.includes('uninstall')), false);
  pass('AstrBot 接口模拟流式回复、普通账号权限、设备设置、彩蛋、导出和取消卸载');

  const adminContext = await browser.newContext({ viewport: { width: 760, height: 950 }, userAgent: 'Chromium TsukiakariAndroid/0.1.0' });
  const admin = await account(adminContext, fixture.owner);
  await admin.getByRole('navigation', { name: '应用功能' }).getByRole('button', { name: '我的', exact: true }).click();
  await admin.getByRole('button', { name: '软件管理 账号、群组与服务器 AI' }).click();
  await admin.getByRole('heading', { name: '软件概览', exact: true }).waitFor();
  await admin.getByRole('navigation', { name: '应用功能' }).getByRole('button', { name: '我的', exact: true }).click();
  await admin.getByRole('button', { name: '网站管理 草稿与发布' }).click();
  await admin.locator('#manage-main .admin-tabs').waitFor();
  pass('网站与软件后台独立入口和管理员会话');
} catch (error) {
  report.failure = String(error?.message || error);
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await fixture.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function observeUi(page) {
  await page.evaluate(() => {
    const counts = { list: 0, rail: 0, composer: 0 };
    const observer = new MutationObserver(records => {
      for (const { target } of records) {
        if (target.closest('#message-list')) counts.list++;
        if (target.closest('#app-rail')) counts.rail++;
        if (target.closest('#composer')) counts.composer++;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.maintenanceSample = { counts, observer };
  });
}

async function mutations(page) {
  return page.evaluate(() => {
    const { counts, observer } = window.maintenanceSample;
    observer.disconnect();
    delete window.maintenanceSample;
    return counts;
  });
}

export async function checkChatResilience({ app, page, member, api, nav, shot, friendId, groupId, report }) {
  const baseline = process.env.TSUKIAKARI_QA_BASELINE === '1';
  const checks = report.resilience = {};
  const record = (name, passed) => {
    checks[name] = passed;
    if (!baseline) assert.ok(passed, name);
  };
  const threadPath = '/api/chat/threads/' + friendId;
  const conversation = page.locator('#conversation');
  const composer = page.getByRole('textbox', { name: '聊天消息', exact: true });
  await page.bringToFront();
  await observeUi(page);
  const refresh = page.waitForResponse(response => {
    if (response.request().method() !== 'GET' || !response.ok()) return false;
    const { pathname, searchParams } = new URL(response.url());
    if (baseline) return pathname === threadPath;
    return pathname === threadPath + '/sync' && /^\d+$/.test(searchParams.get('cursor') || '');
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refresh;
  await page.waitForTimeout(350);
  const changes = await mutations(page);
  report.performance.focusRefreshMutations = changes;
  record('已读完整历史后，焦点刷新未重新出现旧页入口', await page.getByRole('button', { name: '查看更早的消息' }).count() === 0);
  record('焦点刷新保留已加载消息', await page.locator('[data-message-id]').count() >= 66);

  await page.getByRole('button', { name: '全部', exact: true }).click();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let reached;
  const reading = new Promise(resolve => { reached = resolve; });
  const groupPath = '**/api/chat/threads/' + groupId;
  const delayGroup = async route => {
    reached();
    await gate;
    await route.continue().catch(() => {});
  };
  await page.route(groupPath, delayGroup, { times: 1 });
  await page.locator('.thread-button').filter({ hasText: '月下茶话' }).click();
  await reading;
  await nav('个人设置');
  release();
  await page.waitForTimeout(400);
  record('迟到的会话请求未覆盖已打开的设置', new URL(page.url()).searchParams.get('t') === friendId);
  await page.goto(new URL('/chat?t=' + friendId, page.url()).href);
  await page.locator('#app-header .header-identity').filter({ hasText: '好友' }).waitFor();
  await composer.fill('演示 · 连接中断时保留这条草稿');
  const sends = '**/api/chat/threads/' + friendId + '/messages';
  await page.route(sends, route => route.abort('internetdisconnected'), { times: 1 });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#composer textarea').disabled);
  record('发送遇到网络中断后保留输入', (await composer.inputValue()).includes('连接中断'));
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.locator('.message-bubble').filter({ hasText: '演示 · 连接中断时保留这条草稿' }).waitFor();

  const events = '**/api/chat/events';
  await page.route(events, route => route.fulfill({ status: 503, body: 'temporary unavailable' }));
  await page.reload();
  await page.locator('#app-header .header-identity').filter({ hasText: '好友' }).waitFor();
  if (!baseline) {
    await page.locator('#chat-connection:not([hidden])').waitFor();
    await shot('chat-reconnect');
  }
  await conversation.evaluate(n => { n.scrollTop = n.scrollHeight; });
  const missed = '演示 · 断线间收到的消息';
  assert.equal((await api(threadPath + '/messages', 'POST', { text: missed }, member)).status, 201);
  await page.unroute(events);
  let recovered = true;
  try {
    await page.locator('.message-bubble').filter({ hasText: missed }).waitFor({ timeout: 9000 });
  } catch {
    recovered = false;
  }
  record('实时连接失败后自动重连并补齐消息', recovered);
  if (!recovered) {
    await page.reload();
    await page.locator('.message-bubble').filter({ hasText: missed }).waitFor();
  }

  const window = await app.browserWindow(page);
  const renderPid = await window.evaluate(w => w.webContents.getOSProcessId());
  const resourceSample = () => app.evaluate(({ app }, pid) => {
    const renderer = app.getAppMetrics().find(p => p.pid === pid);
    return { cpuSeconds: renderer.cpu.cumulativeCPUUsage, workingSetKib: renderer.memory.workingSetSize };
  }, renderPid);
  await page.bringToFront();
  await page.waitForTimeout(350);
  await observeUi(page);
  await window.evaluate(w => {
    const overlay = w.setOverlayIcon.bind(w);
    w.maintenanceOverlays = [];
    w.setOverlayIcon = (image, description) => {
      w.maintenanceOverlays.push(Boolean(image));
      return overlay(image, description);
    };
    w.hide();
  });
  const start = await resourceSample();
  const peerMessages = 8;
  for (let index = 0; index < peerMessages; index++) {
    assert.equal((await api(threadPath + '/messages', 'POST', { text: '演示 · 后台验收 ' + index }, member)).status, 201);
    await member.waitForTimeout(130);
  }
  await member.waitForTimeout(1250);
  const finish = await resourceSample();
  const hiddenUi = await mutations(page);
  report.performance.background = {
    messages: peerMessages,
    visibility: await page.evaluate(() => document.visibilityState),
    nativeUiHidden: await page.evaluate(() => document.documentElement.classList.contains('page-hidden')),
    mutations: hiddenUi,
    rendererCpuMs: Number.isFinite(finish.cpuSeconds) ? Math.round((finish.cpuSeconds - start.cpuSeconds) * 1000) : null,
    rendererWorkingSetMiB: Math.round(finish.workingSetKib / 1024),
  };
  record('托盘后台收消息时不重建聊天正文', hiddenUi.list === 0);
  const unread = await api(threadPath);
  record('隐藏窗口收到消息不会误标已读', unread.body.item.unread === peerMessages);
  report.performance.background.unreadWhileHidden = unread.body.item.unread;
  record('关闭任务栏标记后，后台未读仍保留且不设置叠加图标', !(await window.evaluate(w => w.maintenanceOverlays)).includes(true));
  await window.evaluate(w => { w.show(); w.focus(); });
  await page.locator('.message-bubble').filter({ hasText: '演示 · 后台验收 7' }).waitFor();

  if (baseline) return;
  // A freshly delivered message remains unread while the reader is browsing older history.
  await conversation.evaluate(n => { n.scrollTop = 130; });
  const readingPosition = await conversation.evaluate(n => n.scrollTop);
  const newest = '演示 · 正在翻历史时收到新消息';
  assert.equal((await api(threadPath + '/messages', 'POST', { text: newest }, member)).status, 201);
  await page.getByRole('button', { name: /查看新消息/ }).waitFor();
  record('阅读旧消息时，新消息保留位置和未读', Math.abs(await conversation.evaluate(n => n.scrollTop) - readingPosition) < 8 && (await api(threadPath)).body.item.unread >= 1);
  await page.getByRole('button', { name: /查看新消息/ }).click();
  await page.waitForFunction(async id => (await (await fetch('/api/chat/threads/' + id)).json()).item.unread === 0, friendId, { polling: 150 });
  record('回到最新后清理当前会话未读', true);

  await nav('个人设置');
  await page.getByRole('button', { name: '通知', exact: true }).click();
  await page.getByLabel('任务栏未读提醒', { exact: true }).check();
  await page.getByLabel('消息提示音', { exact: true }).uncheck();
  await page.getByLabel('系统消息通知', { exact: true }).uncheck();
  await page.getByRole('button', { name: '保存修改', exact: true }).click();
  await page.getByText('偏好已保存。', { exact: true }).waitFor();
  await page.locator('#app-header').getByRole('button', { name: '返回聊天' }).click();
  await window.evaluate(w => { w.maintenanceOverlays.length = 0; w.minimize(); });
  assert.equal((await api(threadPath + '/messages', 'POST', { text: '演示 · 任务栏未读提醒' }, member)).status, 201);
  await member.waitForTimeout(1300);
  record('开启任务栏提醒后，最小化收件设置原生叠加标记',
    (await window.evaluate(w => w.maintenanceOverlays)).includes(true));
  await window.evaluate(w => { w.restore(); w.focus(); });
  await page.locator('.message-bubble').filter({ hasText: '演示 · 任务栏未读提醒' }).waitFor();

  await composer.fill('演示 · 切页时仍发送给原来的好友');
  let allowDelivery, arrived;
  const delivery = new Promise(resolve => { allowDelivery = resolve; });
  const uploading = new Promise(resolve => { arrived = resolve; });
  await page.route(sends, async route => {
    arrived();
    await delivery;
    await route.continue();
  }, { times: 1 });
  const delivered = page.waitForResponse(r => r.url().endsWith(threadPath + '/messages') && r.status() === 201);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await uploading;
  await page.locator('.thread-button').filter({ hasText: '月下茶话' }).click();
  await page.locator('#app-header .header-identity').filter({ hasText: '群聊' }).waitFor();
  await composer.fill('演示 · 这条群聊草稿需要保留');
  allowDelivery();
  await delivered;
  await page.waitForTimeout(250);
  record('延迟发送不会写错会话或清空另一段草稿',
    (await composer.inputValue()).includes('群聊草稿') &&
    !(await api('/api/chat/threads/' + groupId)).body.messages.some(m => m.body.includes('原来的好友')));

  await page.goto(new URL('/chat?t=' + friendId, page.url()).href);
  await page.locator('#app-header .header-identity').filter({ hasText: '好友' }).waitFor();
  await window.evaluate(w => { w.setSize(800, 580); w.webContents.setZoomFactor(1.25); });
  const longText = '演示 · 长消息和附件\n\n' + '月下长句、テスト、Tsukiakari。'.repeat(185) + '\n\n```txt\n' + 'long-line-'.repeat(110) + '\n```';
  await composer.fill(longText);
  await page.locator('input[aria-label="选择聊天附件"]').setInputFiles({
    name: '月色演示.png', mimeType: 'image/png', buffer: await readFile('public/assets/brand/tsukiakari-64.png'),
  });
  const sent = page.waitForResponse(r => r.url().endsWith(threadPath + '/messages') && r.status() === 201);
  await composer.press('Enter');
  const result = await (await sent).json();
  const sentMessage = result.items.find(item => item.role === 'user');
  assert.equal(sentMessage.body, longText);
  assert.equal(sentMessage.metadata.attachments[0].name, '月色演示.png');
  const row = page.locator('[data-message-id="' + sentMessage.id + '"]');
  await row.getByRole('button', { name: '放大附件 月色演示.png' }).click();
  await page.locator('#image-dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  record('800×580 与 125% 下长消息、代码块和实际图片上传可用', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await window.evaluate(w => { w.webContents.setZoomFactor(1); w.setSize(1280, 860); });
}

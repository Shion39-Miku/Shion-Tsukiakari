import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function checkDesktopPolish({ app, page, member, nav, api, shot, report, data, aiId }) {
  await nav('聊天');
  await page.bringToFront();
  const actor = (await api('/api/chat/session')).body;
  const peer = (await api('/api/chat/session', 'GET', undefined, member)).body;
  // Only the isolated QA profile uses synthetic rows for the long-list comparison.
  const db = new DatabaseSync(join(data, 'data/chat.sqlite'));
  try {
    const add = db.prepare('INSERT INTO chat_threads VALUES (?,?,?,?,?,?)');
    const joinThread = db.prepare('INSERT INTO chat_members (thread_id,account_key,joined_at) VALUES (?,?,?)');
    const invite = db.prepare("INSERT INTO chat_group_invitations VALUES (?,?,?,?,0,'expired',?,?,?)");
    db.exec('BEGIN');
    for (let i = 0; i < 64; i++) {
      const id = randomUUID(), time = new Date(1760000000000 + i * 1000).toISOString();
      add.run(id, actor.key, i % 2 ? 'ai' : 'group', '演示会话 ' + (i + 1), time, time);
      joinThread.run(id, actor.key, time);
      if (i % 2 === 0) invite.run(randomUUID(), id, actor.key, peer.key, Date.parse(time), time, time);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const filters = page.locator('.conversation-filters');
  await filters.getByRole('button', { name: '全部', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.thread-row').length >= 50);
  const native = await app.browserWindow(page);
  const pid = await native.evaluate(w => w.webContents.getOSProcessId());
  const resources = () => app.evaluate(({ app }, id) => {
    const p = app.getAppMetrics().find(entry => entry.pid === id);
    return { cpu: p.cpu.cumulativeCPUUsage, rss: p.memory.workingSetSize };
  }, pid);
  const start = await resources();
  const metrics = await page.evaluate(async () => {
    const filters = [...document.querySelectorAll('.conversation-filters button')];
    const list = document.querySelector('.thread-list');
    const buttonWidths = filters.map(button => Math.round(button.getBoundingClientRect().width * 10) / 10);
    const first = list.querySelector('.thread-row');
    let removedRows = 0, peakAnimations = 0;
    const count = records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.matches('.thread-row')) removedRows++;
      }
    };
    const observer = new MutationObserver(count);
    observer.observe(list, { subtree: true, childList: true });
    const frames = [];
    const inputTimes = [];
    const input = document.querySelector('#composer textarea');
    let previous;
    const frame = timestamp => {
      if (previous !== undefined) frames.push(timestamp - previous);
      previous = timestamp;
      frameId = requestAnimationFrame(frame);
    };
    let frameId = requestAnimationFrame(frame);
    for (const index of [1, 2, 3, 0, 3, 2, 1, 2, 3, 1, 2, 0]) {
      filters[index].click();
      peakAnimations = Math.max(peakAnimations, list.querySelector('.thread-track')?.getAnimations().length || 0);
      const start = performance.now();
      input.value = '演示草稿 · ' + '月明かり'.repeat(220);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      inputTimes.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, 18));
    }
    await new Promise(resolve => setTimeout(resolve, 280));
    cancelAnimationFrame(frameId);
    count(observer.takeRecords());
    observer.disconnect();
    return {
      buttonWidths,
      rowCount: list.querySelectorAll('.thread-row').length,
      removedRows,
      sameFirstRow: first === list.querySelector('.thread-row'),
      frames: frames.length,
      over34ms: frames.filter(value => value > 34).length,
      peakAnimations,
      inputMedianMs: Math.round(inputTimes.sort((a, b) => a - b)[Math.floor(inputTimes.length / 2)] * 100) / 100,
    };
  });
  const end = await resources();
  metrics.cpuMs = Math.round((end.cpu - start.cpu) * 1000);
  metrics.workingSetMiB = Math.round(end.rss / 1024);
  report.polish = { categorySwitch: metrics };

  const baseline = process.env.TSUKIAKARI_QA_POLISH_BASELINE === '1';
  await page.getByRole('button', { name: '通讯录', exact: true }).click();
  const contacts = page.locator(baseline ? '#app-dialog' : '#contacts-dialog');
  await contacts.getByText('澄月', { exact: true }).waitFor();
  const role = baseline ? 'button' : 'tab';
  const firstTab = await contacts.getByRole(role, { name: '好友', exact: true }).elementHandle();
  await contacts.getByRole(role, { name: '群邀请', exact: true }).click();
  report.polish.directoryTabsReused = await firstTab.evaluate(node => node.isConnected);
  await page.keyboard.press('Escape');
  await contacts.waitFor({ state: 'hidden' });
  if (baseline) {
    await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox;
      let times = 0;
      dialog.showMessageBox = async () => { times++; return { response: 2, checkboxChecked: false }; };
      global.__baselineNativeCloseCount = () => { dialog.showMessageBox = original; return times; };
    });
    await page.evaluate(() => window.hoshifuruDesktop.setPreferences({ closeAction: 'ask' }));
    await (await app.browserWindow(page)).evaluate(window => window.close());
    report.polish.originalNativeCloseCalls = await app.evaluate(() => global.__baselineNativeCloseCount());
    return false;
  }
  assert.equal(metrics.removedRows, 0);
  assert.equal(metrics.sameFirstRow, true);
  assert.ok(Math.max(...metrics.buttonWidths) - Math.min(...metrics.buttonWidths) <= 1);
  assert.ok(metrics.buttonWidths.every(width => width >= 40));
  assert.equal(report.polish.directoryTabsReused, true);
  assert.ok(metrics.peakAnimations <= 1);
  await page.getByRole('textbox', { name: '聊天消息', exact: true }).fill('想继续聊聊今晚听到的那首歌。');
  await checkDirectory({ page, member, api, contacts, native, shot, report });
  await checkStreaming({ page, report, aiId });
  await checkMenuPrompts({ app, page, member, native, report });
  await checkClose({ app, page, native, nav, shot, report, data });
  return true;
}

async function checkMenuPrompts({ app, page, member, native, report }) {
  const invoke = async (window, label) => {
    const id = await window.evaluate(w => w.id);
    await app.evaluate(({ BrowserWindow, Menu }, { id, label }) => {
      const target = BrowserWindow.fromId(id);
      target.show();
      target.focus();
      Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === label).click();
    }, { id, label });
  };
  const ordinary = await app.browserWindow(member);
  await invoke(ordinary, '打开数据文件夹');
  const denied = member.getByRole('dialog', { name: '需要管理员账号' });
  await denied.getByRole('button', { name: '知道了' }).click();
  await denied.waitFor({ state: 'hidden' });
  await invoke(native, '关于月明かり');
  const about = page.getByRole('dialog', { name: '关于月明かり' });
  const version = await app.evaluate(({ app }) => app.getVersion());
  await about.getByText('Tsukiakari ' + version, { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await about.waitFor({ state: 'hidden' });

  const window = app.waitForEvent('window');
  await invoke(native, '备用模型连接设置…');
  const settings = await window;
  await settings.getByText('尚未设置密钥。', { exact: true }).waitFor();
  await settings.getByLabel('接口地址', { exact: true }).fill('https://example.invalid/v1');
  await settings.getByLabel('模型名称', { exact: true }).fill('demo-model');
  await settings.getByLabel('API 密钥', { exact: true }).fill('demo-token-only-for-local-qa');
  await settings.getByRole('button', { name: '保存并重新启动' }).click();
  const confirmation = settings.getByRole('dialog', { name: '保存模型连接', exact: true });
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await settings.getByText('尚未保存。', { exact: true }).waitFor();
  await (await app.browserWindow(settings)).evaluate(w => w.close());
  await page.bringToFront();
  report.polish.menuPrompts = '关于、管理员权限提示和备用模型确认均使用应用内弹窗，取消备用模型保存不重启';
}

export async function checkStartupPrompt({ launch, environment, out, report }) {
  const data = await mkdtemp(join(out, 'startup-error-'));
  const app = await launch({ ...environment, TSUKIAKARI_DESKTOP_DATA: data, TSUKIAKARI_CHAT_SERVER_URL: 'http://example.invalid/' });
  try {
    const page = await app.firstWindow();
    const dialog = page.getByRole('dialog', { name: '月明かり未能启动', exact: true });
    const stopped = once(app.process(), 'exit');
    await dialog.getByRole('button', { name: '退出软件', exact: true }).click();
    assert.equal((await stopped)[0], 0);
    const log = await readFile(join(data, 'desktop.log'), 'utf8');
    assert.match(log, /远程聊天后端须为HTTPS站点根地址/);
    report.polish.startup = '启动配置错误使用应用内弹窗，可正常退出。错误原因保存在桌面日志';
  } finally { await app.close().catch(() => {}); }
}

async function checkDirectory({ page, member, api, contacts, native, shot, report }) {
  const launcher = page.getByRole('button', { name: '通讯录', exact: true });
  await launcher.click();
  const tab = name => contacts.getByRole('tab', { name, exact: true });
  const friends = contacts.getByRole('tabpanel', { name: '好友', exact: true });
  await tab('好友').click();
  await friends.getByText('澄月', { exact: true }).waitFor();
  await shot('contacts-window');
  const motion = await contacts.evaluate(dialog => {
    const tabs = [...dialog.querySelectorAll('[role=tab]')];
    for (const index of [1, 2, 3, 0, 3, 2, 1, 0]) tabs[index].click();
    return dialog.querySelector('.contacts-panes').getAnimations({ subtree: true }).length;
  });
  assert.ok(motion <= 1);
  const position = await contacts.boundingBox();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let readStarted;
  const loading = new Promise(resolve => { readStarted = resolve; });
  await page.route('**/api/chat/friends', async route => {
    readStarted();
    await gate;
    await route.fulfill({ status: 503, json: { error: { message: '演示连接中断' } } }).catch(() => {});
  }, { times: 1 });
  const profile = (await api('/api/chat/profile', 'GET', undefined, member)).body.item;
  await api('/api/chat/profile', 'PATCH', { version: profile.version, displayName: '澄月 · 更新' }, member);
  await Promise.race([loading, new Promise((_, reject) => setTimeout(() => reject(Error('好友列表未开始更新')), 10000))]);
  assert.equal(await friends.getByText('澄月', { exact: true }).isVisible(), true);
  await tab('群邀请').click();
  const invitations = contacts.getByRole('tabpanel', { name: '群邀请' });
  await invitations.getByText(/演示会话/).first().waitFor();
  await invitations.evaluate(n => { n.scrollTop = n.scrollHeight; });
  const scroll = await invitations.evaluate(n => n.scrollTop);
  assert.ok(scroll > 0);
  release();
  await page.waitForTimeout(280);
  assert.equal(await tab('群邀请').getAttribute('aria-selected'), 'true');
  assert.deepEqual(await contacts.boundingBox(), position);
  await tab('好友').click();
  await friends.getByText('澄月 · 更新', { exact: true }).waitFor();
  await tab('群邀请').click();
  assert.equal(await invitations.evaluate(n => n.scrollTop), scroll);
  await tab('好友').click();
  await tab('好友').press('ArrowRight');
  assert.equal(await tab('搜索用户').getAttribute('aria-selected'), 'true');
  let releaseOld;
  const slow = new Promise(resolve => { releaseOld = resolve; });
  let requestSeen;
  const slowStarted = new Promise(resolve => { requestSeen = resolve; });
  await page.route('**/api/chat/users?q=luna', async route => {
    requestSeen();
    await slow;
    await route.continue().catch(() => {});
  }, { times: 1 });
  const input = contacts.getByRole('textbox', { name: '用户ID、账号或名称' });
  await input.fill('luna'); await input.press('Enter');
  await Promise.race([slowStarted, new Promise((_, reject) => setTimeout(() => reject(Error('搜索请求未开始')), 10000))]);
  await input.fill('没有这个演示用户'); await input.press('Enter');
  await contacts.getByText('没有匹配的用户。请核对账号或用户 ID。', { exact: true }).waitFor();
  releaseOld();
  await page.waitForTimeout(260);
  assert.equal(await input.inputValue(), '没有这个演示用户');
  assert.equal(await contacts.getByText('没有匹配的用户。请核对账号或用户 ID。', { exact: true }).isVisible(), true);
  await native.evaluate(w => { w.setSize(800, 580); w.webContents.setZoomFactor(1.25); });
  const within = await contacts.evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    return rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  });
  assert.equal(within, true);
  await page.keyboard.press('Escape');
  await contacts.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('mobile-menu'));
  await native.evaluate(w => { w.webContents.setZoomFactor(1); w.setSize(1280, 860); });
  await launcher.click();
  await page.keyboard.press('Escape');
  await contacts.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent.trim() === '通讯录');
  report.polish.directory = '慢请求与断网保留旧内容，迟到结果不抢标签或搜索内容。键盘操作、窗口缩放、焦点恢复通过';
}

async function checkStreaming({ page, report, aiId }) {
  await page.goto(new URL('/chat?t=' + aiId, page.url()).href);
  await page.locator('#app-header .header-identity').filter({ hasText: 'AI' }).waitFor();
  const draft = page.getByRole('textbox', { name: '聊天消息', exact: true });
  await draft.fill('演示 · 需要停止的流式回复');
  await draft.press('Enter');
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor();
  await draft.fill('在流式回复时继续编辑这份长草稿。'.repeat(100));
  const value = await draft.inputValue();
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.conversation-filters button')];
    for (const index of [1, 2, 3, 0, 3, 2]) buttons[index].click();
  });
  assert.equal(await draft.inputValue(), value);
  assert.equal(new URL(page.url()).searchParams.get('t'), aiId);
  assert.equal(await page.locator('.conversation-filters [aria-pressed=true]').textContent(), '好友');
  await page.locator('.message.assistant').last().getByText(/已经收到的文字/).waitFor();
  await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'hidden' });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.conversation-filters').getByRole('button', { name: '全部', exact: true }).click();
  const quiet = await page.evaluate(() => ({
    motion: document.querySelector('.thread-track').getAnimations().length,
    duration: getComputedStyle(document.querySelector('.conversation-filters'), '::before').transitionDuration,
  }));
  assert.equal(quiet.motion, 0);
  assert.ok(Number.parseFloat(quiet.duration) <= 0.001);
  await page.emulateMedia({ reducedMotion: null });
  report.polish.streaming = 'AI 流式回复期间快速筛选和输入长草稿均保留。系统减少动效关闭了滑动与高亮过渡';
}

async function checkClose({ app, page, native, nav, shot, report, data }) {
  const prompt = page.getByRole('dialog', { name: '关闭月明かり', exact: true });
  const draft = page.getByRole('textbox', { name: '聊天消息', exact: true });
  const preferences = () => page.evaluate(() => window.hoshifuruDesktop.getPreferences());
  await page.evaluate(() => window.hoshifuruDesktop.setPreferences({ closeAction: 'ask' }));
  await draft.fill('关闭或恢复窗口时的演示草稿');
  await draft.focus();
  await native.evaluate(w => { w.close(); w.close(); });
  await prompt.waitFor();
  assert.equal(await prompt.count(), 1);
  await shot('close-options');
  await prompt.getByLabel('记住我的选择').check();
  await prompt.getByRole('button', { name: '取消', exact: true }).click();
  await prompt.waitFor({ state: 'hidden' });
  assert.equal((await preferences()).closeAction, 'ask');
  await page.waitForFunction(() => document.activeElement === document.querySelector('#composer textarea'));
  for (const method of ['escape', 'button']) {
    await native.evaluate(w => w.close());
    await prompt.waitFor();
    if (method === 'escape') await page.keyboard.press('Escape');
    else await prompt.getByRole('button', { name: '关闭提示' }).click();
    await prompt.waitFor({ state: 'hidden' });
    assert.equal((await preferences()).closeAction, 'ask');
  }

  await native.evaluate(w => w.close());
  await prompt.getByLabel('记住我的选择').check();
  await prompt.getByRole('button', { name: '后台运行', exact: true }).click();
  await prompt.waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(150);
  assert.equal(await native.evaluate(w => w.isVisible()), false);
  assert.equal((await preferences()).closeAction, 'background');
  assert.equal(await app.evaluate(() => global.__hoshifuruDesktop.features().tray), true);
  await app.evaluate(({ app }) => app.emit('second-instance'));
  assert.equal(await native.evaluate(w => w.isVisible()), true);
  assert.equal(await draft.inputValue(), '关闭或恢复窗口时的演示草稿');
  await nav('个人设置');
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  assert.equal(await page.getByLabel('关闭窗口时').inputValue(), 'background');
  await page.getByRole('button', { name: '恢复每次询问', exact: true }).click();
  await page.getByText('已恢复为每次询问。', { exact: true }).waitFor();
  await page.locator('#app-header').getByRole('button', { name: '返回聊天' }).click();

  const picker = page.getByLabel('选择聊天附件');
  await picker.setInputFiles({ name: '演示附件.png', mimeType: 'image/png', buffer: await readFile('public/assets/brand/tsukiakari-64.png') });
  await page.getByRole('button', { name: '移除附件 演示附件.png' }).waitFor();
  await native.evaluate(w => w.close());
  await prompt.getByLabel('记住我的选择').check();
  await prompt.getByRole('button', { name: '退出软件', exact: true }).click();
  const unfinished = page.getByRole('dialog', { name: '有内容需要保留', exact: true });
  await unfinished.waitFor();
  await unfinished.getByRole('button', { name: '继续处理' }).click();
  await unfinished.waitFor({ state: 'hidden' });
  assert.equal((await preferences()).closeAction, 'ask');
  assert.equal(await draft.inputValue(), '关闭或恢复窗口时的演示草稿');
  await page.getByRole('button', { name: '移除附件 演示附件.png' }).click();

  const backendPid = await app.evaluate(() => global.__hoshifuruDesktop.backendPid);
  const stopped = once(app.process(), 'exit');
  await native.evaluate(w => w.close());
  await prompt.getByLabel('记住我的选择').check();
  await prompt.getByRole('button', { name: '退出软件', exact: true }).click();
  const [code] = await stopped;
  assert.equal(code, 0);
  assert.throws(() => process.kill(backendPid, 0), { code: 'ESRCH' });
  const saved = JSON.parse(await readFile(join(data, 'desktop-settings.json'), 'utf8'));
  assert.equal(saved.closeAction, 'exit');
  report.polish.close = '重复关闭仅弹一次。取消、Esc、关闭按钮保留草稿。确认后台或退出才保存偏好，退出后没有受管子进程';
}

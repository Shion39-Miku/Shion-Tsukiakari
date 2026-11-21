import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server/app.mjs';
import { openDatabase, readConfig, sha256 } from '../server/core.mjs';
import { setAdmin } from '../server/auth.mjs';
import { androidChatOrigin } from './android-release-config.mjs';

const token = () => randomBytes(24).toString('base64url');
const listen = async (server, port = 0) => { server.listen(port, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const close = async server => { server.closeAllConnections(); await new Promise(done => server.close(done)); };

export async function androidFixture(folder = 'artifacts/android/fixture', { port } = {}) {
  const parent = resolve(folder);
  await mkdir(parent, { recursive: true });
  const data = await mkdtemp(join(parent, 'demo-'));
  const password = token(), eventToken = token();
  const owner = { username: 'demo_owner', password };
  const member = { username: 'demo_moon', password: token() };
  const peer = { username: 'demo_stars', password: token() };
  const chatPath = join(data, 'chat.sqlite'), websitePath = join(data, 'website.sqlite');
  for (const path of [chatPath, websitePath]) {
    const database = openDatabase(path);
    try { await setAdmin(database, owner.username, password); } finally { database.close(); }
  }
  const persona = { id: 'fixture-star', name: '知遥 · 演示人格', description: '仅供安卓验收', enabled: true,
    systemPrompt: '以简短中文参与演示。', beginDialogs: [], firstMessage: '晚安，给你留了一点月光。', exampleDialogue: '', version: 'demo-1' };
  const calls = [];
  const bot = createServer(async (req, res) => {
    const content = [];
    for await (const chunk of req) content.push(chunk);
    const payload = content.length ? JSON.parse(Buffer.concat(content)) : {};
    const json = value => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/v2/agents') return json({ items: [persona], defaultId: persona.id });
    if (req.url === '/v2/personas') return json({ items: [persona] });
    if (req.url === '/v2/personas/' + persona.id) return json({ item: persona });
    if (req.url === '/v2/chat') {
      calls.push(payload.scope.threadId);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const delta of ['我听见啦。', '今晚的月光，就留给这场对话。', '〔演示回复〕']) {
        if (res.destroyed) return;
        res.write('data: ' + JSON.stringify({ delta, conversationId: 'demo-' + payload.scope.threadId, umo: 'demo-scope-' + payload.scope.threadId }) + '\n\n');
        await new Promise(done => setTimeout(done, 200));
      }
      return res.end('data: [DONE]\n\n');
    }
    return json({ ok: true });
  });
  const botOrigin = await listen(bot);
  const common = { ...readConfig({ envFile: false }), host: '127.0.0.1', baseUrl: '', secureCookie: false, ipGeoEnabled: false,
    chat: {}, bots: new Map(), astrbot: {}, websiteUrl: '', desktopAccessToken: '', seedDemo: false };
  const website = await createApplication({ ...common, dbPath: websitePath, serviceMode: 'website', disableChat: true, seedDemo: true,
    bots: new Map([['qa', { id: 'qa', hash: sha256(eventToken), scopes: new Set(['events:read', 'content-events:read', 'catalog:read']) }]]) });
  const websiteUrl = await listen(website);
  const chat = await createApplication({ ...common, dbPath: chatPath, serviceMode: 'chat', websiteUrl, websiteEventToken: eventToken,
    astrbot: { baseUrl: botOrigin, chatToken: token(), adminToken: token() } });
  const origin = await listen(chat, port);

  async function login(user) {
    const response = await fetch(origin + '/api/chat/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ');
    const { csrf } = await response.json();
    return async (path, method = 'GET', payload, key = randomUUID()) => {
      const response = await fetch(origin + path, { method, headers: { Cookie: cookies, 'X-CSRF-Token': csrf, 'Idempotency-Key': key,
        ...(payload !== undefined && { 'Content-Type': 'application/json' }) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      return { status: response.status, value: await response.json() };
    };
  }

  try {
    const admin = await login(owner);
    for (const user of [member, peer]) assert.equal((await admin('/api/admin/accounts', 'POST', user)).status, 201);
    const moon = await login(member), stars = await login(peer);
    const identity = async (api, name) => {
      const { value } = await api('/api/chat/session');
      assert.equal((await api('/api/chat/profile', 'PATCH', { version: value.profile.version, displayName: name, status: 'online' })).status, 200);
      return value.key;
    };
    const me = await identity(moon, '星野 澄月 · 演示');
    const friend = await identity(stars, '晚灯 · 演示');
    const application = await moon('/api/chat/friend-requests', 'POST', { target: friend });
    assert.ok(application.value.item.id);
    assert.equal((await stars('/api/chat/friend-requests/' + application.value.item.id + '/accept', 'POST')).status, 200);
    const direct = (await moon('/api/chat/threads', 'POST', { kind: 'direct', members: [friend] })).value.item.id;
    const group = (await moon('/api/chat/threads', 'POST', { title: '月下茶话', kind: 'group', members: [friend] })).value.item.id;
    const invitation = (await stars('/api/chat/invitations')).value.items.find(item => item.threadId === group);
    assert.ok(invitation);
    assert.equal((await stars('/api/chat/invitations/' + invitation.id + '/accept', 'POST')).status, 200);
    const agents = (await moon('/api/chat/ai')).value.items;
    assert.ok(agents?.[0]?.id);
    const assistant = (await moon('/api/chat/threads', 'POST', { title: '知遥的夜话', kind: 'ai', aiId: agents[0].id })).value.item.id;
    assert.equal((await moon('/api/chat/threads/' + group + '/ai', 'POST', { aiId: agents[0].id })).status, 200);
    const insert = openDatabase(chatPath);
    try {
      const timestamp = new Date().toISOString();
      const message = insert.prepare("INSERT INTO chat_messages(thread_id,role,sender_key,sender_name,body,status,metadata,request_key,created_at,updated_at) VALUES(?,'user',?,?,?,'complete','{}',?,?,?)");
      insert.exec('BEGIN');
      for (let i = 0; i < 72; i++) message.run(direct, i % 2 ? me : friend, i % 2 ? '澄月' : '晚灯',
        i === 70 ? '月亮升起来了。\n\n还有一页长文想留给今晚。\n' + '詩音と知遥、言葉は月明かりに。'.repeat(8)
          : i === 71 ? '我把新歌放进收藏了，有空一起听。' : '演示历史 · 第 ' + (i + 1) + ' 条', randomUUID(), timestamp, timestamp);
      message.run(group, friend, '晚灯', '欢迎来到月下茶话。这里是用于验收的演示群聊。', randomUUID(), timestamp, timestamp);
      const add = insert.prepare("INSERT INTO chat_threads VALUES (? ,?,'ai',?,?,?)");
      const joinThread = insert.prepare('INSERT INTO chat_members (thread_id, account_key, joined_at) VALUES (?,?,?)');
      for (let i = 0; i < 58; i++) {
        const id = randomUUID(), older = new Date(1710000000000 - i * 60000).toISOString();
        add.run(id, me, '演示夜话 ' + (i + 1), older, older); joinThread.run(id, me, older);
      }
      insert.exec('COMMIT');
    } finally { insert.close(); }
    const config = { origin, owner, member, peer, me, direct, group, assistant };
    return { ...config, moon, stars, admin, calls, chatPath, close: () => Promise.all([close(chat), close(website), close(bot)]) };
  } catch (error) { await Promise.all([close(chat), close(website), close(bot)]); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const folder = process.argv[2] || 'artifacts/android/fixture';
  const fixture = await androidFixture(folder, { port: Number(new URL(androidChatOrigin(true)).port) });
  const { origin, owner, member, peer, direct, group, assistant } = fixture;
  await writeFile(join(folder, 'fixture.private.json'), JSON.stringify({ origin, owner, member, peer, direct, group, assistant }), { mode: 0o600 });
  console.log('隔离安卓测试服务已就绪 · ' + origin);
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0); });
}

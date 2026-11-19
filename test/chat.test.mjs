import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { test } from 'node:test';
import { createApplication } from '../server/app.mjs';
import { setAdmin } from '../server/auth.mjs';
import { openDatabase, readConfig } from '../server/core.mjs';
import { collectStaged } from '../server/media-gc.mjs';

test('portable app: role isolation, real DM/groups, private files, streaming/retry, native review and persistence', { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hoshifuru-chat-')), dbPath = join(directory, 'site.sqlite');
  const password = randomBytes(20).toString('hex');
  let calls = 0, slow = false;
  const model = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer test-model-secret');
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.stream, true); assert.equal(body.tools, undefined); calls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '你好，' } }] }) + '\n\n');
    if (slow) await new Promise((done) => setTimeout(done, 800));
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '星夜里的朋友。<script>window.pwned=1</script>' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const config = { ...readConfig({ envFile: false }), dbPath, seedDemo: false, baseUrl: '', secureCookie: false, host: '127.0.0.1', ipGeoEnabled: false,
    chat: { apiBase: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'test-model-secret', model: 'test-model', assistantName: '大肥鱼', systemPrompt: '测试助理。' } };
  let db = openDatabase(dbPath); await setAdmin(db, 'owner', password); db.close();
  let server, base;
  async function start() { server = await createApplication(config); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  t.after(async () => { if (server?.listening) await stop(); model.closeAllConnections(); await new Promise((done) => model.close(done)); await rm(directory, { recursive: true, force: true }); });
  await start();
  async function request(path, { as, method = 'GET', json, body, key = randomUUID(), csrf = true } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(as ? { Cookie: as.cookie, ...(csrf ? { 'X-CSRF-Token': as.csrf } : {}) } : {}), ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), 'Idempotency-Key': key }, body: json === undefined ? body : JSON.stringify(json) });
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()); return { status: response.status, response, value };
  }
  async function login(username) {
    const result = await request('/api/chat/login', { method: 'POST', json: { username, password } }); assert.equal(result.status, 200, JSON.stringify(result.value));
    const auth = { cookie: result.response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), csrf: result.value.csrf };
    auth.account = (await request('/api/chat/session', { as: auth })).value; return auth;
  }
  const admin = await login('owner'); const accounts = {};
  await t.test('one login distinguishes admin/member; member never gets a management session', async () => {
    assert.equal(admin.account.role, 'admin');
    for (const name of ['alice', 'bob', 'charlie']) { const created = await request('/api/admin/accounts', { as: admin, method: 'POST', json: { username: name, password } }); assert.equal(created.status, 201); accounts[name] = await login(name); assert.equal(accounts[name].account.role, 'member'); }
    assert.equal((await request('/api/admin/settings', { as: accounts.alice })).status, 401);
    assert.equal((await request('/api/admin/accounts', { as: accounts.alice })).status, 401);
    assert.equal((await request('/api/chat/threads', { as: accounts.alice, method: 'POST', json: {}, csrf: false })).status, 403);
    assert.equal((await request('/api/chat/threads')).status, 401);
    assert.equal((await request('/api/admin/login', { method: 'POST', json: { username: 'alice', password } })).status, 401);
    assert.equal((await request('/chat')).status, 200);
    assert.equal((await request('/chat.webmanifest')).value.toString().includes('月明かり'), true);
  });
  const create = async (as, json = {}) => { const r = await request('/api/chat/threads', { as, method: 'POST', json }); assert.equal(r.status, 201, JSON.stringify(r.value)); return r.value.item; };
  const send = async (as, id, text, extra = {}) => { const r = await request('/api/chat/threads/' + id + '/messages', { as, method: 'POST', json: { text, ...extra } }); assert.equal(r.status, 201, JSON.stringify(r.value)); return r.value.items; };
  let direct, group, sharedFile;
  await t.test('DM pair is atomic/deduplicated; groups deliver only to actual members', async () => {
    assert.equal((await request('/api/chat/friend-requests',{as:accounts.alice,method:'POST',json:{target:accounts.bob.account.key}})).status,200);
    assert.equal((await request('/api/chat/friend-requests',{as:accounts.bob,method:'POST',json:{target:accounts.alice.account.key}})).status,200);
    const results = await Promise.all([create(accounts.alice, { kind: 'direct', members: [accounts.bob.account.key] }), create(accounts.bob, { kind: 'direct', members: [accounts.alice.account.key] })]);
    assert.equal(results[0].id, results[1].id); direct = results[0];
    const key = randomUUID(), payload = { text: '私聊的第一句话' };
    const first = await request('/api/chat/threads/' + direct.id + '/messages', { as: accounts.alice, method: 'POST', json: payload, key });
    const retry = await request('/api/chat/threads/' + direct.id + '/messages', { as: accounts.alice, method: 'POST', json: payload, key }); assert.deepEqual(retry.value, first.value); assert.equal(calls, 0);
    assert.equal((await request('/api/chat/threads/' + direct.id + '/messages', { as: accounts.bob, method: 'POST', json: { text: '双方可以使用相同本地序号' }, key })).status, 201, 'retry keys are scoped to the verified sender');
    assert.equal((await request('/api/chat/threads/' + direct.id, { as: accounts.bob })).value.messages[0].body, payload.text);
    assert.equal((await request('/api/chat/threads/' + direct.id, { as: admin })).status, 404, 'site admin has no implicit access to another user DM');
    assert.equal((await request('/api/chat/threads/' + direct.id, { as: accounts.charlie })).status, 404);
    assert.equal((await request('/api/chat/threads', { as: accounts.bob })).value.items.find((r) => r.id === direct.id).unread, 1);
    await request('/api/chat/threads/' + direct.id + '/read', { as: accounts.bob, method: 'POST' });
    assert.equal((await request('/api/chat/threads', { as: accounts.bob })).value.items.find((r) => r.id === direct.id).unread, 0);
    group = await create(accounts.alice, { kind: 'group', title: '星夜小聚', members: [accounts.bob.account.key, admin.account.key] });
    for(const invited of[accounts.bob,admin]){assert.equal((await request('/api/chat/threads/'+group.id,{as:invited})).status,404);const invitation=(await request('/api/chat/invitations',{as:invited})).value.items.find(i=>i.threadId===group.id&&i.state==='pending');assert.ok(invitation);assert.equal((await request('/api/chat/invitations/'+invitation.id+'/accept',{as:invited,method:'POST'})).status,200);}
    await send(accounts.bob, group.id, '群聊消息');
    assert.equal((await request('/api/chat/threads/' + group.id, { as: admin })).value.messages[0].senderName, 'bob');
    assert.equal((await request('/api/chat/threads/' + group.id, { as: accounts.charlie })).status, 404);
    assert.equal((await request('/api/chat/threads/' + group.id + '/messages', { as: admin, method: 'POST', json: { text: '/待办' } })).status, 403, 'private moderation commands cannot expose questions to a group');
  });
  await t.test('reconnect cursor and bounded read retain newer unread messages', async () => {
    const path = '/api/chat/threads/' + direct.id;
    const from = accounts.alice, to = accounts.bob;
    const [first] = await send(from, direct.id, '已看到的消息');
    const [unseen] = await send(from, direct.id, '离线期间的新消息', { mentionAssistant: true });
    assert.equal(calls, 0, 'friend messages stay between friends');
    const recovered = await request(path + '?after=' + first.id, { as: to });
    assert.deepEqual(recovered.value.messages.map(message => message.id), [unseen.id]);
    assert.equal(recovered.value.nextAfter, null);
    const read = await request(path + '/read?through=' + first.id, { as: to, method: 'POST' });
    assert.equal(read.status, 200);
    assert.equal((await request(path, { as: to })).value.item.unread, 1);
    assert.equal((await request(path + '/read?through=' + unseen.id, { as: to, method: 'POST' })).status, 200);
    assert.equal((await request(path, { as: to })).value.item.unread, 0);
  });
  await t.test('files live in DB, are shared only with current members and remain referenced during collection', async () => {
    const picture = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ba97ad' } }).png().toBuffer();
    const form = new FormData(); form.set('kind', 'image'); form.set('file', new Blob([picture]), '星光.png');
    const uploaded = await request('/api/chat/files', { as: accounts.alice, method: 'POST', body: form }); assert.equal(uploaded.status, 201, JSON.stringify(uploaded.value)); sharedFile = uploaded.value.item.id;
    assert.equal((await request('/media/' + sharedFile, { as: accounts.bob })).status, 403);
    assert.equal((await request('/media/' + sharedFile, { as: admin })).status, 403, 'admin does not read another uploader private chat file before it is shared');
    await send(accounts.alice, group.id, '共享图片', { attachmentIds: [sharedFile] });
    assert.deepEqual((await request('/media/' + sharedFile, { as: accounts.bob })).value, picture);
    assert.deepEqual((await request('/media/' + sharedFile, { as: admin })).value, picture);
    assert.equal((await request('/media/' + sharedFile, { as: accounts.charlie })).status, 403);
    assert.equal((await request('/media/' + sharedFile)).status, 401);
    const changed = await request('/api/chat/threads/' + group.id + '/members', { as: accounts.alice, method: 'PUT', json: { members: [admin.account.key] } }); assert.equal(changed.status, 200);
    assert.equal((await request('/media/' + sharedFile, { as: accounts.bob })).status, 403);
    assert.equal((await request('/api/chat/threads/' + group.id, { as: accounts.bob })).status, 404);
    db = openDatabase(dbPath); db.prepare('UPDATE staged_files SET created_at=? WHERE media_id=?').run('2020-01-01T00:00:00.000Z', sharedFile); assert.equal(collectStaged(db, { ids: [sharedFile], days: 0 }).files, 0); db.close();
  });
  await t.test('AI streams once per message; stop/retry and restart never repeat a paid request implicitly', async () => {
    const ai = await create(accounts.alice); const key = randomUUID();
    const r = await request('/api/chat/threads/' + ai.id + '/messages', { as: accounts.alice, method: 'POST', json: { text: '你好' }, key }); const assistant = r.value.items.find((m) => m.role === 'assistant');
    await request('/api/chat/threads/' + ai.id + '/messages', { as: accounts.alice, method: 'POST', json: { text: '你好' }, key });
    async function waitStatus(id, status) { for (let i = 0; i < 60; i++) { const data = await request('/api/chat/threads/' + ai.id, { as: accounts.alice }); const row = data.value.messages.find((m) => m.id === id); if (row?.status === status) return row; await new Promise((done) => setTimeout(done, 40)); } throw Error('status not reached: ' + status); }
    const completed = await waitStatus(assistant.id, 'complete'); assert.ok(completed.body.includes('<script>')); assert.equal(calls, 1);
    assert.equal((await request('/api/chat/threads/' + ai.id, { as: accounts.bob })).status, 404);
    assert.equal((await request('/api/chat/threads/' + ai.id + '/messages', { as: accounts.alice, method: 'POST', json: { text: '/待办' } })).status, 403);
    slow = true; const rows = await send(accounts.alice, ai.id, '稍慢一点'); const pending = rows.find((m) => m.role === 'assistant');
    await new Promise((done) => setTimeout(done, 150)); await request('/api/chat/threads/' + ai.id + '/stop', { as: accounts.alice, method: 'POST' }); await waitStatus(pending.id, 'stopped');
    const previousCalls = calls; await stop(); await start(); assert.equal(calls, previousCalls); assert.equal((await request('/api/chat/threads/' + ai.id, { as: accounts.alice })).value.messages.at(-1).status, 'stopped');
    slow = false; const retried = await request('/api/chat/threads/' + ai.id + '/retry', { as: accounts.alice, method: 'POST', json: { messageId: pending.id } }); assert.equal(retried.status, 200); await waitStatus(pending.id, 'complete'); assert.equal(calls, previousCalls + 1);
  });
  await t.test('website review uses native APIs and requires explicit save then sync', async () => {
    const question = await request('/api/public/questions', { method: 'POST', json: { anonymous: true, question: '应用原生审核验收' } }); assert.equal(question.status, 201);
    assert.equal((await request('/api/chat/notices/sync', { as: accounts.alice, method: 'POST' })).status, 403);
    const notices = await request('/api/chat/notices/sync', { as: admin, method: 'POST' }); assert.equal(notices.value.created, 1);
    assert.equal((await request('/api/chat/notices/sync', { as: admin, method: 'POST' })).value.created, 0);
    assert.ok((await request('/api/chat/threads/' + notices.value.threadId, { as: admin })).value.messages[0].metadata.noticeEventId);
    const thread = await create(admin); const rows = await send(admin, thread.id, '/回复 ' + question.value.id + ' 由应用明确保存与同步的答复'); const action = rows.at(-1).metadata.action;
    assert.equal((await request('/api/admin/questions?state=pending', { as: admin })).value.items.find((q) => q.id === question.value.id).reply, '');
    const saved = await request('/api/admin/questions/' + action.id + '/draft', { as: admin, method: 'PUT', json: { version: action.version, reply: action.reply }, key: 'app-confirm-' + rows.at(-1).id }); assert.equal(saved.status, 200);
    assert.equal((await request('/api/public/questions')).value.items.length, 0);
    const synced = await request('/api/admin/drafts/' + saved.value.draft.id + '/sync', { as: admin, method: 'POST', json: { version: saved.value.draft.version } }); assert.equal(synced.status, 200);
    assert.equal((await request('/api/public/questions')).value.items[0].reply, action.reply);
    assert.ok((await request('/')).value.toString().includes(action.reply));
    const picture = (await request('/media/' + sharedFile, { as: accounts.alice })).value;
    const form = new FormData(); form.set('image', new Blob([picture]), '新增猫图.png');
    const cat = await request('/api/admin/uploads/cats', { as: admin, method: 'POST', body: form }); assert.equal(cat.status, 201);
    assert.equal((await request('/api/admin/drafts/' + cat.value.id + '/sync', { as: admin, method: 'POST', json: { version: cat.value.version } })).status, 200);
    const release = await request('/api/chat/notices/sync', { as: admin, method: 'POST' }); assert.equal(release.value.created, 1);
    assert.equal((await request('/api/chat/notices/sync', { as: admin, method: 'POST' })).value.created, 0);
  });
  await t.test('persistent memberships/media survive restart; account disable revokes access', async () => {
    await stop(); await start(); assert.equal((await request('/api/chat/threads/' + direct.id, { as: accounts.bob })).value.messages[0].body, '私聊的第一句话');
    const noticeSync = await request('/api/chat/notices/sync', { as: admin, method: 'POST' }); assert.equal(noticeSync.value.created, 0, 'acknowledged notices never repeat after restart');
    assert.equal((await request('/api/chat/notices/sync', { as: admin, method: 'POST' })).value.created, 0);
    assert.equal((await request('/media/' + sharedFile, { as: accounts.alice })).status, 200);
    const id = (await request('/api/admin/accounts', { as: admin })).value.items.find((a) => a.username === 'bob').id;
    assert.equal((await request('/api/admin/accounts/' + id, { as: admin, method: 'PATCH', json: { disabled: true } })).status, 200);
    assert.equal((await request('/api/chat/threads', { as: accounts.bob })).status, 401);
    db = openDatabase(dbPath); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); db.close();
  });
});

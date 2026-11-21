import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { test } from 'node:test';
import sharp from 'sharp';
import { createApplication } from '../server/app.mjs';
import { setChatAccount } from '../server/auth.mjs';
import { openDatabase, readConfig, root } from '../server/core.mjs';
import { chatRetentionMs, pruneChat, pruneChatBatch, retainedAfter } from '../server/chat-retention.mjs';

test('shared chat sessions, revision cursor and strict 30-day retention', { timeout: 60_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tsukiakari-chat-retention-'));
  const dbPath = join(dir, 'chat.sqlite'), restoreSource = join(dir, 'snapshot.sqlite');
  const reference = Date.now(), edge = reference - chatRetentionMs;
  let time = edge - 1, server, origin;
  const db = openDatabase(dbPath);
  const accounts = ['moon', 'star', 'guest'].map(username => ({ username, password: randomBytes(16).toString('hex') }));
  for (const account of accounts) await setChatAccount(db, account);
  const config = { ...readConfig({ envFile: false }), dbPath, host: '127.0.0.1', baseUrl: '', secureCookie: false,
    seedDemo: false, ipGeoEnabled: false, chatClock: () => time };
  async function start() {
    server = await createApplication(config);
    server.listen(0, config.host); await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  async function stop() {
    server.closeAllConnections(); await new Promise(done => server.close(done));
  }
  t.after(async () => { if (server?.listening) await stop(); db.close(); await rm(dir, { recursive: true, force: true }); });
  await start();
  async function request(path, { as, method = 'GET', json, body, key = randomUUID(), csrf = as?.csrf } = {}) {
    const response = await fetch(origin + path, { method, headers: {
      ...(as && { Cookie: as.cookie }), ...(csrf && { 'X-CSRF-Token': csrf }), 'Idempotency-Key': key,
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, body: json === undefined ? body : JSON.stringify(json) });
    const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, value, status: response.status };
  }
  async function login(account, remember = true) {
    const result = await request('/api/chat/login', { method: 'POST', json: { ...account, remember } });
    assert.equal(result.status, 200);
    const headers = result.response.headers.getSetCookie();
    const cookie = headers.find(value => value.startsWith('moonlit_chat_session='));
    const auth = { cookie: cookie.split(';')[0], csrf: result.value.csrf };
    return { ...auth, account: (await request('/api/chat/session', { as: auth })).value, attributes: cookie.slice(cookie.indexOf(';')) };
  }
  const moon = await login(accounts[0]), secondMoon = await login(accounts[0]), star = await login(accounts[1]), guest = await login(accounts[2], false);
  const send = (path, as, json, key) => request(path + '/messages', { as, method: 'POST', json, key });
  const newThread = async json => '/api/chat/threads/' + (await request('/api/chat/threads', { as: moon, method: 'POST', json })).value.item.id;
  const direct = await (async () => {
    for (const [as, other] of [[moon, star], [star, moon]]) await request('/api/chat/friend-requests', { as, method: 'POST', json: { target: other.account.key } });
    return newThread({ kind: 'direct', members: [star.account.key] });
  })();

  await t.test('remembered cookie renews and per-device logout leaves the other login active', async () => {
    assert.match(moon.attributes, /HttpOnly; SameSite=Strict; Max-Age=2592000/);
    assert.doesNotMatch(guest.attributes, /Max-Age/);
    assert.equal(guest.account.renewable, false);
    assert.equal(moon.account.key, secondMoon.account.key);
    assert.notEqual(moon.cookie, secondMoon.cookie);
    const hash = db.prepare('SELECT token_hash FROM chat_sessions WHERE csrf=?').get(moon.csrf).token_hash;
    db.prepare('UPDATE chat_sessions SET expires_at=? WHERE token_hash=?').run(reference + 60_000, hash);
    assert.equal((await request('/api/chat/session/refresh', { as: moon, method: 'POST', csrf: null })).status, 403);
    const renewed = await request('/api/chat/session/refresh', { as: moon, method: 'POST' });
    assert.match(renewed.response.headers.getSetCookie()[0], /HttpOnly; SameSite=Strict; Max-Age=/);
    assert.ok(db.prepare('SELECT expires_at FROM chat_sessions WHERE token_hash=?').get(hash).expires_at > reference + 60_000);
    const extraLogin = await login(accounts[0]);
    await request('/api/chat/logout', { as: extraLogin, method: 'POST' });
    assert.equal((await request('/api/chat/session', { as: extraLogin })).status, 401);
    assert.equal((await request('/api/chat/session', { as: secondMoon })).status, 200);
  });

  const picture = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#bca8d5' } }).png().toBuffer();
  async function upload() {
    const body = new FormData(); body.set('kind', 'image'); body.set('file', new Blob([picture]), '演示月光.png');
    const { value, status } = await request('/api/chat/files', { as: moon, method: 'POST', body });
    assert.equal(status, 201); return value.item.id;
  }
  const privateFile = await upload(), sharedFile = await upload(), avatar = await upload(), personaImage = await upload(), websiteImage = await upload();
  db.prepare('UPDATE chat_profiles SET avatar_id=? WHERE account_key=?').run(avatar, moon.account.key);
  db.prepare('INSERT INTO chat_persona_drafts VALUES(?,?,?,?,?)').run(moon.account.key, 'demo', JSON.stringify({ avatar: '/chat-media/' + personaImage }), null, new Date(reference).toISOString());
  db.prepare('UPDATE media SET published=1 WHERE id=?').run(websiteImage);
  const oldBody = { text: '记住：演示过期内容', attachmentIds: [privateFile, sharedFile, avatar, personaImage, websiteImage] }, oldKey = randomUUID();
  const { value: { items: [old] }, status } = await send(direct, moon, oldBody, oldKey);
  assert.equal(status, 201);
  assert.equal((await request('/chat-media/' + privateFile, { as: star })).status, 200);
  time = edge;
  const exact = (await send(direct, moon, { text: '演示正好30天' })).value.items[0];
  const ai = await newThread({});
  const oldAI = (await send(ai, moon, { text: '/帮助' })).value.items;
  time = edge + 1;
  // Reused files should still be readable through the retained reference.
  const live = (await send(direct, moon, { text: '演示保留临界内容', attachmentIds: [sharedFile] })).value.items[0];
  db.prepare('UPDATE chat_messages SET updated_at=? WHERE id=?').run(new Date(reference).toISOString(), old.id);
  time = reference;

  await t.test('boundary, membership, metadata and media all use creation time before physical deletion', async () => {
    assert.equal((await request(direct, { as: guest })).status, 404);
    assert.equal((await request(direct + '/sync?cursor=0', { as: guest })).status, 404);
    assert.equal((await request(direct + '/search?q=演示', { as: guest })).status, 404);
    assert.deepEqual((await request(direct, { as: star })).value.messages.map(m => m.id), [live.id]);
    assert.deepEqual((await request(direct + '?after=0', { as: secondMoon })).value.messages.map(m => m.id), [live.id]);
    assert.deepEqual((await request(direct + '?before=' + live.id, { as: moon })).value.messages, []);
    assert.deepEqual((await request(direct + '/sync?cursor=0', { as: moon })).value.messages.map(m => m.id), [live.id]);
    assert.deepEqual((await request(direct + '/search?q=演示', { as: moon })).value.messages.map(m => m.id), [live.id]);
    assert.equal((await request(ai, { as: moon })).value.item.title, '新的夜话');
    assert.equal((await request(direct, { as: star })).value.item.unread, 1);
    await request(direct + '/read?through=' + live.id, { as: star, method: 'POST' });
    assert.equal((await request(direct, { as: star })).value.item.unread, 0);
    assert.equal((await request('/api/chat/notifications/claim', { as: star, method: 'POST', json: { messageId: exact.id } })).status, 404);
    for (const as of [star, moon]) for (const prefix of ['/chat-media/', '/media/']) assert.equal((await request(prefix + privateFile, { as })).status, 403);
    assert.equal((await request('/chat-media/' + sharedFile, { as: star })).response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await request('/media/' + websiteImage)).status, 200);
    assert.equal((await send(direct, secondMoon, oldBody, oldKey)).value.error.code, 'message_expired');
    assert.ok(db.prepare('SELECT id FROM chat_messages WHERE id=?').get(old.id));
  });

  await backup(db, restoreSource);
  await t.test('bounded cleanup, replay tombstone, protected data and fresh restore', async () => {
    assert.equal(pruneChatBatch(db, retainedAfter(() => time), 1).messages, 1);
    await pruneChat(db, { clock: () => time });
    assert.equal((await pruneChat(db, { clock: () => time })).messages, 0);
    for (const message of [old, exact, ...oldAI]) assert.equal(db.prepare('SELECT id FROM chat_messages WHERE id=?').get(message.id), undefined);
    assert.equal(db.prepare('SELECT id FROM media WHERE id=?').get(privateFile), undefined);
    for (const id of [sharedFile, avatar, personaImage, websiteImage]) assert.ok(db.prepare('SELECT id FROM media WHERE id=?').get(id));
    const memory = db.prepare('SELECT body,source_message_id FROM chat_memories WHERE owner_key=?').get(moon.account.key);
    assert.equal(memory.source_message_id, null); assert.equal(memory.body, '演示过期内容');
    assert.equal((await send(direct, secondMoon, oldBody, oldKey)).value.error.code, 'message_expired');
    const restorePath = join(dir, 'restored.sqlite');
    execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/site.mjs', 'restore', restoreSource],
      { cwd: root, env: { ...process.env, DATABASE_PATH: restorePath }, timeout: 10000 });
    const restored = openDatabase(restorePath);
    try {
      assert.equal(restored.prepare('SELECT id FROM chat_messages WHERE id=?').get(old.id), undefined);
      assert.equal(restored.prepare('SELECT id FROM media WHERE id=?').get(avatar).id, avatar);
      assert.equal(restored.prepare('SELECT count(*) AS n FROM chat_sessions').get().n, 0);
      assert.equal(restored.prepare('PRAGMA foreign_key_check').get(), undefined);
    } finally { restored.close(); }
  });

  await t.test('revision catches changes to old IDs and pages until all devices agree', async () => {
    const snapshot = (await request(direct, { as: secondMoon })).value;
    const add = db.prepare(`INSERT INTO chat_messages(thread_id,role,sender_key,sender_name,body,status,created_at,updated_at)
      VALUES(?,'user',?,'moon',?,'complete',?,?)`);
    const timestamp = new Date(reference).toISOString();
    for (let i = 0; i < 65; i++) add.run(direct.split('/').at(-1), moon.account.key, '演示补齐 ' + i, timestamp, timestamp);
    // An older visible message changes after all newer ones arrived, as with a completed streaming reply.
    db.prepare('UPDATE chat_messages SET body=?,updated_at=? WHERE id=?').run('演示已更新', timestamp, live.id);
    const first = (await request(direct + '/sync?cursor=' + snapshot.syncCursor, { as: secondMoon })).value;
    const last = (await request(direct + '/sync?cursor=' + first.cursor, { as: secondMoon })).value;
    assert.equal(first.hasMore, true); assert.equal(first.messages.length, 60);
    assert.equal(last.hasMore, false); assert.equal(last.messages.length, 6);
    assert.equal(last.messages.at(-1).id, live.id); assert.equal(last.messages.at(-1).body, '演示已更新');
    assert.equal(new Set([...first.messages, ...last.messages].map(item => item.id)).size, 66);
    const current = (await request(direct, { as: moon })).value;
    assert.equal((await request(direct + '?before=' + current.before, { as: moon })).value.messages.length, 6);
    assert.deepEqual((await request(direct + '/sync?cursor=' + (last.cursor + 2), { as: moon })).value.reset, true);
    await stop(); await start();
    assert.deepEqual((await request(direct + '/sync?cursor=' + last.cursor, { as: secondMoon })).value.messages, []);
    assert.equal((await send(direct, moon, oldBody, oldKey)).status, 410);
    assert.equal((await request('/chat-media/' + sharedFile, { as: star })).status, 200);
  });
});

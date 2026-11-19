import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/app.mjs';
import { setAdmin } from '../server/auth.mjs';
import { openDatabase, readConfig, root } from '../server/core.mjs';

test('editable workroom, live notifications, atomic media edits and private deduplicated activity survive restart', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonlit-workroom-'));
  const dbPath = join(directory, 'site.sqlite');
  const config = { ...readConfig({ envFile: false }), dbPath, seedDemo: true, bots: new Map(), baseUrl: '', secureCookie: false, host: '127.0.0.1' };
  const password = randomBytes(24).toString('hex');
  let db = openDatabase(dbPath); await setAdmin(db, 'tester', password); db.close();
  let server, base, stream;
  const controller = new AbortController();
  async function start() { server = await createApplication(config); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { controller.abort(); await stream?.cancel().catch(() => {}); await new Promise((done) => server.close(done)); }
  t.after(async () => {
    if (server?.listening) await stop();
    for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm']) await rm(file, { force: true });
    await rmdir(directory);
  });
  await start();
  let auth = {};
  async function request(path, { method = 'GET', json, body, headers = {}, admin = false } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(admin ? auth : {}), ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: json === undefined ? body : JSON.stringify(json) });
    const value = response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : null;
    return { response, value, status: response.status };
  }
  async function login() {
    const result = await request('/api/admin/login', { method: 'POST', json: { username: 'tester', password } });
    assert.equal(result.status, 200);
    auth = { Cookie: result.response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': result.value.csrf };
  }
  await login();
  async function syncItem(item) {
    const result = await request('/api/admin/drafts/' + item.draftId + '/sync', { method: 'POST', admin: true, json: { version: item.version } });
    assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.item;
  }
  assert.equal((await request('/api/admin/settings')).status, 401);
  for (const kind of ['visitors', 'modifications']) assert.equal((await request('/api/admin/logs/' + kind)).status, 401);
  let settings = (await request('/api/admin/settings', { admin: true })).value.item;
  assert.equal(settings.characters.length, 2);
  assert.ok(settings.characters.every((character) => character.images[0].media.thumbnail));
  assert.ok(settings.about.portraitMedia.url && settings.heroOriginal.url);
  const sse = await fetch(base + '/api/public/updates', { signal: controller.signal });
  assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  stream = sse.body.getReader();
  const decoder = new TextDecoder();
  assert.match(decoder.decode((await stream.read()).value), /event: ready/);
  async function notification(topic) {
    const timeout = setTimeout(() => controller.abort(), 4000);
    let text = '';
    try {
      while (!text.includes('"' + topic + '"')) {
        const chunk = await stream.read(); if (chunk.done) throw new Error('SSE ended early'); text += decoder.decode(chunk.value);
      }
      assert.doesNotMatch(text, /csrf|password|reply|author/);
    } finally { clearTimeout(timeout); }
  }
  const settingsData = (patch, version = settings.version) => {
    const body = new FormData(); body.set('patch', JSON.stringify(patch)); body.set('version', version); return body;
  };
  const body = settingsData({ heroTitle: '验收后的月下花笺', texts: { 'home.enter': '进入网站 · 月下' }, about: { intro: '<script>这是安全显示的文字</script>' } });
  const key = randomUUID(); const before = Date.now();
  let changed = await request('/api/admin/settings', { method: 'PUT', body, admin: true, headers: { 'Idempotency-Key': key } });
  assert.equal(changed.status, 200);
  settings = changed.value.item;
  assert.notEqual((await request('/api/public/site')).value.item.heroTitle, settings.heroTitle);
  await syncItem(settings);
  await notification('settings'); assert.ok(Date.now() - before < 1100, 'SSE reached the client within one second');
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body, admin: true, headers: { 'Idempotency-Key': key } })).value.item.version, settings.version);
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: settingsData({ name: '冲突' }, 1), admin: true, headers: { 'Idempotency-Key': randomUUID() } })).status, 409);
  const characters = structuredClone(settings.characters); characters[0].world = '更新后的世界观';
  const image = await readFile(resolve(root, 'public/assets/portrait.webp'));
  const roleBody = settingsData({ characters: characters.map((item) => item.id === 'zhiyao' ? { ...item, images: [...item.images, { mediaId: 'file:asset0', label: '第二张设定图' }] } : item) });
  roleBody.set('asset0', new Blob([image], { type: 'image/webp' }), 'reference.webp');
  changed = await request('/api/admin/settings', { method: 'PUT', body: roleBody, admin: true, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(changed.status, 200); settings = changed.value.item;
  assert.equal(settings.characters[1].images.length, 2);
  await syncItem(settings);
  const savedMedia = settings.characters[1].images[1].media.url;
  assert.equal((await request(savedMedia)).status, 200);

  let songs = (await request('/api/public/music')).value.items;
  const song = (await request('/api/public/music/' + songs[0].id)).value.item;
  const edit = new FormData();
  for (const [name, value] of Object.entries({ version: song.version, title: '更新的歌曲', translation: song.translation, note: '保存后立即发布', artistId: song.artistId, producer: song.producer, lyricist: song.lyricist, lyrics: song.lyrics })) edit.set(name, value);
  const editKey = randomUUID();
  let edited = await request('/api/admin/content/music/' + song.id, { method: 'PUT', body: edit, admin: true, headers: { 'Idempotency-Key': editKey } });
  assert.equal(edited.status, 200); assert.equal(edited.value.item.audio.id, song.audio.id); assert.equal(edited.value.item.version, 2);
  assert.equal((await request('/api/admin/content/music/' + song.id, { method: 'PUT', body: edit, admin: true, headers: { 'Idempotency-Key': editKey } })).value.item.version, 2);
  await syncItem(edited.value.item);
  edit.set('title', '不同的重试内容');
  assert.equal((await request('/api/admin/content/music/' + song.id, { method: 'PUT', body: edit, admin: true, headers: { 'Idempotency-Key': editKey } })).status, 409);
  db = openDatabase(dbPath); const mediaCount = db.prepare('SELECT count(*) AS n FROM media').get().n; db.close();
  const invalid = settingsData({ name: 'x'.repeat(121), heroMediaId: 'file:asset0' }); invalid.set('asset0', new Blob([image]), 'reference.webp');
  assert.equal((await request('/api/admin/settings', { method: 'PUT', body: invalid, admin: true, headers: { 'Idempotency-Key': randomUUID() } })).status, 400);
  db = openDatabase(dbPath); assert.equal(db.prepare('SELECT count(*) AS n FROM media').get().n, mediaCount); db.close();
  const cat = (await request('/api/public/cats')).value.items[0];
  const catEdit = new FormData(); catEdit.set('version', cat.version); catEdit.set('image', new Blob([image]), 'replacement.webp');
  const catResult = await request('/api/admin/content/cats/' + cat.id, { method: 'PUT', body: catEdit, admin: true, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(catResult.status, 200); assert.notEqual(catResult.value.item.image.id, cat.image.id);
  assert.equal((await request('/api/admin/content/cats/' + cat.id, { method: 'DELETE', admin: true })).status, 200);
  assert.equal((await request('/api/public/cats/' + cat.id)).status, 404);
  const game = (await request('/api/public/games/' + (await request('/api/public/games')).value.items[0].id)).value.item;
  const gameEdit = new FormData();
  for (const [name, value] of Object.entries({ version: game.version, title: game.title, translation: game.translation, genre: game.genre, note: '修改后的游戏寄语', description: '完整游戏介绍已修改', keepImages: JSON.stringify(game.images.map((entry) => entry.id)) })) gameEdit.set(name, value);
  const updatedGame = await request('/api/admin/content/games/' + game.id, { method: 'PUT', body: gameEdit, admin: true, headers: { 'Idempotency-Key': randomUUID() } });
  assert.equal(updatedGame.status, 200); assert.equal(updatedGame.value.item.description, '完整游戏介绍已修改');
  assert.equal(updatedGame.value.item.logo.id, game.logo.id); assert.deepEqual(updatedGame.value.item.images, game.images);
  await syncItem(updatedGame.value.item);
  gameEdit.set('version', 2); gameEdit.set('keepImages', '[]');
  assert.equal((await request('/api/admin/content/games/' + game.id, { method: 'PUT', body: gameEdit, admin: true, headers: { 'Idempotency-Key': randomUUID() } })).status, 400);
  assert.equal((await request('/api/public/games/' + game.id)).value.item.version, 2);

  const segmentId = randomUUID();
  const enter = { type: 'page.enter', segmentId, path: '/music', entryPath: '/' };
  const activity = await request('/api/public/activity', { method: 'POST', json: enter });
  assert.equal(activity.status, 200);
  const visitorCookie = activity.response.headers.get('set-cookie').split(';')[0];
  const activityRequest = (json) => request('/api/public/activity', { method: 'POST', headers: { Cookie: visitorCookie }, json });
  await activityRequest(enter); // A retried request is not another visit.
  await Promise.all(Array.from({ length: 3 }, () => activityRequest({ ...enter, segmentId: randomUUID() })));
  await activityRequest({ type: 'heartbeat', segmentId, visibleMs: 10, hidden: true });
  const event = { type: 'song.play', targetId: song.id, eventId: randomUUID(), segmentId };
  await activityRequest(event); await activityRequest(event);
  const pageLogs = (await request('/api/admin/logs/visitors?type=page.enter&path=/music', { admin: true })).value;
  assert.equal(pageLogs.total, 1); assert.equal(pageLogs.items[0].repeats, 4);
  assert.equal(pageLogs.items[0].source, '直接访问／来源未知');
  assert.match(pageLogs.items[0].source_basis, /Referer/);
  assert.equal((await request('/api/admin/logs/visitors?type=song.play', { admin: true })).value.total, 1);
  await activityRequest({ ...enter, path: '/about', segmentId: randomUUID(), channel: 'Bilibili测试' });
  const ref = (await request('/api/admin/logs/visitors?path=/about', { admin: true })).value.items[0];
  assert.match(ref.source_basis, /渠道参数/);
  const modifications = (await request('/api/admin/logs/modifications?limit=2', { admin: true })).value;
  assert.ok(modifications.total >= 6 && modifications.items.length === 2);
  assert.doesNotMatch(JSON.stringify(modifications), new RegExp(password));
  assert.equal((await request('/api/admin/logs/visitors?from=invalid', { admin: true })).status, 400);

  await stop(); await start();
  const persisted = (await request('/api/public/site')).value.item;
  assert.equal(persisted.heroTitle, '验收后的月下花笺'); assert.equal(persisted.characters[0].world, '更新后的世界观');
  assert.equal((await request(savedMedia)).status, 200);
  assert.equal((await request('/api/public/music/' + song.id)).value.item.title, '更新的歌曲');
  assert.equal((await request('/api/admin/logs/visitors?type=song.play', { admin: true })).value.total, 1);
});

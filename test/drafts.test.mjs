import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { test } from 'node:test';
import { createApplication } from '../server/app.mjs';
import { setAdmin } from '../server/auth.mjs';
import { openDatabase, readConfig, root, sha256 } from '../server/core.mjs';
import { demoWave } from '../server/demo.mjs';
import { regeneratePreviews } from '../server/media.mjs';

test('saved drafts stay private; explicit sync publishes one version, batch and deduplicated event; media and drafts persist', { timeout: 40000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'moonlit-drafts-')); const dbPath = join(directory, 'site.sqlite');
  const password = randomBytes(24).toString('hex'); const tokens = Object.fromEntries(['writer', 'reviewer', 'reader', 'notifier'].map((id) => [id, randomBytes(32).toString('base64url')]));
  const grants = { writer: ['music:write', 'games:write', 'batches:read'], reviewer: ['content:sync', 'batches:read', 'questions:review', 'events:read', 'events:ack'], reader: ['catalog:read'], notifier: ['content-events:read', 'events:ack'] };
  const config = { ...readConfig({ envFile: false }), dbPath, seedDemo: false, baseUrl: '', secureCookie: false, host: '127.0.0.1',
    bots: new Map(Object.entries(grants).map(([id, scopes]) => [id, { id, hash: sha256(tokens[id]), scopes: new Set(scopes) }])) };
  let db = openDatabase(dbPath); await setAdmin(db, 'tester', password); db.close();
  let server, base; let auth;
  async function start() { server = await createApplication(config); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = 'http://127.0.0.1:' + server.address().port; }
  async function stop() { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  t.after(async () => { if (server?.listening) await stop(); for (const file of [dbPath, dbPath + '-wal', dbPath + '-shm']) await rm(file, { force: true }); await rmdir(directory); });
  async function request(path, { method = 'GET', json, body, admin = false, bot, key, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(admin ? auth : {}), ...(bot ? { Authorization: 'Bearer ' + tokens[bot] } : {}), ...(key ? { 'Idempotency-Key': key } : {}), ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: json === undefined ? body : JSON.stringify(json) });
    const isJson = response.headers.get('content-type')?.startsWith('application/json');
    const value = isJson ? await response.json() : null;
    const binary = isJson ? null : Buffer.from(await response.arrayBuffer());
    return { status: response.status, response, value, binary };
  }
  await start();
  const login = await request('/api/admin/login', { method: 'POST', json: { username: 'tester', password } });
  assert.equal(login.status, 200); auth = { Cookie: login.response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': login.value.csrf };
  const picture = await readFile(resolve(root, 'content/assets/shion.png'));
  const music = new FormData();
  for (const [key, value] of Object.entries({ title: '草稿歌曲', artistName: '草稿歌手', producer: '明确的 P 主', note: '保存与同步分离' })) music.set(key, value);
  music.set('audio', new Blob([demoWave(6)]), 'demo.wav'); music.set('artistImage', new Blob([picture]), 'artist.png');
  music.set('lyricsFile', new Blob(['[ti:草稿歌曲]\n[00:00]第一句\n[00:03]第二句']), 'demo.lrc');
  const key = randomUUID(); const saved = await request('/api/v1/music', { method: 'POST', body: music, bot: 'writer', key });
  assert.equal(saved.status, 201, JSON.stringify(saved.value)); const draft = saved.value;
  assert.equal(draft.state, 'draft'); assert.equal(draft.item.status, 'draft'); assert.equal(draft.batch.newItems.length, 1);
  assert.equal(draft.batch.updatedItems.length, 0); assert.equal(draft.batch.newItems[0].category, 'music');
  assert.equal((await request('/api/public/music')).value.items.length, 0);
  assert.equal((await request('/api/v1/artists', { bot: 'reader' })).value.items.length, 0);
  assert.equal((await request(draft.item.cover.url)).status, 401);
  assert.equal((await request(draft.item.cover.url, { bot: 'reader' })).status, 403);
  assert.equal((await request(draft.item.cover.url, { bot: 'writer' })).status, 200);
  assert.equal((await request(draft.item.cover.url, { bot: 'reviewer' })).status, 200, 'authorized review also covers the reused artist portrait');
  assert.deepEqual((await request('/api/v1/music', { method: 'POST', body: music, bot: 'writer', key })).value, draft);
  const sync = (item, bot = 'reviewer') => request('/api/v1/drafts/' + item.id + '/sync', { method: 'POST', bot, json: { version: item.version } });
  assert.equal((await sync(draft, 'writer')).status, 403);
  const published = await sync(draft); assert.equal(published.status, 200, JSON.stringify(published.value));
  assert.equal((await request('/api/public/music')).value.items[0].title, '草稿歌曲');
  assert.equal((await request(draft.item.cover.url)).status, 200);
  assert.equal(published.value.batch.newItems[0].url, base + '/music?id=' + draft.objectId);
  const firstEvents = (await request('/api/v1/events', { bot: 'notifier' })).value;
  assert.equal(firstEvents.items.length, 1); assert.equal(firstEvents.items[0].type, 'content.synced'); assert.ok(Number.isSafeInteger(firstEvents.items[0].id));
  assert.equal(firstEvents.items[0].batchId, draft.batchId);
  await sync(draft);
  assert.deepEqual((await request('/api/v1/events', { bot: 'notifier' })).value.items, firstEvents.items);
  assert.equal((await request('/api/v1/events/ack', { method: 'POST', bot: 'notifier', json: { through: firstEvents.nextCursor } })).status, 200);
  assert.equal((await request('/api/v1/events', { bot: 'notifier' })).value.items.length, 0);

  const reused = await request('/api/v1/music', { method: 'POST', bot: 'writer', key: randomUUID(), json: {
    fields: { title: '复用素材的新歌', note: '关联信息不能被计作新增歌曲', artistId: draft.item.artistId, producerId: draft.item.producerId, coverId: draft.item.cover.id }, files: { audio: [draft.item.audio.id] },
  } });
  assert.equal(reused.status, 201, JSON.stringify(reused.value)); assert.equal(reused.value.item.cover.id, draft.item.cover.id);
  assert.ok(reused.value.batch.materials.every((item) => item.reused)); assert.equal(reused.value.batch.newItems.length, 1);
  assert.equal((await request('/api/v1/batches/' + reused.value.batchId, { bot: 'writer' })).value.id, reused.value.batchId);
  assert.equal((await request('/api/v1/batches/' + reused.value.batchId, { bot: 'reader' })).status, 403);
  await sync(reused.value);

  const edit = await request('/api/admin/content/music/' + draft.objectId, { method: 'PUT', admin: true, key: randomUUID(), json: {
    fields: { version: draft.version, title: '修改后的歌曲', artistId: draft.item.artistId, producerId: draft.item.producerId, note: '未同步仍显示旧寄语', lyrics: '纯文本' }, files: {},
  } });
  assert.equal(edit.status, 200, JSON.stringify(edit.value)); assert.equal(edit.value.item.audio.id, draft.item.audio.id);
  assert.equal((await request('/api/public/music/' + draft.objectId)).value.item.title, '草稿歌曲');
  const updateBatch = (await request('/api/admin/batches/' + edit.value.item.batchId, { admin: true })).value;
  assert.equal(updateBatch.newItems.length, 0); assert.equal(updateBatch.updatedItems.length, 1);
  assert.equal((await sync(draft)).status, 200, 'a completed old sync is a stable replay and must not publish the newer pending draft');
  assert.equal((await request('/api/public/music/' + draft.objectId)).value.item.title, '草稿歌曲');
  assert.equal((await request('/api/admin/drafts/' + draft.id + '/sync', { method: 'POST', admin: true, json: { version: 999 } })).status, 409);
  const updated = await request('/api/admin/drafts/' + edit.value.item.draftId + '/sync', { method: 'POST', admin: true, json: { version: edit.value.item.version } });
  assert.equal(updated.status, 200); assert.equal((await request('/api/public/music/' + draft.objectId)).value.item.title, '修改后的歌曲');

  let settings = (await request('/api/admin/settings', { admin: true })).value.item;
  const oldTitle = settings.heroTitle;
  const settingsDraft = await request('/api/admin/settings', { method: 'PUT', admin: true, key: randomUUID(), json: { fields: { version: settings.version, patch: JSON.stringify({ heroTitle: '只在同步后显示的标题' }) }, files: {} } });
  assert.equal(settingsDraft.status, 200, JSON.stringify(settingsDraft.value));
  assert.equal((await request('/api/public/site')).value.item.heroTitle, oldTitle);
  await stop(); await start();
  settings = (await request('/api/admin/settings', { admin: true })).value.item;
  assert.equal(settings.heroTitle, '只在同步后显示的标题'); assert.equal(settings.status, 'draft');
  assert.equal((await request('/api/public/site')).value.item.heroTitle, oldTitle);
  assert.equal((await request('/api/admin/drafts/' + settings.draftId + '/sync', { method: 'POST', admin: true, json: { version: settings.version } })).status, 200);
  assert.equal((await request('/api/public/site')).value.item.heroTitle, settings.heroTitle);

  const identity = settings.characters[0].images[0].media;
  assert.ok(identity.previews.some((item) => item.width >= 1200));
  const preview = identity.previews.find((item) => item.width === 1200);
  const previewData = (await request(preview.url)).binary;
  assert.equal((await sharp(previewData).metadata()).width, 1200);
  assert.equal(sha256((await request(identity.url)).binary), sha256(picture));
  db = openDatabase(dbPath); db.prepare('UPDATE media SET preview_version = 1 WHERE id = ?').run(identity.id); db.prepare('DELETE FROM media_previews WHERE media_id = ?').run(identity.id);
  assert.equal(await regeneratePreviews(db), 1); db.close();
  assert.ok((await request('/api/public/site')).value.item.characters[0].images[0].media.srcset.includes('1200w'));

  const file = new FormData(); file.set('kind', 'audio'); file.set('file', new Blob([demoWave(2)]), 'background.wav');
  const fileResult = await request('/api/admin/files', { method: 'POST', admin: true, body: file, key: randomUUID() }); assert.equal(fileResult.status, 201);
  async function saveBg() {
    const initial = (await request('/api/admin/background', { admin: true })).value.item;
    const draft = await request('/api/admin/uploads/background', { method: 'POST', admin: true, key: randomUUID(), json: { fields: { version: initial.version }, files: { audio: [fileResult.value.item.id] } } });
    assert.equal(draft.status, 201, JSON.stringify(draft.value));
    return request('/api/admin/drafts/' + draft.value.id + '/sync', { method: 'POST', admin: true, json: { version: draft.value.version } });
  }
  assert.equal((await saveBg()).status, 200);
  assert.equal((await request('/api/admin/background', { method: 'DELETE', admin: true })).status, 200);
  assert.equal((await saveBg()).status, 200, 'background deletion does not prevent a new track');
  assert.equal((await request('/api/admin/logs/modifications?type=draft.sync', { admin: true })).value.items.filter((item) => item.result === 'success').every((item) => item.batch_id), true);
});

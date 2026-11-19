import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createApplication } from '../server/app.mjs';
import { setAdmin } from '../server/auth.mjs';
import { openDatabase, readConfig, root, sha256 } from '../server/core.mjs';
import { demoWave } from '../server/demo.mjs';

const demoPicture = await readFile(resolve(root, 'public/assets/portrait.webp'));
const wav = demoWave(6);
const password = randomBytes(24).toString('base64url');

async function fixture(t, seedDemo = false) {
  const directory = await mkdtemp(join(tmpdir(), 'moonlit-test-'));
  const dbPath = join(directory, 'site.sqlite');
  const definitions = {
    reader: ['catalog:read'],
    publisher: ['questions:review'],
    observer: ['events:read', 'events:ack'],
    uploader: ['music:write', 'games:write', 'questions:submit'],
  };
  const tokens = Object.fromEntries(Object.keys(definitions).map((id) => [id, randomBytes(32).toString('base64url')]));
  const bots = new Map(Object.entries(definitions).map(([id, scopes]) =>
    [id, { id, hash: sha256(tokens[id]), scopes: new Set(scopes) }]));
  const config = { ...readConfig({ envFile: false }), dbPath, seedDemo, bots, baseUrl: '', secureCookie: false, host: '127.0.0.1' };
  let server;
  let origin;
  t.after(async () => {
    if (server?.listening) await new Promise((done) => server.close(done));
    for (const file of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) await rm(file, { force: true });
    await rmdir(directory);
  });
  const db = openDatabase(dbPath);
  await setAdmin(db, 'keeper', password);
  db.close();
  async function start() {
    server = await createApplication(config);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  async function request(path, { method = 'GET', json, body, auth, headers = {} } = {}) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${tokens[auth]}` } : {}),
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
    const value = response.headers.get('content-type')?.startsWith('application/json') && method !== 'HEAD'
      ? await response.json() : null;
    return { response, status: response.status, value };
  }
  async function login() {
    const { status, value, response } = await request('/api/admin/login', { method: 'POST', json: { username: 'keeper', password } });
    assert.equal(status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; SameSite=Strict; Max-Age=28800/);
    assert.ok(value.csrf);
    return { Cookie: cookie.split(';')[0], 'X-CSRF-Token': value.csrf };
  }
  return {
    request, login, dbPath,
    origin: () => origin,
    async restart() {
      await new Promise((done) => server.close(done));
      await start();
    },
  };
}

async function pageQuestions(request, path) {
  const { response, status } = await request(path);
  assert.equal(status, 200);
  const html = await response.text();
  assert.match(html, /<script type="module" src="\/front.js"><\/script>/);
  assert.match(html, /<nav class="site-links"/);
  for (const slug of ['about', 'music', 'games', 'cats', 'questions']) assert.ok(html.includes('href="/' + slug + '"'));
  const json = /<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1];
  return JSON.parse(json).questions;
}

test('six direct routes, thumbnail metadata, Bot links and byte ranges', async (t) => {
  const { request, origin } = await fixture(t, true);
  for (const path of ['/', '/about', '/music', '/games', '/cats', '/questions']) await pageQuestions(request, path);
  assert.equal((await request('/not-a-page')).status, 404);
  assert.equal((await request('/.env')).status, 404);
  const music = (await request('/api/public/music')).value.items;
  assert.equal(music.length, 2);
  assert.ok(music.every((song) => !Object.hasOwn(song, 'lyrics') && !Object.hasOwn(song, 'audio') && song.cover.thumbnail));
  const demoId = music.find((song) => song.title === '潮汐尽头').id;
  const { item: song } = (await request(`/api/public/music/${demoId}`)).value;
  assert.match(song.lyrics, /\[00:17\.00\]/);
  const { items, nextOffset } = (await request('/api/v1/catalog/music?limit=1', { auth: 'reader' })).value;
  assert.equal(nextOffset, 1);
  assert.equal(items[0].url, origin() + music[0].url);
  assert.equal(items[0].audio.url, origin() + (await request(`/api/public/music/${music[0].id}`)).value.item.audio.url);
  assert.equal((await request(`/api/v1/catalog/music?artistId=${song.artistId}`, { auth: 'reader' })).value.items.length, 1);
  for (const category of ['games', 'cats']) {
    const found = (await request(`/api/v1/catalog/${category}`, { auth: 'reader' })).value.items;
    assert.ok(found.length >= 2);
    assert.ok(found[0].url.startsWith(origin()));
  }
  const thumb = (await request(song.cover.thumbnail)).response;
  assert.equal(thumb.headers.get('content-type'), 'image/webp');
  const { response: full } = await request(song.audio.url);
  const complete = Buffer.from(await full.arrayBuffer());
  assert.equal(complete.length, song.audio.size);
  for (const [range, start, end] of [['bytes=262140-262155', 262140, 262155], ['bytes=-24', complete.length - 24, complete.length - 1]]) {
    const { response, status } = await request(song.audio.url, { headers: { Range: range } });
    assert.equal(status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${complete.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), complete.subarray(start, end + 1));
  }
  const head = await request(song.audio.url, { method: 'HEAD', headers: { Range: 'bytes=0-15' } });
  assert.equal(head.status, 206);
  assert.equal(head.response.headers.get('content-length'), '16');
  assert.equal(await head.response.text(), '');
  assert.equal((await request(song.audio.url, { headers: { Range: 'bytes=0-1,5-7' } })).status, 416);
  assert.equal((await request(song.audio.url, { headers: { 'If-None-Match': full.headers.get('etag') } })).status, 304);
});

test('private drafts, public questions, cursor acknowledgments, limits and tombstones', async (t) => {
  const { request, login, origin } = await fixture(t);
  const auth = await login();
  assert.equal((await request('/api/admin/questions')).status, 401);
  assert.equal((await request('/api/v1/events')).status, 401);
  assert.equal((await request('/api/v1/events', { auth: 'reader' })).status, 403);
  assert.equal((await request('/api/admin/questions', { auth: 'publisher' })).status, 401);

  const post = (question, author, anonymous, key, headers = {}) => request('/api/public/questions', {
    method: 'POST', json: { question, author, anonymous },
    headers: { 'Idempotency-Key': key, ...headers },
  });
  assert.equal((await post('cross', '', false, randomUUID(), { Origin: 'https://elsewhere.invalid' })).status, 403);
  assert.equal((await post('x'.repeat(1201), '', false, randomUUID())).status, 400);
  const anonymousKey = randomUUID();
  const anonymous = () => post('</script><img onerror=alert(1)>', '隐藏名字', true, anonymousKey);
  const [{ status, value: first }, retried] = await Promise.all([anonymous(), anonymous()]);
  assert.equal(status, 201);
  assert.equal(first.state, 'pending');
  assert.deepEqual(retried.value, first);
  assert.equal((await post('another', '', true, anonymousKey)).status, 409);
  const second = (await post('有署名的问题', '夜色', false, randomUUID(), { Origin: origin() })).value;
  assert.equal((await request('/api/public/questions')).value.items.length, 0);

  const eventPage = (await request('/api/v1/events?limit=1', { auth: 'observer' })).value;
  assert.equal(eventPage.items[0].questionId, first.id);
  assert.equal(eventPage.items[0].author, '匿名');
  assert.equal(eventPage.hasMore, true);
  const next = (await request(`/api/v1/events?after=${eventPage.nextCursor}`, { auth: 'observer' })).value;
  assert.equal(next.items[0].questionId, second.id);
  const ack = (through) => request('/api/v1/events/ack', { method: 'POST', auth: 'observer', json: { through } });
  assert.equal((await ack(next.nextCursor)).value.acknowledgedThrough, next.nextCursor);
  assert.equal((await ack(eventPage.nextCursor)).value.acknowledgedThrough, next.nextCursor);
  assert.equal((await request('/api/v1/events', { auth: 'observer' })).value.items.length, 0);

  const draftPath = `/api/admin/questions/${second.id}/draft`;
  assert.equal((await request(draftPath, { method: 'PUT', json: { reply: '私有草稿' }, headers: { Cookie: auth.Cookie } })).status, 403);
  assert.equal((await request(draftPath, { method: 'PUT', json: { reply: '私有草稿' }, headers: auth })).status, 200);
  const pending = (await request('/api/v1/questions?state=pending', { auth: 'publisher' })).value.items;
  assert.equal(pending.find((item) => item.id === second.id).reply, '私有草稿');
  assert.equal((await pageQuestions(request, '/questions')).length, 0);
  assert.equal((await pageQuestions(request, '/')).length, 0);

  const publishPath = `/api/v1/questions/${first.id}/publish`;
  const publish = (reply = 'Bot 回复') => request(publishPath, { method: 'POST', auth: 'publisher', json: { reply } });
  assert.equal((await request(publishPath, { method: 'POST', auth: 'observer', json: { reply: '无权限' } })).status, 403);
  assert.equal((await publish(' ')).status, 400);
  const published = (await publish()).value.item;
  assert.equal(published.author, '匿名');
  assert.deepEqual((await publish()).value.item, published);
  assert.equal((await publish('不同回复')).status, 409);
  assert.equal((await request(`/api/admin/questions/${second.id}/publish`, { method: 'POST', json: {}, headers: auth })).value.item.reply, '私有草稿');
  const onHome = await pageQuestions(request, '/');
  const onQuestions = await pageQuestions(request, '/questions');
  assert.deepEqual(onHome, onQuestions);
  assert.equal(onHome.length, 2);
  assert.ok(onHome.some((item) => item.author === '夜色'));
  assert.ok(onHome.some((item) => item.question === '</script><img onerror=alert(1)>'));

  const remove = (id) => request(`/api/admin/questions/${id}`, { method: 'DELETE', headers: auth });
  assert.equal((await remove(first.id)).status, 200);
  assert.equal((await remove(first.id)).status, 200);
  assert.equal((await publish()).status, 410);
  assert.equal((await anonymous()).status, 410);
  const replay = (await request('/api/v1/events?after=0', { auth: 'observer' })).value.items[0];
  assert.equal(replay.id, eventPage.nextCursor);
  assert.equal(replay.state, 'deleted');
  assert.ok(!Object.hasOwn(replay, 'question'));
  for (const page of ['/', '/questions']) assert.deepEqual((await pageQuestions(request, page)).map((item) => item.id), [second.id]);

  const pendingId = (await post('待处理后删除', '', true, randomUUID())).value.id;
  assert.equal((await remove(pendingId)).status, 200);
  assert.equal((await post('第四封', '', true, randomUUID())).status, 201);
  assert.equal((await post('第五封', '', true, randomUUID())).status, 201);
  const capped = await post('第六封', '', true, randomUUID());
  assert.equal(capped.status, 429);
  assert.ok(Number(capped.response.headers.get('retry-after')) > 0);
  const botPost = await request('/api/v1/questions', {
    method: 'POST', auth: 'uploader', headers: { 'Idempotency-Key': randomUUID() }, json: { question: 'Bot 投递' },
  });
  assert.equal(botPost.value.state, 'pending');
});

test('atomic shared uploads and persisted files, questions, sessions and event cursors after restart', async (t) => {
  const f = await fixture(t);
  const { request, login } = f;
  const admin = await login();
  const syncSaved = async (value) => {
    const item = value.item;
    const result = await request('/api/admin/drafts/' + item.draftId + '/sync', { method: 'POST', json: { version: item.version }, headers: admin });
    assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.item;
  };
  const makeMusic = (artist = { artistName: '测试歌手' }, cover = 'artistImage') => {
    const body = new FormData();
    for (const [key, value] of Object.entries({ title: '验收音频', note: '完整歌曲', producer: '示例 P', ...artist })) body.append(key, value);
    body.append('audio', new Blob([wav], { type: 'audio/wav' }), '验收.wav');
    if (cover) body.append(cover, new Blob([demoPicture]), '歌手.webp');
    body.append('lyricsFile', new Blob(['[00:01.00]可用的时间轴歌词']), '验收.lrc');
    return body;
  };
  const key = randomUUID();
  const sendMusic = (body, idempotency = key) => request('/api/v1/music', {
    method: 'POST', auth: 'uploader', body, headers: { 'Idempotency-Key': idempotency },
  });
  assert.equal((await request('/api/v1/music', { method: 'POST', auth: 'reader', body: makeMusic() })).status, 403);
  const [upload, retried] = await Promise.all([sendMusic(makeMusic()), sendMusic(makeMusic())]);
  assert.equal(upload.status, 201, JSON.stringify(upload.value));
  const { item: first } = upload.value;
  assert.deepEqual(retried.value.item, first);
  assert.equal((await request('/api/public/music')).value.items.length, 0);
  await syncSaved(upload.value);
  assert.equal((await sendMusic(makeMusic({ artistName: '不同歌手' }))).status, 409);
  const existing = await sendMusic(makeMusic({ artistId: first.artistId }, null), randomUUID());
  assert.equal(existing.status, 201);
  assert.equal(existing.value.item.cover.id, first.cover.id);
  await syncSaved(existing.value);
  const separate = await sendMusic(makeMusic({ artistId: first.artistId }, 'cover'), randomUUID());
  assert.notEqual(separate.value.item.cover.id, first.cover.id);
  await syncSaved(separate.value);
  assert.equal((await request('/api/v1/artists', { auth: 'reader' })).value.items.length, 1);

  const count = () => {
    const db = openDatabase(f.dbPath);
    const n = db.prepare('SELECT count(*) AS n FROM media').get().n;
    db.close();
    return n;
  };
  const makeGame = (valid) => {
    const form = new FormData();
    for (const [key, value] of Object.entries({ title: '验收游戏', genre: '冒险', note: '寄语', description: '介绍' })) form.set(key, value);
    form.set('logo', new Blob([demoPicture]), 'logo.webp');
    form.append('images', new Blob([demoPicture]), '一.webp');
    form.append('images', new Blob([valid ? demoPicture : '<svg/>']), '二.webp');
    return form;
  };
  const game = (valid) => request('/api/v1/games', {
    method: 'POST', auth: 'uploader', body: makeGame(valid), headers: { 'Idempotency-Key': randomUUID() },
  });
  const before = count();
  assert.equal((await game(false)).status, 415);
  assert.equal(count(), before);
  assert.equal((await request('/api/public/games')).value.items.length, 0);
  const savedGame = await game(true);
  assert.equal(savedGame.value.item.images.length, 2);
  await syncSaved(savedGame.value);

  const cat = new FormData();
  cat.set('image', new Blob([demoPicture]), '猫.webp');
  const catKey = randomUUID();
  assert.equal((await request('/api/admin/uploads/cats', { method: 'POST', auth: 'uploader', body: cat,
    headers: { 'Idempotency-Key': catKey } })).status, 401);
  const { item: catItem } = (await request('/api/admin/uploads/cats', { method: 'POST', body: cat,
    headers: { ...admin, 'Idempotency-Key': catKey } })).value;
  await syncSaved({ item: catItem });
  const background = async (length) => {
    const form = new FormData();
    form.set('version', (await request('/api/admin/background', { headers: admin })).value.item.version);
    form.set('audio', new Blob([demoWave(length, 2)]), 'bg.wav');
    const saved = await request('/api/admin/uploads/background', { method: 'POST', body: form,
      headers: { ...admin, 'Idempotency-Key': randomUUID() } });
    assert.equal(saved.status, 201, JSON.stringify(saved.value));
    return (await syncSaved(saved.value)).audio;
  };
  const old = await background(2);
  const bg = await background(4);
  assert.notEqual(old.id, bg.id);
  const question = (await request('/api/public/questions', {
    method: 'POST', json: { question: '会在重启后保留吗？' }, headers: { 'Idempotency-Key': randomUUID() },
  })).value;
  const { item: published } = (await request(`/api/admin/questions/${question.id}/publish`,
    { method: 'POST', json: { reply: '会。' }, headers: admin })).value;
  const last = (await request('/api/v1/events', { auth: 'observer' })).value.nextCursor;
  await request('/api/v1/events/ack', { method: 'POST', auth: 'observer', json: { through: last } });

  await f.restart();
  assert.equal((await request('/api/admin/session', { headers: admin })).status, 200);
  assert.equal((await request('/api/v1/events', { auth: 'observer' })).value.acknowledgedThrough, last);
  assert.deepEqual(await pageQuestions(request, '/'), [published]);
  assert.deepEqual((await request('/api/public/background')).value.item, { ...bg, volume: .05 });
  assert.deepEqual(Buffer.from(await (await request(catItem.image.url)).response.arrayBuffer()), demoPicture);
  const audioPath = new URL(first.audio.url, f.origin()).pathname;
  assert.deepEqual(Buffer.from(await (await request(audioPath)).response.arrayBuffer()), wav);
  assert.equal((await sendMusic(makeMusic())).value.item.id, first.id);
  assert.equal((await request('/api/public/music')).value.items.length, 3);
});

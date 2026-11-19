import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { readConfig, sha256 } from '../server/core.mjs';
import { demoWave } from '../server/demo.mjs';

const directory = await mkdtemp(join(tmpdir(), 'moonlit-bot-demo-'));
const dbPath = join(directory, 'demo.sqlite');
const observer = randomBytes(32).toString('base64url');
const reviewer = randomBytes(32).toString('base64url');
const writer = randomBytes(32).toString('base64url');
const bots = new Map([
  ['demo-observer', { id: 'demo-observer', hash: sha256(observer), scopes: new Set(['catalog:read', 'events:read', 'events:ack']) }],
  ['demo-reviewer', { id: 'demo-reviewer', hash: sha256(reviewer), scopes: new Set(['questions:review', 'content:sync', 'batches:read']) }],
  ['demo-writer', { id: 'demo-writer', hash: sha256(writer), scopes: new Set(['music:write', 'batches:read']) }],
]);
let server;
try {
  server = await createApplication({ ...readConfig({ envFile: false }), dbPath, bots, seedDemo: false, baseUrl: '' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { token, payload, key, method = 'GET', body } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : body,
    });
    assert.ok(response.ok, `${method} ${path} → ${response.status} ${response.ok ? '' : await response.clone().text()}`);
    return response.json();
  }

  const formPayload = { author: '演示访客', question: '今晚的月亮是什么颜色？' };
  const formRequest = { method: 'POST', key: randomUUID(), payload: formPayload };
  const submitted = await request('/api/public/questions', formRequest);
  assert.equal(submitted.message, '已收到，等待回复');
  assert.deepEqual(await request('/api/public/questions', formRequest), submitted);
  assert.equal((await request('/api/public/questions')).items.length, 0);
  console.log('网页投稿接口 → 待处理，重复请求使用同一记录');

  const { items } = await request('/api/v1/events', { token: observer });
  assert.equal(items.length, 1);
  const [event] = items;
  assert.equal(event.questionId, submitted.id);
  assert.equal(event.state, 'pending');
  assert.equal((await request('/api/v1/events?after=0', { token: observer })).items[0].id, event.id);
  console.log(`Bot 拉取 → 收到事件 #${event.id}，重拉的事件 ID 一致`);

  const replyDraft = await request(`/api/v1/questions/${event.questionId}/draft`, { method: 'PUT', token: reviewer, key: randomUUID(), payload: { reply: '今晚是带一点雾紫的冷白色。' } });
  assert.equal((await request('/api/public/questions')).items.length, 0);
  const publish = `/api/v1/questions/${event.questionId}/sync`;
  const options = { method: 'POST', token: reviewer, payload: { version: replyDraft.item.version } };
  const { item } = await request(publish, options);
  assert.equal(item.state, 'published');
  assert.deepEqual((await request(publish, options)).item, item);
  await request('/api/v1/events/ack', { method: 'POST', token: observer, payload: { through: event.id } });
  assert.equal((await request('/api/v1/events', { token: observer })).items.length, 0);
  console.log('有审核权限的 Bot → 确认发布并重试，监听 Bot → 确认已处理事件');

  for (const path of ['/', '/questions']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    const html = await response.text();
    const pageData = JSON.parse(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.deepEqual(pageData.questions, [item]);
    console.log(`${path} → 页面数据包含同一封已发布回信`);
  }
  const music = new FormData(); music.set('title', '本批次的新曲'); music.set('artistName', '演示歌手'); music.set('producer', '演示 P 主'); music.set('note', '草稿保存后仍不会公开');
  music.set('audio', new Blob([demoWave(4)]), 'demo.wav');
  const saved = await request('/api/v1/music', { method: 'POST', token: writer, key: randomUUID(), body: music });
  assert.equal(saved.state, 'draft'); assert.equal((await request('/api/v1/catalog/music', { token: observer })).items.length, 0);
  const firstBatch = await request('/api/v1/batches/' + saved.batchId, { token: writer });
  assert.equal(firstBatch.newItems.length, 1); assert.equal(firstBatch.updatedItems.length, 0);
  console.log('保存批次 ' + firstBatch.id + ' → 新增音乐 1 项、更新 0 项，仍为私有草稿');
  const syncPath = '/api/v1/drafts/' + saved.id + '/sync';
  await request(syncPath, { method: 'POST', token: reviewer, payload: { version: saved.version } });
  const changed = await request('/api/v1/music', { method: 'POST', token: writer, key: randomUUID(), payload: {
    objectId: saved.objectId, fields: { version: saved.version, title: '本批次更新后的曲名', artistId: saved.item.artistId, producerId: saved.item.producerId, note: '更新单独列出' }, files: {},
  } });
  assert.equal(changed.batch.newItems.length, 0); assert.equal(changed.batch.updatedItems.length, 1);
  const synced = await request(syncPath, { method: 'POST', token: reviewer, payload: { version: changed.version } });
  assert.deepEqual(await request(syncPath, { method: 'POST', token: reviewer, payload: { version: changed.version } }), synced);
  const notices = await request('/api/v1/events', { token: observer });
  assert.equal(notices.items.length, 2); assert.ok(notices.items.every((event) => event.type === 'content.synced' && Number.isSafeInteger(event.id)));
  assert.equal(notices.items[0].newItems.length, 1); assert.equal(notices.items[1].updatedItems.length, 1);
  assert.ok(notices.items[1].updatedItems[0].url.startsWith(base + '/music?id='));
  await request('/api/v1/events/ack', { method: 'POST', token: observer, payload: { through: notices.nextCursor } });
  assert.equal((await request('/api/v1/events', { token: observer })).items.length, 0);
  console.log('同步内容通知 → 新增与更新分开，前台链接可分享；重复同步不重复通知，游标确认完成');
} finally {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  for (const file of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) await rm(file, { force: true });
  await rmdir(directory);
}

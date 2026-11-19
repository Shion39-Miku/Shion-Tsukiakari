import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import policy from '../desktop/policy.cjs';
import { readConfig } from '../server/core.mjs';
import { createApplication } from '../server/app.mjs';

test('desktop boundary blocks other localhost clients while preserving native authentication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hoshifuru-desktop-'));
  const desktopAccessToken = randomBytes(32).toString('hex');
  const server = await createApplication({ ...readConfig({ envFile: false }), dbPath: join(directory, 'check.sqlite'), host: '127.0.0.1', baseUrl: '', seedDemo: false, ipGeoEnabled: false, desktopAccessToken });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const value of [undefined, 'bad', randomBytes(32).toString('hex')]) {
      const response = await fetch(base + '/api/public/health', { headers: value ? { 'X-Hoshifuru-Desktop': value } : {} }); assert.equal(response.status, 403);
    }
    assert.equal((await fetch(base + '/api/public/health', { headers: { 'X-Hoshifuru-Desktop': desktopAccessToken } })).status, 200);
    assert.equal((await fetch(base + '/api/admin/drafts', { headers: { 'X-Hoshifuru-Desktop': desktopAccessToken } })).status, 401);
    assert.equal((await fetch(base + '/api/chat/session', { headers: { 'X-Hoshifuru-Desktop': desktopAccessToken } })).status, 401);
  } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(directory, { recursive: true, force: true }); }
});
test('desktop navigation and model settings reject privileged URLs and unsafe destinations', () => {
  const origin = 'http://127.0.0.1:4180';
  assert.equal(policy.localNavigation(origin + '/chat', origin), true);
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'http://127.0.0.1:4181/chat', 'http://user:pass@127.0.0.1:4180/chat', 'https://example.com/']) assert.equal(policy.localNavigation(url, origin), false);
  assert.equal(policy.externalLink('https://shion.wiki/music'), true);
  for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'http://example.com/', 'https://user:pass@example.com/', 'https://localhost/']) assert.equal(policy.externalLink(url), false);
  assert.deepEqual(policy.modelConfig({ apiBase: 'http://127.0.0.1:6198/v1/', model: 'astrbot', apiKey: '' }, { apiKey: 'prior' }), { apiBase: 'http://127.0.0.1:6198/v1', model: 'astrbot', apiKey: 'prior' });
  for (const apiBase of ['file:///private', 'http://external.example/v1', 'https://user:pass@example.com/', 'https://example.com/?key=secret']) assert.throws(() => policy.modelConfig({ apiBase, model: 'test', apiKey: 'test' }));
  assert.throws(() => policy.modelConfig({ apiBase: 'https://api.example/v1', model: 'test', apiKey: 'bad\r\nheader' }));
});

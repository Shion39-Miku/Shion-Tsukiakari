import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { openDatabase, root } from '../server/core.mjs';

const launcher = resolve(root, 'scripts/start-local.mjs');

function launch(directory, database, port, flags = ['--no-open'], environment = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', launcher, ...flags], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port), DATABASE_PATH: database, SEED_DEMO: 'false', BOT_TOKENS: '[]',
      HOST: '0.0.0.0', PUBLIC_BASE_URL: 'https://future.example', COOKIE_SECURE: 'true',
      ...environment,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exit = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) => done(code));
  });
  return { child, exit, output: () => output };
}

async function stop(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill();
  await process.exit;
}

async function temporaryFiles() {
  const directory = await mkdtemp(join(tmpdir(), 'moonlit-start-'));
  const database = join(directory, 'site.sqlite');
  const cleanup = async () => {
    for (const file of [database, `${database}-wal`, `${database}-shm`]) await rm(file, { force: true });
    await rmdir(directory);
  };
  return { directory, database, cleanup };
}

async function waitReady(process, url) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (process.child.exitCode !== null) throw new Error(process.output());
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(300) });
      if (response.ok) return response;
    } catch {
      // The process may still be opening its database.
    }
    await delay(30);
  }
  throw new Error(`本地服务未就绪。${process.output()}`);
}

test('one-click startup works outside the project directory and repeated launches reuse it', { timeout: 15000 }, async (t) => {
  const { directory, database, cleanup } = await temporaryFiles();
  let first;
  t.after(async () => {
    if (first) await stop(first);
    await cleanup();
  });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  first = launch(directory, database, port);
  const url = `http://127.0.0.1:${port}`;
  const response = await waitReady(first, url);
  const identity = response.headers.get('x-moonlit-instance');
  assert.match(identity, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(database));
  assert.deepEqual(await (await fetch(`${url}/api/public/questions`)).json(), { items: [] });

  const repeated = launch(directory, database, port);
  assert.equal(await repeated.exit, 0, repeated.output());
  assert.match(repeated.output(), /已复用正在运行的本地网站/);
  assert.equal(first.child.exitCode, null);
  assert.equal((await fetch(url)).headers.get('x-moonlit-instance'), identity);
  assert.match(first.output(), new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  assert.ok(!first.output().includes('https://future.example'));
});

test('the launcher reports an occupied port and keeps the other service available', { timeout: 10000 }, async (t) => {
  const { directory, database, cleanup } = await temporaryFiles();
  const other = createServer((_req, res) => res.end('another local service'));
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(async () => {
    await new Promise((done) => other.close(done));
    await cleanup();
  });
  const port = other.address().port;
  const process = launch(directory, database, port);
  assert.equal(await process.exit, 1);
  assert.match(process.output(), /端口已被其他网站或程序占用/);
  assert.equal(existsSync(database), false);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'another local service');
});

test('the same Windows entrypoint can initialize an administrator with a chosen password', { timeout: 10000 }, async (t) => {
  const { directory, database, cleanup } = await temporaryFiles();
  t.after(cleanup);
  const process = launch(directory, database, 4173, ['--admin'], {
    ADMIN_USERNAME: 'local_keeper',
    ADMIN_PASSWORD: randomBytes(24).toString('base64url'),
  });
  assert.equal(await process.exit, 0, process.output());
  const db = openDatabase(database);
  try {
    const row = db.prepare('SELECT username, salt, hash FROM admins').get();
    assert.equal(row.username, 'local_keeper');
    assert.ok(row.salt.length > 0 && row.hash.length > 0);
    assert.ok(!process.output().includes(row.hash));
  } finally {
    db.close();
  }
});

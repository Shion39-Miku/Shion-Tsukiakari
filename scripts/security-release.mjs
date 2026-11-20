import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileDigest, root, SecurityError, toolsDir } from './security-tools.mjs';

const assetFiles = new Set(['resources/app.asar', 'resources/default_app.asar', 'resources/elevate.exe', 'resources/backend/runtime/node.exe']);
const seeds = new Set(['resources/seed/moonlit.sqlite', 'resources/seed/website.sqlite']);
const demoTables = new Set(['schema_migrations', 'media', 'media_chunks', 'artists', 'songs', 'games', 'game_images', 'cats',
  'background_tracks', 'questions', 'app_flags', 'site_settings', 'media_previews', 'song_lyrics']);

function sevenZip(...args) {
  const installed = [process.env.ProgramFiles, process.env.ProgramW6432].filter(Boolean)
    .map(dir => join(dir, '7-Zip', '7z.exe')).find(existsSync);
  const result = spawnSync(installed || '7z', args, { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new SecurityError('无法读取 Windows 发布包。请确认已安装 7-Zip，并检查包的完整性。');
  return result.stdout;
}

function innerPaths(archive) {
  const listing = sevenZip('l', '-slt', archive).split(/\r?\n-{10,}\r?\n/).at(-1);
  const found = Array.from(listing.matchAll(/^Path = (.+)\r?$/gm), ([, path]) => path.replaceAll('\\', '/'));
  if (!found.length || found.some(path => !path || isAbsolute(path) || /(?:^|\/)\.\.(?:\/|$)|[:\0]/.test(path))) {
    throw new SecurityError('发布包成员路径不安全。');
  }
  return found;
}

function checkSeed(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new SecurityError('发布种子数据库完整性检查失败。');
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all();
    if (!tables.some(({ name }) => name === 'admins') || !tables.some(({ name }) => name === 'questions')) {
      throw new SecurityError('发布种子数据库的结构与项目不符。');
    }
    for (const { name } of tables) {
      if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw new SecurityError('发布种子数据库包含未审核的表。');
      if (!demoTables.has(name) && db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get()) {
        throw new SecurityError('发布种子中存在非演示记录。');
      }
    }
    const questions = db.prepare('SELECT author, state FROM questions').all();
    if (!questions.length || questions.some(q => !q.author?.startsWith('演示 · ') || q.state !== 'published')) {
      throw new SecurityError('发布种子包含未确认的提问记录。');
    }
  } finally { db.close(); }
}

function checkDatabaseHeaders(dir, payload) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new SecurityError('发布包含未审核的文件链接。');
    if (entry.isDirectory()) { checkDatabaseHeaders(path, payload); continue; }
    const file = openSync(path, 'r'), header = Buffer.alloc(16);
    try { readSync(file, header); } finally { closeSync(file); }
    if (header.toString() === 'SQLite format 3\0' && !seeds.has(relative(payload, path).replaceAll('\\', '/'))) {
      throw new SecurityError('发布包中存在额外的 SQLite 数据库。');
    }
  }
}

function inspectAsar(file, dir, scan, protectedPath) {
  const desktop = createRequire(join(root, 'desktop/package.json'));
  const builder = createRequire(desktop.resolve('electron-builder'));
  const builderLib = createRequire(builder.resolve('app-builder-lib'));
  const asar = builderLib('@electron/asar');
  for (const item of asar.listPackage(file)) {
    const path = item.replaceAll('\\', '/').replace(/^\//, '');
    const stat = asar.statFile(file, path, false);
    if (isAbsolute(path) || path.split('/').includes('..') || protectedPath(path) || stat.link || stat.unpacked) {
      throw new SecurityError('应用 ASAR 包含未审核的路径或文件链接。');
    }
  }
  asar.extractAll(file, dir);
  scan(['dir', dir]);
}

export function checkInstaller(file, { scan, protectedPath }) {
  const cache = realpathSync(toolsDir);
  const scratch = mkdtempSync(join(cache, 'release-'));
  try {
    sevenZip('e', '-y', '-bso0', '-bsp0', '-bse0', `-o${scratch}`, file, '$PLUGINSDIR\\app-64.7z');
    const archive = join(scratch, 'app-64.7z');
    for (const path of innerPaths(archive)) {
      if (seeds.has(path) || assetFiles.has(path) || path === 'Tsukiakari.exe') continue;
      const ownPath = path.replace(/^resources\/backend\/node_modules\/(sharp\/dist\/)?/, '');
      if (protectedPath(ownPath)) throw new SecurityError('安装包含环境配置、数据库、密钥或其他受保护路径。');
    }
    const payload = join(scratch, 'payload');
    sevenZip('x', '-y', '-bso0', '-bsp0', '-bse0', `-o${payload}`, archive, 'resources\\*');
    const resources = join(payload, 'resources');
    checkDatabaseHeaders(resources, payload);
    for (const seed of seeds) checkSeed(join(payload, seed));
    for (const name of ['initial-model.json', 'initial-astrbot.json']) {
      if (readFileSync(join(resources, name), 'utf8').trim() !== '{}') throw new SecurityError('发布包预装了连接配置。');
    }
    inspectAsar(join(resources, 'app.asar'), join(scratch, 'asar'), scan, protectedPath);
    scan(['dir', resources, '--max-target-megabytes=32']);
  } finally {
    const target = realpathSync(scratch);
    if (dirname(target) === cache && basename(target).startsWith('release-')) rmSync(target, { recursive: true, force: true, maxRetries: 4 });
  }
}

export async function checkRelease(checks) {
  const release = JSON.parse(readFileSync(join(root, 'artifacts/desktop-app.json'), 'utf8'));
  const artifacts = realpathSync(join(root, 'artifacts'));
  const folder = realpathSync(release.directory);
  if (dirname(folder) !== artifacts || !basename(folder).startsWith('Tsukiakari-') || !Array.isArray(release.files)) {
    throw new SecurityError('发布清单没有指向仓库的构建产物。');
  }
  const expected = new Set(['Setup', 'Portable'].map(kind => `Tsukiakari-${release.version}-${kind}.exe`));
  if (release.files.length !== expected.size) throw new SecurityError('缺少需要检查的安装包或免安装包。');
  for (const asset of release.files) {
    const file = resolve(asset.path);
    if (!expected.delete(basename(file)) || dirname(file) !== folder || !lstatSync(file).isFile() || await fileDigest(file) !== asset.sha256) {
      throw new SecurityError('发布文件路径或 SHA-256 校验失败。');
    }
    checkInstaller(file, checks);
  }
}

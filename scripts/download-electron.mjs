// The direct GitHub download host is unreachable on this network. Use the
// same official release asset through GitHub's API and verify npm's checksum.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { root } from '../server/core.mjs';
const require = createRequire(join(root, 'desktop/package.json'));
const directory = dirname(require.resolve('electron/package.json')), version = require('electron/package.json').version;
const name = `electron-v${version}-win32-x64.zip`, checksums = JSON.parse(await readFile(join(directory, 'checksums.json'), 'utf8'));
const expected = checksums[name]; if (!expected) throw new Error('Missing official Electron checksum');
const release = await (await fetch('https://api.github.com/repos/electron/electron/releases/tags/v' + version, { signal: AbortSignal.timeout(20000) })).json();
const asset = release.assets?.find((a) => a.name === name); if (!asset) throw new Error('Official release asset missing');
const cache = join(root, '.deployment'); await mkdir(cache, { recursive: true }); const zip = join(cache, name);
if (existsSync(zip) && createHash('sha256').update(await readFile(zip)).digest('hex') === expected) {
  await mkdir(join(directory, 'dist'), { recursive: true });
  const electronRequire = createRequire(join(directory, 'package.json'));
  const { extract } = electronRequire('@electron-internal/extract-zip'); await extract(zip, { dir: join(directory, 'dist') });
  await writeFile(join(directory, 'path.txt'), 'electron.exe'); console.log('已从校验通过的官方缓存安装 Electron。'); process.exit(0);
}
const downloadUrl = process.env.HOSHIFURU_ELECTRON_DOWNLOAD_URL || asset.url + '?download=1';
const response = await fetch(downloadUrl, { headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(240000) });
if (!response.ok || response.headers.get('content-type')?.includes('json')) throw new Error('Release download HTTP ' + response.status);
let bytes = 0, last = 0; const hash = createHash('sha256');
const stream = Readable.fromWeb(response.body); stream.on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; if (Date.now() - last > 10000) { console.log('下载 Electron：' + Math.round(bytes / asset.size * 100) + '%'); last = Date.now(); } });
await pipeline(stream, createWriteStream(zip));
if (bytes !== asset.size || hash.digest('hex') !== expected) throw new Error('Electron release checksum mismatch');
await mkdir(join(directory, 'dist'), { recursive: true });
const electronRequire = createRequire(join(directory, 'package.json'));
const { extract } = electronRequire('@electron-internal/extract-zip'); await extract(zip, { dir: join(directory, 'dist') });
await writeFile(join(directory, 'path.txt'), 'electron.exe'); console.log('官方 Electron 下载、SHA-256 校验与解压完成。');

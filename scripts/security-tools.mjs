import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const scannerVersion = '8.30.1';
const platforms = {
  win32: {
    archive: 'windows_x64.zip', executable: 'gitleaks.exe',
    archiveSha256: 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',
    binarySha256: '17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c',
  },
  linux: {
    archive: 'linux_x64.tar.gz', executable: 'gitleaks',
    archiveSha256: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
    binarySha256: '88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509',
  },
};
const platform = platforms[process.platform];
export const supportsScanner = Boolean(platform) && process.arch === 'x64';
export const scannerExecutable = platform?.executable || 'gitleaks';
export const scannerArchive = `gitleaks_${scannerVersion}_${platform?.archive}`;
export const scannerArchiveSha256 = platform?.archiveSha256;
export const toolsDir = join(root, '.security-tools');
export const scannerPath = join(toolsDir, scannerExecutable);

export class SecurityError extends Error {}

export function verifiedScanner(path = scannerPath) {
  if (!supportsScanner) throw new SecurityError('安全检查需要 Windows 或 Linux x64。');
  try {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (digest === platform.binarySha256) return path;
  } catch {}
  throw new SecurityError('缺少校验通过的 Gitleaks。请运行 pnpm security:setup。');
}

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

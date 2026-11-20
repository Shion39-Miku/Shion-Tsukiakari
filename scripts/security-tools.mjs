import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const scannerVersion = '8.30.1';
export const scannerArchive = `gitleaks_${scannerVersion}_windows_x64.zip`;
export const scannerArchiveSha256 = 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e';
const scannerSha256 = '17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c';
export const toolsDir = join(root, '.security-tools');
export const scannerPath = join(toolsDir, 'gitleaks.exe');

export class SecurityError extends Error {}

export function verifiedScanner(path = scannerPath) {
  try {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (digest === scannerSha256) return path;
  } catch {}
  throw new SecurityError('缺少校验通过的 Gitleaks。请运行 pnpm security:setup。');
}

export async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

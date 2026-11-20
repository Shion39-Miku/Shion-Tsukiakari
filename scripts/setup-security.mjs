import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { root, SecurityError, fileDigest, scannerArchive, scannerArchiveSha256, scannerPath, scannerVersion, toolsDir, verifiedScanner } from './security-tools.mjs';

const args = process.argv.slice(2);
const archiveOption = args.indexOf('--archive');
const archive = archiveOption < 0 ? null : args[archiveOption + 1];

function git(...args) {
  return spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' });
}

async function installScanner() {
  try { verifiedScanner(); return; } catch (error) { if (!(error instanceof SecurityError)) throw error; }
  mkdirSync(toolsDir, { recursive: true });
  const cache = realpathSync(toolsDir);
  const scratch = mkdtempSync(join(cache, 'download-'));
  try {
    const zip = archive ? resolve(archive) : join(scratch, scannerArchive);
    if (!archive) {
      const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${scannerVersion}/${scannerArchive}`,
        { signal: AbortSignal.timeout(360_000) });
      if (!response.ok) throw new SecurityError('无法下载已固定版本的 Gitleaks。可使用 --archive 安装已下载的官方压缩包。');
      writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
    }
    if (await fileDigest(zip) !== scannerArchiveSha256) throw new SecurityError('Gitleaks 压缩包的 SHA-256 校验失败。');
    const unpack = spawnSync('tar', ['-xf', zip, '-C', scratch, 'gitleaks.exe'], { windowsHide: true, stdio: 'ignore' });
    if (unpack.status !== 0) throw new SecurityError('无法解压 Gitleaks。需要 Windows 自带的 tar。');
    copyFileSync(verifiedScanner(join(scratch, 'gitleaks.exe')), scannerPath);
  } finally {
    const target = realpathSync(scratch);
    if (dirname(target) === cache && basename(target).startsWith('download-')) rmSync(target, { recursive: true, force: true });
  }
}

function enableHooks() {
  const path = git('config', '--get', 'core.hooksPath');
  if (![0, 1].includes(path.status)) throw new SecurityError('无法读取 Git 钩子设置。');
  const configured = path.stdout.trim();
  if (configured && configured !== '.githooks') {
    throw new SecurityError('已有其他 Git 钩子路径。保留现有钩子，合并后再启用仓库钩子。');
  }
  const previous = git('rev-parse', '--git-path', 'hooks');
  if (previous.status !== 0) throw new SecurityError('无法定位 Git 钩子目录。');
  const hooks = ['pre-commit', 'pre-merge-commit', 'pre-applypatch', 'commit-msg', 'applypatch-msg', 'pre-push'];
  if (!configured && hooks.some(name => existsSync(resolve(root, previous.stdout.trim(), name)))) {
    throw new SecurityError('已有本地钩子文件。保留原钩子，合并后再启用仓库钩子。');
  }
  for (const hook of hooks) chmodSync(join(root, '.githooks', hook), 0o755);
  if (git('config', '--local', 'core.hooksPath', '.githooks').status !== 0) throw new SecurityError('无法启用仓库钩子。');
}

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new SecurityError('此安装脚本使用 Windows x64 Gitleaks。');
  if (args.some((arg, index) => !['--ci', '--archive'].includes(arg) && (archiveOption < 0 || index !== archiveOption + 1))
    || (archiveOption >= 0 && (!archive || archive.startsWith('--')))) throw new SecurityError('用法为 pnpm security:setup [--archive 文件路径] [--ci]。');
  await installScanner();
  if (!args.includes('--ci')) enableHooks();
  console.log(`Gitleaks ${scannerVersion} 校验通过。${args.includes('--ci') ? '' : ' Git 钩子已启用。'}`);
} catch (error) {
  console.error(error instanceof SecurityError ? error.message : '安全工具安装未完成，请检查网络和本地文件权限。');
  process.exitCode = 1;
}

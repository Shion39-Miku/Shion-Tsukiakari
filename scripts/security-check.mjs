import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, SecurityError, toolsDir, verifiedScanner } from './security-tools.mjs';

const options = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
const oidPattern = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const safeEmail = /@(?:users\.noreply\.github\.com|noreply\.github\.com|example\.(?:com|org|net)|[a-z0-9.-]+\.invalid)$/i;
const unique = items => [...new Set(items.filter(Boolean))];
const pathId = path => createHash('sha256').update(path).digest('hex').slice(0, 12);

function git(args, input) {
  const result = spawnSync('git', args, { ...options, input });
  if (result.status !== 0) throw new SecurityError(`Git ${args[0]} 检查未完成。`);
  return result.stdout;
}

export function protectedPath(path) {
  const name = path.replaceAll('\\', '/').toLowerCase();
  if (/(^|\/)(?:\.deployment|\.security-tools|\.secrets|\.ssh|secrets|data|backups|artifacts|dist|logs|node_modules|tsukiakari-data|星降る夜に-data|hoshifuruyoruni)\//.test(name)) return true;
  if (/(^|\/)desktop\/\.(?:generated|cache)\//.test(name)) return true;
  if (/^android\/(?:.*\/)?(?:build|\.gradle)\/|^android\/local\.properties$/.test(name)) return true;
  if (/\.(?:apk|aab|apks|jks|keystore)$/.test(name)) return true;
  if (/(^|\/)(?:login data|web data|cookies)(?:-journal)?$|(^|\/)local state$/.test(name)) return true;
  if (/(^|\/)(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|(?:model|connection)-credentials\.json|\.envrc\.local)$/.test(name)) return true;
  if (name.endsWith('.env.example')) return false;
  return /(^|\/)\.env(?:\..*)?$|\.env$/.test(name)
    || /\.(?:sqlite3?|db3?)(?:-(?:wal|shm|journal))?$/.test(name)
    || /\.(?:pem|key|pfx|p12|log(?:\..*)?|har|trace|dmp|dump|bak|private\.json|(?:dump|sql)\.(?:gz|zst)|dump\.sql|exe|msi|asar|zip|7z|rar|tar(?:\..*)?|tgz|bundle)$|-(?:backup|dump)\.sql$/.test(name);
}

function checkPaths(paths) {
  const disallowed = unique(paths).filter(protectedPath);
  if (!disallowed.length) return;
  const ids = disallowed.slice(0, 15).map(pathId).join(', ');
  throw new SecurityError(`发现 ${disallowed.length} 个受保护路径。路径摘要 ${ids}。请检查 Git 索引或拟传输历史。`);
}

function printableLocation(path) {
  if (!path) return '输入内容';
  const name = path.replaceAll('\\', '/');
  if (/^(?:[a-z0-9_.-]{1,48}\/)*[a-z0-9_.-]{1,48}$/i.test(name) && !/[a-z0-9_-]{24,}/i.test(name)) return name;
  return '路径摘要 ' + pathId(name);
}

export function scan(args, input) {
  const scanner = verifiedScanner();
  const noExceptions = join(toolsDir, 'no-exceptions');
  if (existsSync(noExceptions)) throw new SecurityError('发现额外的 Gitleaks 忽略配置，已阻止继续操作。');
  const result = spawnSync(scanner, [...args, '--config', join(root, '.gitleaks.toml'), '--gitleaks-ignore-path', noExceptions,
    '--ignore-gitleaks-allow', '--no-banner', '--no-color', '--log-level=error', '--redact=100', '--exit-code=29',
    '--report-format=json', '--report-path=-'], { ...options, input });
  if (result.status === 0) return;
  if (result.status !== 29) throw new SecurityError('Gitleaks 检查未完成，已阻止继续操作。');
  // Keep the tool report in memory. Its matching text never reaches the terminal.
  const findings = JSON.parse(result.stdout);
  for (const item of findings.slice(0, 16)) {
    const rule = /^[a-z0-9._-]{1,64}$/i.test(item.RuleID) ? item.RuleID : 'secret';
    const line = Number.isInteger(item.StartLine) ? `:${item.StartLine}` : '';
    const commit = oidPattern.test(item.Commit) ? ` (${item.Commit.slice(0, 12)})` : '';
    console.error(`${rule} · ${printableLocation(item.File)}${line}${commit}`);
  }
  throw new SecurityError(`发现 ${findings.length} 个疑似凭证或敏感配置。请核对后重新扫描。`);
}

function checkIdentity(email) {
  if (!safeEmail.test(email ?? '')) throw new SecurityError('存在可能公开的 Git 邮箱。请核对作者、提交者或标签身份。');
}

function staged() {
  checkPaths(git(['ls-files', '-z']).split('\0'));
  for (const name of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    checkIdentity(/<([^<>]+)> \d+ [+-]\d{4}$/.exec(git(['var', name]).trim())?.[1]);
  }
  scan(['git', '--pre-commit', '--staged', root]);
}

function commitMetadata(revisions) {
  const rows = git(['log', '--format=%ae%x00%ce%x00%B%x00', ...revisions]).split('\0');
  const messages = [];
  for (let index = 0; index + 2 < rows.length; index += 3) {
    checkIdentity(rows[index].trim());
    checkIdentity(rows[index + 1].trim());
    messages.push(rows[index + 2]);
  }
  if (messages.length) scan(['stdin'], messages.join('\n\n'));
}

function checkHistory(revisions) {
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new SecurityError('当前是浅克隆，无法完整检查历史。');
  const walk = ['--full-history', '--root', '-m', ...revisions];
  checkPaths(git(['log', '--format=', '--name-only', '--no-renames', '-z', ...walk]).split('\0').map(path => path.trim()));
  scan(['git', '--log-opts=' + walk.join(' '), root]);
  commitMetadata(revisions);
}

function commitTarget(oid) {
  if (!oidPattern.test(oid)) throw new SecurityError('Git 对象 ID 无效。');
  let target = oid;
  while (git(['cat-file', '-t', target]).trim() === 'tag') {
    const [header, ...body] = git(['cat-file', 'tag', target]).split('\n\n');
    const tagger = /^tagger .*<([^<>]+)> /m.exec(header);
    if (tagger) checkIdentity(tagger[1]);
    if (body.length) scan(['stdin'], body.join('\n\n'));
    target = /^object ([a-f0-9]+)$/m.exec(header)?.[1];
    if (!oidPattern.test(target)) throw new SecurityError('标签对象无效。');
  }
  if (git(['cat-file', '-t', target]).trim() !== 'commit') throw new SecurityError('引用包含非提交对象，须单独审计后才能处理。');
  return target;
}

function history() {
  for (const oid of unique(git(['for-each-ref', '--format=%(objectname)', 'refs/tags']).trim().split(/\r?\n/))) commitTarget(oid);
  checkHistory(['--all', '--reflog']);
}

function push() {
  const tips = [];
  for (const row of readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const fields = row.trim().split(/\s+/);
    if (fields.length !== 4 || !oidPattern.test(fields[1]) || !oidPattern.test(fields[3])) throw new SecurityError('无法识别 Git pre-push 输入。');
    if (!/^0+$/.test(fields[1])) tips.push(commitTarget(fields[1]));
  }
  if (tips.length) checkHistory(unique(tips));
}

const commands = {
  staged,
  history,
  push,
  message: () => scan(['stdin'], git(['stripspace', '--strip-comments'], readFileSync(process.argv[3]))),
  release: async () => (await import('./security-release.mjs')).checkRelease({ scan, protectedPath }),
  android: async () => (await import('./security-android.mjs')).checkAndroid({ scan, protectedPath }, process.argv.length > 3 ? process.argv.slice(3) : undefined),
  'android-evidence': async () => (await import('./security-android.mjs')).checkAndroidEvidence({ scan }),
};

// Importing helpers must not run a scan.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (!Object.hasOwn(commands, command)) throw new SecurityError('用法为 pnpm security:check staged|history|release|android|android-evidence。');
    verifiedScanner();
    await commands[command]();
    console.log(`安全检查通过（${command}）。`);
  } catch (error) {
    console.error(error instanceof SecurityError ? error.message : '安全检查未完成，已阻止继续操作。');
    process.exitCode = 1;
  }
}

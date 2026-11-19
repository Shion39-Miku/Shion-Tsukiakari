import { spawn } from 'node:child_process';
import { constants, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function dependenciesReady() {
  try {
    require('busboy');
    require('sharp');
    return true;
  } catch {
    return false;
  }
}

function runNode(args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) done();
      else reject(new Error('命令执行失败，请查看上方提示后重试。'));
    });
  });
}

async function ensureDependencies() {
  if (dependenciesReady()) return;
  const nodeDirectory = dirname(process.execPath);
  const packageManagers = [
    ['../node_modules/pnpm/bin/pnpm.mjs', ['install', '--frozen-lockfile']],
    ['node_modules/pnpm/bin/pnpm.cjs', ['install', '--frozen-lockfile']],
    ['node_modules/npm/bin/npm-cli.js', ['install', '--no-package-lock', '--no-audit', '--no-fund']],
    ['../node_modules/npm/bin/npm-cli.js', ['install', '--no-package-lock', '--no-audit', '--no-fund']],
  ];
  const manager = packageManagers.find(([file]) => existsSync(resolve(nodeDirectory, file)));
  if (!manager) throw new Error('请先在项目目录运行 pnpm install --frozen-lockfile，然后重新启动。');
  console.log('首次启动，正在安装项目依赖…');
  await runNode([resolve(nodeDirectory, manager[0]), ...manager[1]]);
  if (!dependenciesReady()) throw new Error('依赖无法载入，请检查安装输出后重试。');
}

async function isRunning(url, identity) {
  let response;
  try {
    response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
  } catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('无法检查本机端口，请检查正在运行的程序后重试。', { cause: error });
  }
  if (response.ok && response.headers.get('x-moonlit-instance') === identity) return true;
  throw new Error('此端口已被其他网站或程序占用，请在 .env 中修改 PORT 后重试。');
}

function openBrowser(url, appMode = false) {
  if (process.platform !== 'win32') return;
  if (appMode) {
    const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
      .map((directory) => resolve(directory, 'Microsoft/Edge/Application/msedge.exe')).find(existsSync);
    if (edge) {
      const child = spawn(edge, ['--app=' + url], { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', () => openBrowser(url)); child.unref(); return;
    }
  }
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'start', '""', url], {
    stdio: 'ignore', windowsHide: true,
  });
  child.once('error', () => console.log('请将上方本地地址复制到浏览器打开。'));
  child.once('exit', (code) => {
    if (code) console.log('请将上方本地地址复制到浏览器打开。');
  });
  child.unref();
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 10) throw new Error('请使用 Node.js 24.10 或更新的 24.x 版本。');
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some((flag) => !['--no-open', '--admin', '--chat', '--app'].includes(flag))) {
    throw new Error('支持的启动选项为 --no-open、--admin、--chat 和 --app。');
  }
  process.chdir(root);
  process.env.PATH = `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`;
  try {
    copyFileSync(resolve(root, '.env.example'), resolve(root, '.env'), constants.COPYFILE_EXCL);
    console.log('已创建本地配置 .env。');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  const { readConfig, sha256 } = await import('../server/core.mjs');
  const settings = readConfig();
  if (flags.has('--admin')) {
    await ensureDependencies();
    await runNode([resolve(root, 'scripts/site.mjs'), 'admin']);
    return;
  }

  const url = new URL(`http://127.0.0.1:${settings.port}`).origin;
  const config = { ...settings, host: '127.0.0.1', baseUrl: url, secureCookie: false };
  const identity = sha256(`${root}\0${config.dbPath}`);
  let running = await isRunning(url, identity);
  if (!running) {
    await ensureDependencies();
    const { createApplication } = await import('../server/app.mjs');
    console.log('正在检查数据库与高清预览，首次启动可能需要几秒…');
    const server = await createApplication(config);
    try {
      await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          done();
        });
      });
    } catch (error) {
      await new Promise((done) => server.close(done));
      if (error.code !== 'EADDRINUSE' || !await isRunning(url, identity)) throw error;
      running = true;
    }
    if (!running) {
      process.once('SIGINT', () => server.close());
      process.once('SIGTERM', () => server.close());
      console.log('网站已在本机启动。保留此窗口，按 Ctrl+C 可停止网站。');
    }
  }
  if (running) console.log('已复用正在运行的本地网站。');
  console.log(`前台  ${url}/`);
  console.log(`后台  ${url}/admin/login`);
  console.log(`月明かり  ${url}/chat`);
  console.log('首次登录后台前，可在另一个终端运行 .\\启动网站.cmd --admin 初始化管理员。');
  if (!flags.has('--no-open')) openBrowser(flags.has('--chat') ? url + '/chat' : url, flags.has('--app'));
}

main().catch((error) => {
  console.error(`启动失败。${error.message}`);
  process.exitCode = 1;
});

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileDigest, root, SecurityError, toolsDir } from './security-tools.mjs';
import { androidChatOrigin } from './android-release-config.mjs';

function run(tool, args, cwd) {
  const result = spawnSync(tool, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new SecurityError('安卓包读取或签名校验失败，请检查 SDK 与安装包。');
  return result.stdout;
}

export async function checkAndroid({ scan, protectedPath }) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT, java = process.env.JAVA_HOME;
  if (!sdk || !java) throw new SecurityError('检查安卓包前请设置 ANDROID_HOME 与 JAVA_HOME。');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const jdk = name => join(java, 'bin', name + ext);
  const config = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');
  const version = config.match(/\bversionName '(\d+\.\d+\.\d+)'/)?.[1];
  const tools = config.match(/\bbuildToolsVersion '(\d+\.\d+\.\d+)'/)?.[1];
  if (!version || !tools) throw new SecurityError('安卓版本配置未知。');
  const buildTools = join(sdk, 'build-tools', tools);
  const artifacts = realpathSync(join(root, 'artifacts/android'));
  const toolsCache = realpathSync(toolsDir);
  for (const debug of [false, true]) {
    const folder = join(artifacts, version + (debug ? '-qa' : ''));
    const apk = join(folder, 'Tsukiakari-' + version + (debug ? '-QA' : '-Android') + '.apk');
    const manifest = JSON.parse(readFileSync(join(folder, 'android-build.json'), 'utf8'));
    const origin = androidChatOrigin(debug);
    if (realpathSync(folder) !== folder || !lstatSync(apk).isFile() || await fileDigest(apk) !== manifest.sha256 || manifest.chatOrigin !== origin) {
      throw new SecurityError('APK 路径或 SHA-256 与构建清单不符。');
    }
    run(jdk('java'), ['-jar', join(buildTools, 'lib/apksigner.jar'), 'verify', apk]);
    run(join(buildTools, 'zipalign' + ext), ['-c', '4', apk]);
    const xml = run(join(buildTools, 'aapt2' + ext), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]);
    if (!/allowBackup\([^)]*\)=false/.test(xml) || !/minSdkVersion\([^)]*\)=28/.test(xml)
        || !xml.includes('package="wiki.shion.tsukiakari' + (debug ? '.qa' : '') + '"')
        || !xml.includes('usesCleartextTraffic') || /usesCleartextTraffic\([^)]*\)=true/.test(xml) !== debug
        || /debuggable\([^)]*\)=true/.test(xml) !== debug) {
      throw new SecurityError('APK 备份、连接安全策略或包名与变体不符。');
    }
    const entries = run(jdk('jar'), ['--list', '--file', apk]).trim().split(/\r?\n/);
    const allowed = /^(?:AndroidManifest\.xml|classes\.dex|resources\.arsc|META-INF\/(?:TSUKIAKA\.(?:SF|RSA)|MANIFEST\.MF)|res\/[A-Za-z0-9_/-]+\.(?:xml|png|wav)|assets\/(?:web\/(?:assets\/(?:brand\/)?)?)?|assets\/web\/[a-z-]+\.(?:js|css|html)|assets\/web\/assets\/(?:moonlake\.webp|moonmark\.svg|message\.wav|farewell\.webp|brand\/tsukiakari-(?:32|64|192|512)\.png))$/;
    if (new Set(entries).size !== entries.length || !entries.includes('assets/web/chat.html')
        || entries.some(path => !allowed.test(path) || protectedPath(path))) {
      throw new SecurityError('APK 含有未审核的文件路径。');
    }
    const extracted = mkdtempSync(join(toolsCache, 'android-audit-'));
    try {
      run(jdk('jar'), ['--extract', '--file', apk], extracted);
      const code = readFileSync(join(extracted, 'classes.dex'));
      if (!code.includes(Buffer.from(origin)) || code.includes(Buffer.from('https://chat.example.org')) ||
          !debug && code.includes(Buffer.from('http://127.0.0.1:'))) throw new SecurityError('APK 内置聊天地址与发布策略不符。');
      scan(['dir', extracted]);
    } finally {
      const resolved = realpathSync(extracted);
      if (dirname(resolved) === toolsCache && basename(resolved).startsWith('android-audit-')) rmSync(resolved, { recursive: true, force: true });
    }
  }
}

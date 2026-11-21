import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileDigest, root, SecurityError, toolsDir } from './security-tools.mjs';
import { androidChatOrigin, androidConfig, androidVariant, releaseCertificate } from './android-release-config.mjs';

function run(tool, args, cwd) {
  const result = spawnSync(tool, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new SecurityError('安卓包读取或签名校验失败，请检查 SDK 与安装包。');
  return result.stdout;
}

export async function checkAndroid({ scan, protectedPath }, variants = ['release', 'qa']) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT, java = process.env.JAVA_HOME;
  if (!sdk || !java) throw new SecurityError('检查安卓包前请设置 ANDROID_HOME 与 JAVA_HOME。');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const jdk = name => join(java, 'bin', name + ext);
  const { version, versionCode, min, target, toolsVersion } = androidConfig;
  const revision = run('git', ['rev-parse', '--verify', 'HEAD'], root).trim();
  const buildTools = join(sdk, 'build-tools', toolsVersion);
  const aapt = join(buildTools, 'aapt2' + ext);
  const toolsCache = realpathSync(toolsDir);
  for (const kind of variants) {
    const variant = androidVariant(kind);
    const { debug, file, package: packageName } = variant;
    const folder = join(root, variant.folder);
    const apk = join(folder, file);
    const manifest = JSON.parse(readFileSync(join(folder, 'android-build.json'), 'utf8'));
    const origin = androidChatOrigin(debug);
    const sha256 = await fileDigest(apk);
    const expected = { file, kind, version, versionCode, revision, package: packageName, min, target, debug, chatOrigin: origin, sha256 };
    if (realpathSync(folder) !== folder || !lstatSync(apk).isFile() ||
        Object.keys(manifest).length !== Object.keys(expected).length + 1 ||
        Object.entries(expected).some(([name, value]) => manifest[name] !== value) ||
        readFileSync(apk + '.sha256', 'utf8') !== `${sha256}  ${file}\n`) {
      throw new SecurityError('APK 版本、提交或 SHA-256 与构建清单不符。');
    }
    scan(['stdin'], JSON.stringify(manifest));
    const signature = run(jdk('java'), ['-jar', join(buildTools, 'lib/apksigner.jar'), 'verify', '--verbose', '--print-certs', apk]);
    const signer = /^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})\s*$/m.exec(signature)?.[1];
    if (!/^Number of signers: 1\s*$/m.test(signature) || !signer || signer !== manifest.signerSha256 ||
        kind === 'release' && signer !== releaseCertificate()) throw new SecurityError('APK 签名证书与发布配置不符。');
    run(join(buildTools, 'zipalign' + ext), ['-c', '4', apk]);
    const badging = run(aapt, ['dump', 'badging', apk]);
    const xml = run(aapt, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]);
    if (!badging.startsWith(`package: name='${packageName}' versionCode='${versionCode}' versionName='${version}' `)
        || !new RegExp(`minSdkVersion\\([^)]*\\)=${min}\\b`).test(xml)
        || !new RegExp(`targetSdkVersion\\([^)]*\\)=${target}\\b`).test(xml)
        || !/allowBackup\([^)]*\)=false/.test(xml)
        || !new RegExp(`usesCleartextTraffic\\([^)]*\\)=${debug}\\b`).test(xml)
        || /debuggable\([^)]*\)=true/.test(xml) !== debug) {
      throw new SecurityError('APK 的包名、版本、备份或连接安全策略与构建配置不符。');
    }
    const entries = run(jdk('jar'), ['--list', '--file', apk]).trim().split(/\r?\n/);
    const allowed = /^(?:AndroidManifest\.xml|classes\.dex|resources\.arsc|META-INF\/(?:TSUKIAKA\.(?:SF|RSA)|MANIFEST\.MF)|res\/[A-Za-z0-9_/-]+\.(?:xml|png|wav)|assets\/(?:web\/(?:assets\/(?:brand\/)?)?)?|assets\/source-revision\.txt|assets\/web\/[a-z-]+\.(?:js|css|html)|assets\/web\/assets\/(?:moonlake\.webp|moonmark\.svg|message\.wav|farewell\.webp|brand\/tsukiakari-(?:32|64|192|512)\.png))$/;
    if (new Set(entries).size !== entries.length || !entries.includes('assets/web/chat.html')
        || entries.some(path => !allowed.test(path) || protectedPath(path))) {
      throw new SecurityError('APK 含有未审核的文件路径。');
    }
    const extracted = mkdtempSync(join(toolsCache, 'android-audit-'));
    try {
      run(jdk('jar'), ['--extract', '--file', apk], extracted);
      if (readFileSync(join(extracted, 'assets/source-revision.txt'), 'utf8') !== revision + '\n') {
        throw new SecurityError('APK 内部记录的提交与当前 Git 提交不符。');
      }
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

export function checkAndroidEvidence({ scan }) {
  const folder = join(root, 'artifacts/android/device-check');
  scan(['stdin'], readFileSync(join(folder, 'report.json')));
  const screenshots = join(folder, 'screens');
  const allowed = /^android-(?:login|login-ready|phone|phone-chat|contacts|tablet|farewell|shortcut)\.png$/;
  if (readdirSync(screenshots, { withFileTypes: true }).some(entry => !entry.isFile() || !allowed.test(entry.name))) {
    throw new SecurityError('模拟器报告包含未审核的截图路径。');
  }
  scan(['dir', screenshots]);
}

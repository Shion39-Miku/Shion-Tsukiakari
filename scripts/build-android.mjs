import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidChatOrigin, androidConfig, androidVariant, releaseCertificate } from './android-release-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'android/app/src/main');
const { namespace, version, versionCode, min, target, compile, toolsVersion } = androidConfig;
const flags = process.argv.slice(2).filter(arg => arg !== '--');
if (flags.length > 1 || flags.some(arg => !['--debug', '--ci'].includes(arg))) throw Error('用法为 pnpm android:build [--ci | --debug]。');
const { kind, folder, file, package: pkg, debug } = androidVariant(flags[0] === '--debug' ? 'qa' : flags[0] === '--ci' ? 'ci' : 'release');
const chatOrigin = androidChatOrigin(debug);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const revision = git(['rev-parse', '--verify', 'HEAD']);
if (kind === 'release' && git(['status', '--porcelain'])) throw Error('发布包须从干净的 Git 提交构建。');
const windows = process.platform === 'win32';
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const javaHome = process.env.JAVA_HOME;
if (!sdk || !javaHome) throw Error('请配置 ANDROID_HOME 和 JAVA_HOME，使用 Android SDK 35、Build Tools 35.0.0 与 JDK 17。');
const javaTool = name => join(javaHome, 'bin', name + (windows ? '.exe' : ''));
const buildTool = name => join(sdk, 'build-tools', toolsVersion, name + (windows ? '.exe' : ''));
const jar = join(sdk, 'platforms', 'android-' + compile, 'android.jar');
const buildTools = join(sdk, 'build-tools', toolsVersion);
if (![javaTool('javac'), buildTool('aapt2'), jar].every(existsSync)) throw Error('未找到固定版本的安卓 SDK 或 JDK。');

function run(tool, args, { env, quiet = false } = {}) {
  const result = spawnSync(tool, args, { cwd: root, windowsHide: true, env: env || process.env,
    encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.status !== 0) throw Error('安卓构建步骤失败 · ' + basename(tool));
  return result.stdout;
}

function files(root, suffix) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => join(entry.parentPath, entry.name));
}

const output = join(root, folder);
const keyAlias = 'tsukiakari-android-test';
const passwordVariable = 'TSUKIAKARI_ANDROID_SIGN_SECRET';

function signingConfig(build) {
  if (kind === 'release') {
    const signingDir = process.env.TSUKIAKARI_ANDROID_SIGNING_DIR ||
      (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Tsukiakari-Android-Test-Signing'));
    if (!signingDir) throw Error('请配置既有安卓发布签名目录。开发可使用 --ci。');
    const signer = join(signingDir, 'local-test.keystore'), passwordFile = join(signingDir, 'signing.private.json');
    if (![signer, passwordFile].every(existsSync)) throw Error('既有发布签名材料不完整，请恢复同一组文件。');
    const { value } = JSON.parse(readFileSync(passwordFile, 'utf8'));
    if (typeof value !== 'string' || !value) throw Error('安卓发布签名配置无效。');
    return { signer, env: { ...process.env, [passwordVariable]: value } };
  }
  const signer = join(build, 'test.keystore');
  const env = { ...process.env, [passwordVariable]: randomBytes(24).toString('base64url') };
  run(javaTool('keytool'), ['-genkeypair', '-alias', keyAlias, '-keystore', signer, '-storetype', 'PKCS12',
    '-keyalg', 'RSA', '-keysize', '2048', '-dname', 'CN=Tsukiakari ' + kind.toUpperCase(), '-validity', '365',
    '-storepass:env', passwordVariable], { env, quiet: true });
  return { signer, env };
}

const tempRoot = realpathSync(tmpdir());
const build = mkdtempSync(join(tempRoot, 'tsukiakari-android-'));
try {
  const { signer, env: signingEnv } = signingConfig(build);
  run(process.execPath, [join(root, 'scripts/prepare-android.mjs'), join(build, 'prepared')]);
  writeFileSync(join(build, 'prepared/assets/source-revision.txt'), revision + '\n');
  const resources = join(build, 'res'), generated = join(build, 'generated'), classes = join(build, 'classes'), dex = join(build, 'dex');
  for (const dir of [generated, classes, dex]) mkdirSync(dir);
  cpSync(join(source, 'res'), resources, { recursive: true });
  cpSync(join(build, 'prepared/res'), resources, { recursive: true });
  const androidJar = join(build, 'android.jar');
  copyFileSync(jar, androidJar);
  const java = join(build, 'java');
  cpSync(join(source, 'java'), java, { recursive: true });
  const manifest = join(build, 'AndroidManifest.xml');
  const content = readFileSync(join(source, 'AndroidManifest.xml'), 'utf8')
    .replace('<manifest ', '<manifest package="' + pkg + '" ')
    .replace(/android:name="\.(\w+)"/g, (_, cls) => 'android:name="' + namespace + '.' + cls + '"')
    .replace('android:usesCleartextTraffic="false"', debug ? 'android:usesCleartextTraffic="true" android:debuggable="true"' : 'android:usesCleartextTraffic="false"');
  writeFileSync(manifest, content);
  writeFileSync(join(java, 'BuildConfig.java'), `package ${namespace};\nfinal class BuildConfig { static final boolean DEBUG = ${debug}; static final String VERSION_NAME = "${version}"; static final String CHAT_ORIGIN = ${JSON.stringify(chatOrigin)}; }\n`);
  const zip = join(build, 'resources.zip'), apk = join(build, 'base.apk'), aligned = join(build, 'aligned.apk');
  run(buildTool('aapt2'), ['compile', '--dir', resources, '-o', zip]);
  run(buildTool('aapt2'), ['link', '-o', apk, '-I', androidJar, '--manifest', manifest, '--custom-package', namespace,
    '--java', generated, '--min-sdk-version', String(min), '--target-sdk-version', String(target), '--version-code', String(versionCode),
    '--version-name', version, zip]);
  run(javaTool('javac'), ['--release', '17', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes, ...files(java, '.java'), ...files(generated, '.java')]);
  run(javaTool('java'), ['-cp', join(buildTools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', String(min),
    '--output', dex, ...files(classes, '.class')]);
  // JAR normalizes archive names to forward slashes, including on Windows.
  run(javaTool('jar'), ['--update', '--file', apk, '-C', dex, 'classes.dex', '-C', join(build, 'prepared'), 'assets']);
  run(buildTool('zipalign'), ['-p', '-f', '4', apk, aligned]);
  const signed = join(build, file);
  const apksigner = [javaTool('java'), '-jar', join(buildTools, 'lib/apksigner.jar')];
  run(apksigner[0], [...apksigner.slice(1), 'sign', '--ks', signer, '--ks-key-alias', keyAlias,
    '--ks-pass', 'env:' + passwordVariable, '--v4-signing-enabled', 'false', '--out', signed, aligned], { env: signingEnv, quiet: true });
  const checked = run(apksigner[0], [...apksigner.slice(1), 'verify', '--verbose', '--print-certs', signed], { quiet: true });
  const signerSha256 = /^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})\s*$/m.exec(checked)?.[1];
  if (!signerSha256 || kind === 'release' && signerSha256 !== releaseCertificate()) throw Error('安卓签名证书与发布配置不符。');
  const sha256 = createHash('sha256').update(readFileSync(signed)).digest('hex');
  mkdirSync(output, { recursive: true });
  copyFileSync(signed, join(output, file));
  writeFileSync(join(output, file + '.sha256'), `${sha256}  ${file}\n`);
  writeFileSync(join(output, 'android-build.json'), JSON.stringify({ file, kind, revision, version, versionCode,
    package: pkg, min, target, debug, chatOrigin, signerSha256, sha256 }, null, 2) + '\n');
  console.log('APK 已签名 · ' + join(folder, file));
} finally {
  const target = realpathSync(resolve(build));
  if (dirname(target) === tempRoot && basename(target).startsWith('tsukiakari-android-')) rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

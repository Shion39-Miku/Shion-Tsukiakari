import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidChatOrigin } from './android-release-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'android/app/src/main');
const config = readFileSync(join(root, 'android/app/build.gradle'), 'utf8');
const read = (name, pattern) => config.match(new RegExp('\\b' + name + ' ' + pattern))?.[1];
const applicationId = read('applicationId', "'([^']+)'");
const namespace = read('namespace', "'([^']+)'");
const version = read('versionName', "'([^']+)'");
const versionCode = read('versionCode', '(\\d+)');
const min = read('minSdk', '(\\d+)'), target = read('targetSdk', '(\\d+)'), compile = read('compileSdk', '(\\d+)');
const toolsVersion = read('buildToolsVersion', "'([^']+)'");
const debug = process.argv.includes('--debug');
const chatOrigin = androidChatOrigin(debug);
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
}

function files(root, suffix) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(suffix))
    .map(entry => join(entry.parentPath, entry.name));
}

const output = join(root, 'artifacts', 'android', version + (debug ? '-qa' : ''));
const signingDir = join(process.env.LOCALAPPDATA || join(root, 'artifacts/android'), 'Tsukiakari-Android-Test-Signing');
const signer = join(signingDir, 'local-test.keystore'), passwordFile = join(signingDir, 'signing.private.json');
mkdirSync(output, { recursive: true });
mkdirSync(signingDir, { recursive: true });
if (existsSync(signer) !== existsSync(passwordFile)) throw Error('本地测试签名材料不完整，请恢复同一组文件后重试。');
let signingSecret;
if (existsSync(passwordFile)) signingSecret = JSON.parse(readFileSync(passwordFile, 'utf8')).value;
else signingSecret = randomBytes(24).toString('base64url');
const signingEnv = { ...process.env, TSUKIAKARI_ANDROID_SIGN_SECRET: signingSecret };
if (!existsSync(signer)) {
  run(javaTool('keytool'), ['-genkeypair', '-alias', 'tsukiakari-android-test', '-keystore', signer, '-storetype', 'PKCS12',
    '-keyalg', 'RSA', '-keysize', '3072', '-dname', 'CN=Tsukiakari Android Test', '-validity', '3650',
    '-storepass:env', 'TSUKIAKARI_ANDROID_SIGN_SECRET'], { env: signingEnv, quiet: true });
  writeFileSync(passwordFile, JSON.stringify({ value: signingSecret }), { mode: 0o600, flag: 'wx' });
}

const tempRoot = realpathSync(tmpdir());
const build = mkdtempSync(join(tempRoot, 'tsukiakari-android-'));
try {
  run(process.execPath, [join(root, 'scripts/prepare-android.mjs'), join(build, 'prepared')]);
  const resources = join(build, 'res'), generated = join(build, 'generated'), classes = join(build, 'classes'), dex = join(build, 'dex');
  for (const dir of [generated, classes, dex]) mkdirSync(dir);
  cpSync(join(source, 'res'), resources, { recursive: true });
  cpSync(join(build, 'prepared/res'), resources, { recursive: true });
  const androidJar = join(build, 'android.jar');
  copyFileSync(jar, androidJar);
  const java = join(build, 'java');
  cpSync(join(source, 'java'), java, { recursive: true });
  const manifest = join(build, 'AndroidManifest.xml');
  const pkg = applicationId + (debug ? '.qa' : '');
  const content = readFileSync(join(source, 'AndroidManifest.xml'), 'utf8')
    .replace('<manifest ', '<manifest package="' + pkg + '" ')
    .replace(/android:name="\.(\w+)"/g, (_, cls) => 'android:name="' + namespace + '.' + cls + '"')
    .replace('android:usesCleartextTraffic="false"', debug ? 'android:usesCleartextTraffic="true" android:debuggable="true"' : 'android:usesCleartextTraffic="false"');
  writeFileSync(manifest, content);
  writeFileSync(join(java, 'BuildConfig.java'), `package ${namespace};\nfinal class BuildConfig { static final boolean DEBUG = ${debug}; static final String VERSION_NAME = "${version}"; static final String CHAT_ORIGIN = ${JSON.stringify(chatOrigin)}; }\n`);
  const zip = join(build, 'resources.zip'), apk = join(build, 'base.apk'), aligned = join(build, 'aligned.apk');
  run(buildTool('aapt2'), ['compile', '--dir', resources, '-o', zip]);
  run(buildTool('aapt2'), ['link', '-o', apk, '-I', androidJar, '--manifest', manifest, '--custom-package', namespace,
    '--java', generated, '--min-sdk-version', min, '--target-sdk-version', target, '--version-code', versionCode,
    '--version-name', version, zip]);
  run(javaTool('javac'), ['--release', '17', '-encoding', 'UTF-8', '-classpath', androidJar, '-d', classes, ...files(java, '.java'), ...files(generated, '.java')]);
  run(javaTool('java'), ['-cp', join(buildTools, 'lib/d8.jar'), 'com.android.tools.r8.D8', '--lib', androidJar, '--min-api', min,
    '--output', dex, ...files(classes, '.class')]);
  // JAR normalizes archive names to forward slashes, including on Windows.
  run(javaTool('jar'), ['--update', '--file', apk, '-C', dex, 'classes.dex', '-C', join(build, 'prepared'), 'assets']);
  run(buildTool('zipalign'), ['-p', '-f', '4', apk, aligned]);
  const targetFile = join(output, 'Tsukiakari-' + version + (debug ? '-QA' : '-Android') + '.apk');
  const apksigner = [javaTool('java'), '-jar', join(buildTools, 'lib/apksigner.jar')];
  run(apksigner[0], [...apksigner.slice(1), 'sign', '--ks', signer, '--ks-key-alias', 'tsukiakari-android-test',
    '--ks-pass', 'env:TSUKIAKARI_ANDROID_SIGN_SECRET', '--out', targetFile, aligned], { env: signingEnv });
  run(apksigner[0], [...apksigner.slice(1), 'verify', '--verbose', targetFile]);
  const hash = createHash('sha256').update(readFileSync(targetFile)).digest('hex');
  writeFileSync(join(output, 'android-build.json'), JSON.stringify({ targetFile, version, package: pkg, min, target, debug, chatOrigin, sha256: hash }, null, 2));
  console.log('安卓测试包已签名并验证 · ' + targetFile);
} finally {
  const target = realpathSync(resolve(build));
  if (dirname(target) === tempRoot && basename(target).startsWith('tsukiakari-android-')) rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

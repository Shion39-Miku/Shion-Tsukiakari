import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const gradle = readFileSync(new URL('../android/app/build.gradle', import.meta.url), 'utf8');
const setting = (name, value) => {
  const result = gradle.match(new RegExp('\\b' + name + ' ' + value))?.[1];
  if (!result) throw Error('缺少安卓打包配置 · ' + name);
  return result;
};
const applicationId = setting('applicationId', "'([a-z.]+)'");
const version = setting('versionName', "'(\\d+\\.\\d+\\.\\d+)'");

export const androidConfig = Object.freeze({
  namespace: setting('namespace', "'([a-z.]+)'"),
  version,
  versionCode: Number(setting('versionCode', '(\\d+)')),
  min: Number(setting('minSdk', '(\\d+)')),
  target: Number(setting('targetSdk', '(\\d+)')),
  compile: Number(setting('compileSdk', '(\\d+)')),
  toolsVersion: setting('buildToolsVersion', "'(\\d+\\.\\d+\\.\\d+)'"),
});

export function releaseCertificate() {
  const fingerprint = readFileSync(new URL('../android/release-certificate.sha256', import.meta.url), 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw Error('安卓发布证书指纹无效。');
  return fingerprint;
}

export function androidVariant(kind) {
  if (!['release', 'ci', 'qa'].includes(kind)) throw Error('未知的安卓构建类型。');
  const suffix = kind === 'release' ? '' : '.' + kind;
  const label = kind === 'release' ? 'Android' : kind.toUpperCase();
  return { kind, package: applicationId + suffix, debug: kind === 'qa',
    folder: 'artifacts/android/' + version + suffix.replace('.', '-'),
    file: `Tsukiakari-${version}-${label}.apk` };
}

export function androidChatOrigin(debug) {
  if (debug) {
    const port = Number(process.env.TSUKIAKARI_ANDROID_QA_PORT || 4187);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('安卓联调端口无效。');
    return 'http://127.0.0.1:' + port;
  }
  const { origin } = JSON.parse(readFileSync(new URL('../deploy/chat-public.json', import.meta.url), 'utf8'));
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:' || url.port || isIP(url.hostname) ||
      !url.hostname.includes('.') || /(^|\.)(?:example\.(?:com|net|org)|example|localhost|local|test|invalid)$/.test(url.hostname)) {
    throw Error('安卓发布配置必须包含已确定的公开 HTTPS 源地址。');
  }
  return origin;
}

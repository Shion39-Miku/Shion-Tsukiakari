import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

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

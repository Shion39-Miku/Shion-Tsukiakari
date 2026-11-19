import { isIP } from 'node:net';
import { sha256 } from './core.mjs';

export function normalizeIP(value) {
  if (typeof value !== 'string') return '';
  value = value.trim().replace(/^\[([^\]]+)\](?::\d+)?$/, '$1');
  if (!isIP(value)) return '';
  if (isIP(value) === 4) return value;
  const canonical = new URL('http://[' + value + ']').hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f\d]+):([a-f\d]+)$/i.exec(canonical);
  if (mapped) return [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255, parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255].join('.');
  return canonical;
}
function numeric(ip) {
  ip = normalizeIP(ip);
  if (!ip) return null;
  if (isIP(ip) === 4) return { bits: 32, value: ip.split('.').reduce((n, p) => n * 256n + BigInt(p), 0n) };
  const [left, right] = ip.split('::');
  const start = left ? left.split(':') : []; const end = right ? right.split(':') : [];
  const parts = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill('0'), ...end];
  return { bits: 128, value: parts.reduce((n, p) => (n << 16n) + BigInt('0x' + p), 0n) };
}
export function inCIDR(ip, range) {
  const [network, prefix] = range.split('/'); const a = numeric(ip); const b = numeric(network);
  if (!a || !b || a.bits !== b.bits) return false;
  const bits = prefix === undefined ? b.bits : Number(prefix);
  if (prefix !== undefined && !/^\d+$/.test(prefix) || !Number.isInteger(bits) || bits < 0 || bits > b.bits) return false;
  const shift = BigInt(b.bits - bits); return (a.value >> shift) === (b.value >> shift);
}
export function validateProxies(ranges) {
  for (const range of ranges) {
    if (!range || range.split('/').length > 2 || !inCIDR(range.split('/')[0], range)) throw new Error('TRUSTED_PROXIES 含无效 IP 或 CIDR：' + range);
  }
  return ranges;
}
export function clientIP(req, trusted = []) {
  const peer = normalizeIP(req.socket.remoteAddress);
  const trust = (ip) => trusted.some((range) => inCIDR(ip, range));
  if (!peer || !trust(peer)) return peer;
  // Only X-Forwarded-For is supported. Walk from the actual peer toward the client;
  // stop at the first untrusted hop, so a spoofed leftmost value cannot win.
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header.length > 2048) return peer;
  const hops = header.split(',').map(normalizeIP);
  if (!hops.length || hops.length > 32 || hops.some((hop) => !hop)) return peer;
  let result = peer;
  for (let i = hops.length - 1; i >= 0 && trust(result); i--) result = hops[i];
  return result;
}
export function localIP(ip) {
  return ['0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '::/128', '::1/128', 'fc00::/7', 'fe80::/10'].some((range) => inCIDR(ip, range));
}
const unknown = () => ({ country: '', province: '', city: '', kind: 'unknown' });
export function locationLookup(db, config, fetcher = fetch) {
  const pending = new Map(); let daily = 0; let day = ''; let cooldown = 0;
  return async (ip) => {
    if (localIP(ip)) return { ...unknown(), kind: 'local' };
    if (!normalizeIP(ip) || config.ipGeoEnabled === false) return unknown();
    // Do not send documentation, multicast or reserved networks to a provider.
    if (['192.0.0.0/24', '192.0.2.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3', '2001:db8::/32', 'ff00::/8'].some((range) => inCIDR(ip, range))) return unknown();
    const key = sha256(ip); const time = Date.now();
    const cached = db.prepare('SELECT * FROM ip_locations WHERE ip_hash = ? AND expires_at > ?').get(key, time);
    if (cached) return { country: cached.country, province: cached.province, city: cached.city, kind: cached.kind };
    if (pending.has(key)) return pending.get(key);
    const today = new Date().toISOString().slice(0, 10); if (today !== day) { day = today; daily = 0; }
    if (cooldown > time || daily >= 900 || pending.size >= 4) return unknown();
    daily++;
    const work = (async () => {
      let result = unknown();
      try {
        const url = new URL(encodeURIComponent(ip), config.ipGeoEndpoint || 'https://ipwho.is/');
        url.search = 'fields=success,country,region,city&lang=zh-CN';
        const response = await fetcher(url, { signal: AbortSignal.timeout(config.ipGeoTimeoutMs || 1800), redirect: 'error' });
        if (response.status === 429) cooldown = time + 86400000;
        if (response.ok) {
          const text = await response.text();
          if (text.length < 8192) {
            const data = JSON.parse(text);
            const clean = (value) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) : '';
            if (data.success === true) {
              result = { country: clean(data.country), province: clean(data.region), city: clean(data.city), kind: 'estimated' };
              if (!result.country && !result.province && !result.city) result = unknown();
            }
          }
        }
      } catch { /* A provider outage must not reject a visit or invent a location. */ }
      db.prepare('INSERT INTO ip_locations VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET country=excluded.country, province=excluded.province, city=excluded.city, kind=excluded.kind, expires_at=excluded.expires_at')
        .run(key, result.country, result.province, result.city, result.kind, time + (result.kind === 'estimated' ? 7 * 86400000 : 300000));
      db.prepare('DELETE FROM ip_locations WHERE expires_at < ?').run(time);
      return result;
    })().finally(() => pending.delete(key));
    pending.set(key, work); return work;
  };
}

import { randomBytes } from 'node:crypto';
import { check, cleanText, consumeQuota, idPattern, newId, now, sha256, transaction } from './core.mjs';

const publicPaths = ['/', '/about', '/music', '/games', '/cats', '/questions', '/chat'];
const eventTypes = ['card.open', 'image.open', 'song.play', 'song.pause', 'song.stop', 'question.submit', 'social.open'];

// Summaries are written by the server. Never put submitted text, credentials, or headers here.
export function recordChange(db, actor, action, category, id, summary, topic = category, batchId = null) {
  batchId ||= db.prepare('SELECT batch_id FROM drafts WHERE category = ? AND object_id = ?').get(category, id || '')?.batch_id || null;
  db.prepare('INSERT INTO modification_logs (actor, action, category, object_id, result, summary, created_at, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(actor, action, category, id || '', 'success', summary, now(), batchId);
  if (topic) db.prepare('INSERT INTO site_changes (topic, created_at) VALUES (?, ?)').run(topic, now());
}

export function recordFailure(db, actor, action, category, id, code) {
  const batchId = db.prepare('SELECT batch_id FROM drafts WHERE id = ? OR (category = ? AND object_id = ?) LIMIT 1').get(id || '', category, id || '')?.batch_id || null;
  db.prepare('INSERT INTO modification_logs (actor, action, category, object_id, result, summary, created_at, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(actor, action, category, id || '', 'failed', '操作未保存：' + String(code).slice(0, 60), now(), batchId);
}

export function pruneLogs(db, days = 30, cap = 50000) {
  const cutoff = Date.now() - days * 86400000;
  transaction(db, () => {
    db.prepare('DELETE FROM visitor_visits WHERE entered_at < ?').run(cutoff);
    db.prepare('DELETE FROM modification_logs WHERE created_at < ?').run(new Date(cutoff).toISOString());
    db.prepare('DELETE FROM visitor_visits WHERE id IN (SELECT id FROM visitor_visits ORDER BY entered_at DESC LIMIT -1 OFFSET ?)').run(cap);
    db.prepare('DELETE FROM visitor_events WHERE id IN (SELECT id FROM visitor_events ORDER BY created_at DESC LIMIT -1 OFFSET ?)').run(cap);
    db.prepare('DELETE FROM modification_logs WHERE id IN (SELECT id FROM modification_logs ORDER BY id DESC LIMIT -1 OFFSET ?)').run(cap);
    db.prepare('DELETE FROM site_changes WHERE id < (SELECT coalesce(max(id), 0) - 1000 FROM site_changes)').run();
  });
}

function identity(req) {
  let token = /(?:^|;\s*)moonlit_visitor=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  const fresh = !token;
  token ||= randomBytes(24).toString('hex');
  return { visitor: sha256(token).slice(0, 16), cookie: fresh ? 'moonlit_visitor=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=15552000' : null };
}

function sourceOf(data, req) {
  const channel = cleanText(data.channel, '渠道', 60);
  if (channel) return { source: channel, basis: '渠道参数（访客提供，非身份认证）' };
  let ref;
  try { ref = new URL(cleanText(data.referrer, '来源', 1000) || req.headers.referer || ''); } catch { /* Unknown source. */ }
  if (ref && ref.host !== req.headers.host) {
    const host = ref.hostname.toLowerCase();
    const platforms = [['bilibili', 'Bilibili'], ['steam', 'Steam'], ['discord', 'Discord'], ['twitter', 'X'], ['x.com', 'X'], ['t.co', 'X']];
    return { source: platforms.find(([part]) => host.includes(part))?.[1] || host, basis: 'Referer 来源域名：' + host };
  }
  return { source: '直接访问／来源未知', basis: '未取得可识别的外部 Referer 或渠道参数' };
}

function clientOf(req) {
  const ua = String(req.headers['user-agent'] || '').slice(0, 500);
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器未知';
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '系统未知';
  return { browser, device: os + (/Mobile|Android|iPhone/i.test(ua) ? ' · 移动设备' : ' · 桌面设备') };
}

export async function trackActivity(db, req, data, lookup = async () => ({ country: '', province: '', city: '', kind: 'unknown' }), ip = req.socket.remoteAddress || '') {
  const { visitor, cookie } = identity(req);
  const segmentId = cleanText(data.segmentId, '访问片段 ID', 36, true);
  check(idPattern.test(segmentId), '访问片段 ID 无效。');
  consumeQuota(db, 'activity-ip:' + sha256(ip || 'unknown'), 300, 60000);
  consumeQuota(db, 'activity:' + visitor, 100, 60000);
  const location = data.type === 'page.enter' ? await lookup(ip) : null;
  const time = Date.now();
  const result = transaction(db, () => {
    if (data.type === 'page.enter') {
      check(publicPaths.includes(data.path) && publicPaths.includes(data.entryPath), '访问页面无效。');
      const known = db.prepare('SELECT v.id, v.visitor_id, v.path FROM visit_segments s JOIN visitor_visits v ON v.id = s.visit_id WHERE s.id = ?').get(segmentId);
      if (known) {
        check(known.visitor_id === visitor && known.path === data.path, '访问片段不匹配。', 403);
        return { visitId: known.id };
      }
      const previous = db.prepare('SELECT id FROM visitor_visits WHERE visitor_id = ? AND path = ? AND entered_at >= ? ORDER BY entered_at DESC LIMIT 1')
        .get(visitor, data.path, time - 30000);
      const id = previous?.id || newId();
      if (previous) db.prepare('UPDATE visitor_visits SET repeats = repeats + 1, last_seen = ? WHERE id = ?').run(time, id);
      else {
        const source = sourceOf(data, req);
        const client = clientOf(req);
        db.prepare('INSERT INTO visitor_visits (id,visitor_id,path,entry_path,source,source_basis,browser,device,entered_at,last_seen,repeats,country,province,city,location_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
          .run(id, visitor, data.path, data.entryPath, source.source, source.basis, client.browser, client.device, time, time, location.country, location.province, location.city, location.kind);
      }
      db.prepare('INSERT INTO visit_segments VALUES (?, ?, ?, 0, ?, 1)').run(segmentId, id, time, time);
      return { visitId: id };
    }
    const segment = db.prepare('SELECT s.*, v.visitor_id FROM visit_segments s JOIN visitor_visits v ON v.id = s.visit_id WHERE s.id = ?').get(segmentId);
    check(segment && segment.visitor_id === visitor, '此访问片段已过期，请重新进入页面。', 409, 'visit_expired');
    if (data.type === 'heartbeat') {
      check(Number.isSafeInteger(data.visibleMs) && data.visibleMs >= 0 && data.visibleMs <= 7 * 86400000, '停留时间无效。');
      const visible = Math.max(segment.visible_ms, Math.min(data.visibleMs, time - segment.started_at + 1000));
      const estimated = data.ended === true || data.hidden === true ? 0 : 1;
      db.prepare('UPDATE visit_segments SET visible_ms = ?, last_seen = ?, estimated = ? WHERE id = ?').run(visible, time, estimated, segmentId);
      db.prepare('UPDATE visitor_visits SET last_seen = ? WHERE id = ?').run(time, segment.visit_id);
      return { ok: true };
    }
    check(eventTypes.includes(data.type), '行为事件类型无效。');
    const eventId = cleanText(data.eventId, '事件 ID', 36, true);
    const target = cleanText(data.targetId, '内容 ID', 100);
    check(idPattern.test(eventId) && /^[a-zA-Z0-9_.:/-]{0,100}$/.test(target), '行为事件标识无效。');
    db.prepare('INSERT INTO visitor_events VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(eventId, segment.visit_id, data.type, target, time);
    return { ok: true };
  });
  return { result, cookie };
}

export function queryLogs(db, kind, params) {
  const page = Number(params.get('page') || 1);
  const size = Number(params.get('limit') || 30);
  check(Number.isInteger(page) && page > 0 && page <= 100000 && Number.isInteger(size) && size >= 1 && size <= 100, '分页参数无效。');
  const type = cleanText(params.get('type'), '事件类型', 60);
  const path = cleanText(params.get('path'), '页面', 60);
  const parseDate = (key, fallback) => {
    const text = params.get(key);
    if (!text) return fallback;
    const ms = Date.parse(text);
    check(Number.isFinite(ms), '筛选时间无效。');
    return ms;
  };
  const from = parseDate('from', 0);
  const to = parseDate('to', Date.now() + 86400000);
  if (kind === 'modifications') {
    const where = 'created_at >= ? AND created_at <= ?' + (type ? ' AND action = ?' : '') + (path ? ' AND category = ?' : '');
    const args = [new Date(from).toISOString(), new Date(to).toISOString(), ...(type ? [type] : []), ...(path ? [path] : [])];
    const total = db.prepare('SELECT count(*) AS n FROM modification_logs WHERE ' + where).get(...args).n;
    const items = db.prepare('SELECT * FROM modification_logs WHERE ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
    return { items, total, page, pages: Math.max(1, Math.ceil(total / size)) };
  }
  const source = `SELECT v.id, 'page.enter' AS type, '' AS target_id, v.*, v.entered_at AS created_at,
      coalesce((SELECT sum(s.visible_ms) FROM visit_segments s WHERE s.visit_id = v.id), 0) AS visible_ms,
      coalesce((SELECT max(s.estimated) FROM visit_segments s WHERE s.visit_id = v.id), 1) AS estimated
    FROM visitor_visits v
    UNION ALL SELECT e.id, e.type, e.target_id, v.*, e.created_at, 0 AS visible_ms, 0 AS estimated
    FROM visitor_events e JOIN visitor_visits v ON v.id = e.visit_id`;
  const where = 'created_at >= ? AND created_at <= ?' + (type ? ' AND type = ?' : '') + (path ? ' AND path = ?' : '');
  const args = [from, to, ...(type ? [type] : []), ...(path ? [path] : [])];
  const total = db.prepare('SELECT count(*) AS n FROM (' + source + ') WHERE ' + where).get(...args).n;
  const items = db.prepare('SELECT * FROM (' + source + ') WHERE ' + where + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(...args, size, (page - 1) * size);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / size)) };
}

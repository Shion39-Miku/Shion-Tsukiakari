import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { check, cleanText, idPattern, openDatabase, Problem, requestKey, root, sha256, transaction } from './core.mjs';
import { login, logout, requireAccount, requireAdmin, requireBot, requireScope } from './auth.mjs';
import { cleanupUpload, readJson, readUpload, regeneratePreviews, sendMedia } from './media.mjs';
import { migrateMediaMetadata } from './media-maintenance.mjs';
import { background, deleteBackground, deleteContent, getArtists, getContent, listContent } from './catalog.mjs';
import { ackEvents, deleteQuestion, getQuestions, listEvents, submitQuestion } from './questions.mjs';
import { seedDemo } from './demo.mjs';
import { copyFields, getSite, initializeSettings } from './settings.mjs';
import { pruneLogs, queryLogs, recordFailure, trackActivity } from './logs.mjs';
import { renderNavigation } from './navigation.mjs';
import { batchDetails, deleteDraftObject, draftDetails, editItem, listDrafts, materialLibrary, publicReleases, saveContentDraft, syncAllDrafts, syncDraft, uploadFile } from './drafts.mjs';
import { clientIP, locationLookup } from './location.mjs';
import { createChat } from './chat.mjs';
import { canReadChatFile } from './chat-access.mjs';
import { retainedAfter } from './chat-retention.mjs';
import { createSiteBridge } from './site-bridge.mjs';

const publicDir = resolve(root, 'public');
const publicPages = new Set(['/', '/about', '/music', '/games', '/cats', '/questions']);
const staticTypes = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml',
  webp: 'image/webp', png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg',wav:'audio/wav', webmanifest: 'application/manifest+json; charset=utf-8' };
const mutable = (req) => req.method !== 'GET' && req.method !== 'HEAD';
const uncacheable = 'no-store';

function json(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': uncacheable, ...headers });
  res.end(JSON.stringify(data));
}

function queryNumber(url, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  check(/^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= min && value <= max,
    `${name} 参数超出范围。`);
  return value;
}

function assertId(value) {
  check(idPattern.test(value), '记录 ID 无效。', 404, 'not_found');
  return value.toLowerCase();
}

function stateFrom(url) {
  const state = url.searchParams.get('state') || 'pending';
  check(state === 'pending' || state === 'published', 'state 仅支持 pending 或 published。');
  return state;
}

function requestOrigin(req, config) {
  const host = req.headers.host?.toLowerCase();
  const publicHost = config.baseUrl ? new URL(config.baseUrl).host.toLowerCase() : null;
  const port = req.socket.localPort;
  const allowedHosts = ['localhost', '127.0.0.1', '[::1]', config.host].map((name) =>
    port === 80 ? name : `${name}:${port}`);
  check(host && (host === publicHost || allowedHosts.includes(host)), '请求的主机名未配置。', 421, 'invalid_host');
  const origin = host === publicHost ? config.baseUrl : `http://${host}`;
  if (mutable(req)) {
    check((!req.headers.origin || req.headers.origin === origin) && req.headers['sec-fetch-site'] !== 'cross-site',
      '只接受同源请求。', 403, 'cross_origin');
  }
  return origin;
}

function renderShell(template, data, path) {
  const safe = JSON.stringify(data).replaceAll('<', '\\u003c');
  return template.replace('<!--PAGE_DATA-->', () => safe)
    .replace('<!--INITIAL_HEADER-->', () => renderNavigation(data.site, path));
}

async function staticFile(req, res, path) {
  const ext = path.split('.').at(-1);
  let data;
  try {
    data = await readFile(resolve(publicDir, `.${path}`));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') throw new Problem(404, 'not_found', '找不到文件。');
    throw error;
  }
  const etag = `"${sha256(data)}"`;
  const headers = { 'Content-Type': staticTypes[ext], 'Cache-Control': 'no-cache', ETag: etag };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': data.length }).end(req.method === 'HEAD' ? undefined : data);
}

export async function createApplication(config) {
  const [front, admin, chatTemplate] = await Promise.all([
    readFile(resolve(publicDir, 'index.html'), 'utf8'),
    readFile(resolve(publicDir, 'admin.html'), 'utf8'),
    readFile(resolve(publicDir, 'chat.html'), 'utf8'),
  ]);
  const db = openDatabase(config.dbPath);
  if (!config.disableChat) db.exec('PRAGMA secure_delete = ON');
  const lookupLocation = locationLookup(db, config);
  try {
    await initializeSettings(db, config);
    if (config.seedDemo) await seedDemo(db);
    migrateMediaMetadata(db);
    await regeneratePreviews(db);
    pruneLogs(db, config.logRetentionDays, config.logMaxRows);
  } catch (error) {
    db.close();
    throw error;
  }
  let uploads = 0;
  if(config.websiteUrl)config={...config,siteBridge:createSiteBridge({baseUrl:config.websiteUrl,eventToken:config.websiteEventToken,db,chatClock:config.chatClock})};
  const chat = config.disableChat ? {handle:async()=>false,close(){}} : createChat(db, config, json);
  let loginRequests = 0;
  const streams = new Set();
  let revision = db.prepare('SELECT coalesce(max(id), 0) AS id FROM site_changes').get().id;
  const notifyTimer = setInterval(() => {
    if (!streams.size) return;
    const changes = db.prepare('SELECT id, topic FROM site_changes WHERE id > ? ORDER BY id').all(revision);
    if (!changes.length) return;
    revision = changes.at(-1).id;
    const message = 'id: ' + revision + '\nevent: changes\ndata: ' + JSON.stringify({ revision, topics: [...new Set(changes.map((row) => row.topic))] }) + '\n\n';
    for (const res of streams) {
      if (res.writableLength > 65536) res.destroy();
      else res.write(message);
    }
  }, 250);
  notifyTimer.unref();
  const maintenanceTimer = setInterval(() => {
    pruneLogs(db, config.logRetentionDays, config.logMaxRows);
    for (const res of streams) res.write(': moonlight\n\n');
  }, 15000);
  maintenanceTimer.unref();
  const handleUpload = async (req, res, category, actor, base = '') => {
    const key = requestKey(req);
    check(uploads < 2, '有文件正在处理，请稍后用相同表单重试。', 503, 'upload_busy');
    uploads += 1;
    try {
      const payload = await readDraftPayload(req);
      const draft = await saveContentDraft(db, config, category, payload, actor, key, payload.objectId ? assertId(payload.objectId) : null);
      json(res, { ...draft, item: draft.item }, 201);
    } finally {
      uploads -= 1;
    }
  };
  const readDraftPayload = (req) => /^application\/json/i.test(req.headers['content-type'] || '') ? readJson(req, 128 * 1024) : readUpload(req);
  const adminQuestions = (state) => getQuestions(db, state).map((question) => ({ ...question, publishedReply: question.reply, ...editItem(db, 'questions', question.id, config) }));
  async function writeReply(req, id, action, actor) {
    const data = await readJson(req);
    let current = editItem(db, 'questions', id, config);
    const key = requestKey(req, false) || sha256(JSON.stringify([actor, id, current.version, data.reply ?? null]));
    if (action === 'draft') {
      const draft = await saveContentDraft(db, config, 'questions', { fields: { reply: data.reply, version: data.version ?? current.version }, files: {} }, actor, key, id);
      return { item: draft.item, draft };
    }
    if (Object.hasOwn(data, 'reply')) {
      if (current.state === 'published' && current.status !== 'draft') check(current.reply === data.reply, '这封来信已发布，回复与本次内容不同。', 409, 'already_published');
      if (!current.draftId || current.reply !== data.reply) {
        const saved = await saveContentDraft(db, config, 'questions', { fields: { reply: data.reply, version: data.version ?? current.version }, files: {} }, actor, key, id);
        current = saved.item;
      }
    }
    if (!current.draftId) {
      check(current.reply, '请先保存回复草稿。', 409, 'save_required');
      const saved = await saveContentDraft(db, config, 'questions', { fields: { reply: current.reply, version: current.version }, files: {} }, actor, key, id);
      current = saved.item;
    }
    const result = await syncDraft(db, config, current.draftId, data.version ?? current.version, actor);
    const { author, anonymous, question, reply, state, createdAt, publishedAt } = result.item;
    return { item: { id, author, anonymous, question, reply, state, createdAt, publishedAt }, draft: result };
  }

  const server = createServer({ requestTimeout: 900_000, headersTimeout: 15_000 }, async (req, res) => {
    if (config.desktopAccessToken) {
      const supplied = typeof req.headers['x-hoshifuru-desktop'] === 'string' ? Buffer.from(req.headers['x-hoshifuru-desktop']) : Buffer.alloc(0);
      const expected = Buffer.from(config.desktopAccessToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        req.resume(); json(res, { error: { code: 'desktop_only', message: '请从桌面应用访问。' } }, 403); return;
      }
    }
    res.setHeader('X-Moonlit-Instance', sha256(`${root}\0${config.dbPath}`));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let mutation;
    const mutate = async (actor, action, category, id, work) => {
      mutation = { actor, action, category, id };
      return await work();
    };
    try {
      const origin = requestOrigin(req, config);
      const url = new URL(req.url, origin);
      const path = url.pathname;
      const method = req.method;
      if(config.serviceMode==='chat')req.chatAdminCookieName='hoshifuru_admin_session';
      const ip = clientIP(req, config.trustedProxies || []) || 'unknown';
      const chatMedia=/^\/(?:chat-media|media)\/([0-9a-f-]{36})(?:\/(?:thumb|preview\/\d+))?$/.exec(path);
      const localChatMedia=chatMedia && (path.startsWith('/chat-media/')||db.prepare("SELECT 1 FROM staged_files WHERE media_id=? AND actor LIKE 'chat:%'").get(chatMedia[1]));
      if(config.siteBridge && !localChatMedia && await config.siteBridge.handle(req,res,url))return;
      if (path === '/api/public/updates' && method === 'GET') {
        check(streams.size < 64, '实时连接较多，请稍后重试。', 503, 'stream_busy');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        res.write('retry: 1000\nevent: ready\ndata: ' + JSON.stringify({ revision: db.prepare('SELECT coalesce(max(id), 0) AS id FROM site_changes').get().id }) + '\n\n');
        streams.add(res);
        res.once('close', () => streams.delete(res));
        return;
      }
      if (path === '/api/public/site' && method === 'GET') return json(res, { item: getSite(db, config) });
      if (path === '/api/public/health' && method === 'GET') { db.prepare('SELECT 1').get(); return json(res, { ok: true }); }
      if (path === '/api/public/releases' && method === 'GET') return json(res, { items: publicReleases(db) });
      if (path === '/api/public/activity' && method === 'POST') {
        const { result, cookie } = await trackActivity(db, req, await readJson(req, 4096), lookupLocation, ip);
        return json(res, result, 200, cookie ? { 'Set-Cookie': cookie } : {});
      }
      if (!mutable(req)) {
        if (path === '/app' || path === '/app/') { res.writeHead(302, { Location: '/chat', 'Cache-Control': 'no-store' }).end(); return; }
        if (['/chat', '/chat/', '/chat/manage'].includes(path)) {
          const page = renderShell(chatTemplate, { site: getSite(db, config), background: background(db) }, path);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': uncacheable });
          res.end(method === 'HEAD' ? undefined : page); return;
        }
        if (path === '/chat.webmanifest') return await staticFile(req, res, path);
        const media = /^\/(?:chat-media|media)\/([^/]+)(?:\/(thumb)|\/preview\/(\d+))?$/.exec(path);
        if (media) {
          const id = assertId(media[1]);
          const meta = db.prepare('SELECT published FROM media WHERE id = ?').get(id);
          check(meta, '没有找到媒体。', 404, 'not_found');
          if (path.startsWith('/chat-media/')) {
            const account = requireAccount(db, req);
            check(canReadChatFile(db, account.key, id, retainedAfter(config.chatClock)), '无权读取此聊天文件。', 403, 'private_media');
            return await sendMedia(db, req, res, id, media[3] ? Number(media[3]) : Boolean(media[2]), true);
          }
          if (!meta.published) {
            if (req.headers.authorization) {
              const bot = requireBot(config.bots, req);
              const owned = db.prepare('SELECT 1 FROM staged_files WHERE media_id = ? AND actor = ?').get(id, 'bot:' + bot.id);
              const reviewable = bot.scopes.has('content:sync') && (db.prepare("SELECT 1 FROM drafts WHERE category IN ('music', 'games') AND document LIKE ?").get('%' + id + '%')
                || db.prepare("SELECT 1 FROM drafts d JOIN artists a ON a.id = json_extract(d.document, '$.fields.artistId') WHERE d.category = 'music' AND a.image_id = ?").get(id));
              check(owned && (bot.scopes.has('music:write') || bot.scopes.has('games:write') || bot.scopes.has('content:sync')) || reviewable, '此媒体尚未同步。', 403, 'private_media');
            } else {
              const account = requireAccount(db, req);
              const staged = db.prepare('SELECT actor FROM staged_files WHERE media_id=?').get(id);
              check(!config.disableChat||!staged?.actor.startsWith('chat:'),'聊天媒体仅由软件后端提供。',403,'private_media');
              if (account.role !== 'admin' || staged?.actor.startsWith('chat:')) {
                const businessReview = account.role === 'admin' && db.prepare("SELECT 1 FROM drafts WHERE state!='deleted' AND document LIKE ? LIMIT 1").get('%' + id + '%');
                check(canReadChatFile(db, account.key, id, retainedAfter(config.chatClock)) || businessReview, '此文件不属于当前会话。', 403, 'private_media');
              }
            }
          }
          return await sendMedia(db, req, res, id, media[3] ? Number(media[3]) : Boolean(media[2]));
        }
        if (/^\/(?:[a-z][\w-]*\.(?:js|css)|assets\/(?:brand\/)?[a-z0-9][\w.-]*\.(?:svg|webp|png|jpe?g|wav))$/i.test(path)) {
          return await staticFile(req, res, path);
        }
        if (publicPages.has(path) || path === '/admin' || path === '/admin/login') {
          const isAdmin = path.startsWith('/admin');
          const page = renderShell(isAdmin ? admin : front, {
            site: getSite(db, config),
            ...(!isAdmin ? { background: background(db) } : {}),
            ...(path === '/' || path === '/questions' ? { questions: getQuestions(db, 'published') } : {}),
          }, path);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': uncacheable });
          res.end(method === 'HEAD' ? undefined : page);
          return;
        }
      }

      if (path === '/api/public/questions') {
        if (method === 'GET') return json(res, { items: getQuestions(db, 'published') });
        if (method === 'POST') {
          const item = submitQuestion(db, await readJson(req), `visitor:${sha256(ip)}`, requestKey(req, false), true);
          return json(res, item, 201);
        }
      }
      if (path === '/api/public/background' && method === 'GET') return json(res, { item: background(db) });
      const publicContent = /^\/api\/public\/(music|games|cats)(?:\/([^/]+))?$/.exec(path);
      if (publicContent && method === 'GET') {
        const [, category, id] = publicContent;
        return json(res, id ? { item: getContent(db, category, assertId(id)) } : { items: listContent(db, category) });
      }

      if (path.startsWith('/api/chat/') || path.startsWith('/api/admin/accounts')) {check(!config.disableChat,'网站后端不提供聊天接口。',404,'not_found');return await chat.handle(req, res, url, ip);}

      if (path.startsWith('/api/admin/')) {
        if (path === '/api/admin/login' && method === 'POST') {
          check(loginRequests < 4, '登录请求较多，请稍后再试。', 503, 'login_busy');
          loginRequests += 1;
          try {
            const { data, cookie } = await login(db, await readJson(req, 4096), ip, config.secureCookie);
            return json(res, data, 200, { 'Set-Cookie': cookie });
          } finally {
            loginRequests -= 1;
          }
        }
        const session = requireAdmin(db, req);
        const actor = 'admin:' + session.username;
        if (path === '/api/admin/session' && method === 'GET') return json(res, { username: session.username, csrf: session.csrf });
        if (path === '/api/admin/logout' && method === 'POST') {
          return json(res, { ok: true }, 200, { 'Set-Cookie': logout(db, session, config.secureCookie) });
        }
        if (path === '/api/admin/artists' && method === 'GET') return json(res, { items: getArtists(db, '', true) });
        if (path === '/api/admin/settings' && method === 'GET') return json(res, { item: editItem(db, 'settings', 'site', config), published: getSite(db, config), fields: copyFields });
        if (path === '/api/admin/settings' && method === 'PUT') {
          const draft = await mutate(actor, 'draft.save', 'settings', 'site', async () => {
          check(uploads < 2, '有文件正在处理，请稍后重试。', 503, 'upload_busy');
          uploads++;
          try { return await saveContentDraft(db, config, 'settings', await readDraftPayload(req), actor, requestKey(req), 'site'); } finally { uploads--; }
          });
          return json(res, { ...draft, item: draft.item });
        }
        if (path === '/api/admin/files' && method === 'POST') {
          check(uploads < 2, '有文件正在处理，请稍后重试。', 503, 'upload_busy'); uploads++;
          try { return json(res, { item: await mutate(actor, 'file.upload', 'media', '', async () => uploadFile(db, await readUpload(req), actor, requestKey(req))) }, 201); } finally { uploads--; }
        }
        if (path === '/api/admin/materials' && method === 'GET') return json(res, { items: materialLibrary(db, url.searchParams.get('kind'), url.searchParams.get('q') || '') });
        if (path === '/api/admin/drafts' && method === 'GET') return json(res, { items: listDrafts(db, url.searchParams.get('category'), config) });
        if (path === '/api/admin/drafts/sync-all' && method === 'POST') return json(res, await mutate(actor, 'draft.sync', 'all', '', async () => syncAllDrafts(db, config, (await readJson(req, 32768)).items, actor)));
        const draftRoute = /^\/api\/admin\/drafts\/([^/]+)(\/sync)?$/.exec(path);
        if (draftRoute && method === 'GET' && !draftRoute[2]) return json(res, draftDetails(db, assertId(draftRoute[1]), config));
        if (draftRoute && method === 'POST' && draftRoute[2]) return json(res, await mutate(actor, 'draft.sync', 'drafts', draftRoute[1], async () => syncDraft(db, config, assertId(draftRoute[1]), (await readJson(req)).version, actor)));
        const batchRoute = /^\/api\/admin\/batches\/([^/]+)$/.exec(path);
        if (batchRoute && method === 'GET') return json(res, batchDetails(db, assertId(batchRoute[1])));
        if (path === '/api/admin/background' && method === 'GET') return json(res, { item: editItem(db, 'background', 'background', config) });
        const logs = /^\/api\/admin\/logs\/(visitors|modifications)$/.exec(path);
        if (logs && method === 'GET') return json(res, queryLogs(db, logs[1], url.searchParams));
        if (path === '/api/admin/background' && method === 'DELETE') return json(res, { item: await mutate(actor, 'delete', 'background', '', () => transaction(db, () => { const result = deleteBackground(db, actor); deleteDraftObject(db, 'background', 'background', actor); return result; })) });
        const content = /^\/api\/admin\/content\/(music|games|cats)(?:\/([^/]+))?$/.exec(path);
        if (content) {
          const [, category, rawId] = content;
          const id = rawId ? assertId(rawId) : null;
          if (method === 'GET') {
            if (id) return json(res, { item: editItem(db, category, id, config) });
            const map = new Map(listContent(db, category).map((item) => [item.id, { ...item, status: 'synced' }]));
            listDrafts(db, category, config).forEach((item) => map.set(item.id, item));
            return json(res, { items: [...map.values()] });
          }
          if (id && method === 'PUT') return json(res, { item: await mutate(actor, 'edit', category, id, async () => {
            check(uploads < 2, '有文件正在处理，请稍后重试。', 503, 'upload_busy');
            uploads++;
            try { const draft = await saveContentDraft(db, config, category, await readDraftPayload(req), actor, requestKey(req), id); return draft.item; } finally { uploads--; }
          }) });
          if (id && method === 'DELETE') return json(res, { item: await mutate(actor, 'delete', category, id, () => transaction(db, () => { const result = deleteContent(db, category, id, actor); deleteDraftObject(db, category, id, actor); return result; })) });
        }
        if (path === '/api/admin/questions' && method === 'GET') return json(res, { items: adminQuestions(stateFrom(url)) });
        const review = /^\/api\/admin\/questions\/([^/]+)(?:\/(draft|publish|sync))?$/.exec(path);
        if (review) {
          const id = assertId(review[1]);
          if (review[2] === 'draft' && method === 'PUT') return json(res, await mutate(actor, 'draft.save', 'questions', id, () => writeReply(req, id, 'draft', actor)));
          if (['publish', 'sync'].includes(review[2]) && method === 'POST') return json(res, await mutate(actor, 'draft.sync', 'questions', id, () => writeReply(req, id, 'sync', actor)));
          if (!review[2] && method === 'DELETE') return json(res, { item: await mutate(actor, 'delete', 'questions', id, () => transaction(db, () => { const result = deleteQuestion(db, id, actor); deleteDraftObject(db, 'questions', id, actor); return result; })) });
        }
        const upload = /^\/api\/admin\/uploads\/(music|games|cats|background)$/.exec(path);
        if (upload && method === 'POST') return await mutate(actor, 'upload', upload[1], '', () => handleUpload(req, res, upload[1], actor));
      }

      if (path.startsWith('/api/v1/')) {
        const bot = requireBot(config.bots, req);
        const base = config.baseUrl || origin;
        const actor = 'bot:' + bot.id;
        if (path === '/api/v1/files' && method === 'POST') {
          check(bot.scopes.has('music:write') || bot.scopes.has('games:write'), '缺少媒体上传权限。', 403, 'missing_scope');
          check(uploads < 2, '有文件正在处理，请稍后重试。', 503, 'upload_busy'); uploads++;
          try {
            const key = requestKey(req); const payload = await readUpload(req);
            if (payload.fields.kind !== 'image') requireScope(bot, 'music:write');
            return json(res, { item: await mutate(actor, 'file.upload', 'media', '', () => uploadFile(db,payload,actor,key)) },201);
          } finally { uploads--; }
        }
        const catalog = /^\/api\/v1\/catalog\/(music|games|cats)(?:\/([^/]+))?$/.exec(path);
        if (catalog && method === 'GET') {
          requireScope(bot, 'catalog:read');
          const [, category, id] = catalog;
          if (id) return json(res, { item: getContent(db, category, assertId(id), base) });
          const filterKey = category === 'music' ? 'artistId' : 'genre';
          const value = cleanText(url.searchParams.get(filterKey), filterKey, 48);
          const filter = category === 'music' && value ? assertId(value) : value;
          const limit = queryNumber(url, 'limit', 30, 1, 100);
          const offset = queryNumber(url, 'offset', 0, 0);
          const items = listContent(db, category, { base, bot: true, limit: limit + 1, offset, filter });
          return json(res, { items: items.slice(0, limit), nextOffset: items.length > limit ? offset + limit : null });
        }
        if (path === '/api/v1/artists' && method === 'GET') {
          requireScope(bot, 'catalog:read');
          return json(res, { items: getArtists(db, base) });
        }
        const sync = /^\/api\/v1\/drafts\/([^/]+)\/sync$/.exec(path);
        if (sync && method === 'POST') {
          requireScope(bot, 'content:sync');
          const draft = draftDetails(db, assertId(sync[1]), config);
          check(['music', 'games'].includes(draft.category), 'Bot 仅可同步音乐和游戏。', 403, 'missing_scope');
          return json(res, await mutate(actor, 'draft.sync', draft.category, draft.objectId, async () => syncDraft(db, config, draft.id, (await readJson(req)).version, actor, base)));
        }
        const batch = /^\/api\/v1\/batches\/([^/]+)$/.exec(path);
        if (batch && method === 'GET') {
          requireScope(bot, 'batches:read');
          const value = batchDetails(db, assertId(batch[1]), base);
          check(value.actor === actor || bot.scopes.has('content:sync') && [...value.newItems, ...value.updatedItems].every((item) => ['music', 'games'].includes(item.category)), '无权读取此批次。', 403, 'missing_scope');
          return json(res, value);
        }
        if (path === '/api/v1/drafts' && method === 'GET') {
          const category = url.searchParams.get('category');
          check(['music', 'games'].includes(category), '类别无效。');
          check(bot.scopes.has(category + ':write') || bot.scopes.has('content:sync'), '缺少草稿读取权限。', 403, 'missing_scope');
          return json(res, { items: listDrafts(db, category, config, bot.scopes.has('content:sync') ? null : actor) });
        }
        if (method === 'POST' && ['/api/v1/music', '/api/v1/games'].includes(path)) {
          const category = path.split('/').at(-1);
          requireScope(bot, `${category}:write`);
          return await mutate('bot:' + bot.id, 'upload', category, '', () => handleUpload(req, res, category, `bot:${bot.id}`, base));
        }
        if (path === '/api/v1/questions' && method === 'POST') {
          requireScope(bot, 'questions:submit');
          const item = submitQuestion(db, await readJson(req), `bot:${bot.id}`, requestKey(req), false);
          return json(res, item, 201);
        }
        if (path === '/api/v1/questions' && method === 'GET') {
          requireScope(bot, 'questions:review');
          return json(res, { items: adminQuestions(stateFrom(url)) });
        }
        const review = /^\/api\/v1\/questions\/([^/]+)\/(draft|publish|sync)$/.exec(path);
        if (review && ((review[2] === 'draft' && method === 'PUT') || (['publish', 'sync'].includes(review[2]) && method === 'POST'))) {
          requireScope(bot, 'questions:review');
          const id = assertId(review[1]);
          return json(res, await mutate(actor, review[2] === 'draft' ? 'draft.save' : 'draft.sync', 'questions', id, () => writeReply(req, id, review[2], actor)));
        }
        if (path === '/api/v1/events' && method === 'GET') {
          check(bot.scopes.has('events:read') || bot.scopes.has('content-events:read'), '缺少事件读取权限。', 403, 'missing_scope');
          return json(res, listEvents(db, bot.id, queryNumber(url, 'after', null, 0), queryNumber(url, 'limit', 30, 1, 100), !bot.scopes.has('events:read'), base));
        }
        if (path === '/api/v1/events/ack' && method === 'POST') {
          requireScope(bot, 'events:ack');
          return json(res, ackEvents(db, bot.id, (await readJson(req)).through, !bot.scopes.has('events:read')));
        }
      }
      throw new Problem(404, 'not_found', '找不到此页面或接口。');
    } catch (error) {
      if (mutation) {
        try { recordFailure(db, mutation.actor, mutation.action, mutation.category, mutation.id, error instanceof Problem ? error.code : 'internal_error'); } catch { /* Preserve the original error. */ }
      }
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      req.resume();
      if (error instanceof Problem) {
        json(res, { error: { code: error.code, message: error.message } }, error.status, error.headers);
      } else {
        console.error(error);
        json(res, { error: { code: 'internal_error', message: getSite(db, config).texts['error.internal'] } }, 500);
      }
    } finally { await cleanupUpload(req).catch((error) => console.error('临时上传清理失败：' + error.message)); }
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    config.siteBridge?.close();
    chat.close();
    clearInterval(notifyTimer);
    clearInterval(maintenanceTimer);
    for (const res of streams) res.end();
    streams.clear();
    return close(callback);
  };
  server.on('close', () => db.close());
  return server;
}

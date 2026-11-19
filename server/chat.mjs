import { check, cleanText, consumeQuota, idPattern, newId, now, Problem, requestKey, sha256, transaction } from './core.mjs';
import { loginAccount, logoutAccount, requireAccount, requireAdmin, setChatAccount } from './auth.mjs';
import { readJson, readUpload } from './media.mjs';
import { getContent, listContent } from './catalog.mjs';
import { draftDetails, editItem, listDrafts, uploadFile } from './drafts.mjs';
import { ackEvents, getQuestions, listEvents } from './questions.mjs';
import { recordChange } from './logs.mjs';
import { createSocial } from './chat-social.mjs';
import { createChatAI } from './chat-ai.mjs';
import { createManagement } from './chat-management.mjs';

const categories = { 音乐: 'music', 歌曲: 'music', 音乐分享: 'music', 游戏: 'games', 游戏分享: 'games', 猫图: 'cats', 猫猫图: 'cats' };
const paths = { music: '/music', games: '/games', cats: '/cats' };
const help = '可以直接说「播放 歌名」「查看音乐」「查看游戏」「查看猫猫图」。\n/查询 音乐|游戏|猫图 [关键词]\n管理员还可以使用 /待办、/草稿、/回复 问题ID 答复、/发布 问题ID、/同步 草稿ID。\n上传音乐：/音乐 {"title":"歌名","artistName":"歌手","note":"寄语"}，并附音频及可选封面、LRC。\n所有保存与同步操作都需要再次点击明确的确认按钮。';
const publicAccount = (session) => ({ username: session.username, role: session.role, csrf: session.csrf, key: session.key });
const baseMessage = (row) => ({ id: row.id, role: row.role, senderKey: row.sender_key, senderName: row.sender_name, body: row.body, status: row.status, metadata: JSON.parse(row.metadata), createdAt: row.created_at, updatedAt: row.updated_at });

export function createChat(db, config, json) {
  const connections = new Set(), runs = new Map();
  let ai;
  let closing = false, loggingIn = 0, fileUploads = 0;
  const contactKeys = () => new Set(social.users().map(user => user.key));
  const members = (id) => social.members(id);
  const message = (row) => {const value=social.message(baseMessage(row));return ai?ai.decorate(value):value;};
  // An interrupted provider request is never silently repeated after a restart.
  db.prepare("UPDATE chat_messages SET status='failed', metadata=json_set(metadata,'$.error',?),updated_at=? WHERE status='generating'")
    .run('服务刚刚重启，已保留收到的回复。可点击重试。', now());
  const emit = (owner, thread, type, data) => {
    for (const stream of connections) if (thread ? db.prepare('SELECT 1 FROM chat_members WHERE thread_id=? AND account_key=?').get(thread, stream.owner) : stream.owner === owner) {
      if (stream.res.writableLength > 128 * 1024) stream.res.destroy();
      else stream.res.write('event: ' + type + '\ndata: ' + JSON.stringify({ ...data, threadId: thread }) + '\n\n');
    }
  };
  const own = (session, id) => {
    check(idPattern.test(id || ''), '没有找到这段对话。', 404, 'not_found');
    const row = db.prepare('SELECT t.* FROM chat_threads t JOIN chat_members m ON m.thread_id=t.id WHERE t.id=? AND m.account_key=?').get(id, session.key);
    check(row, '没有找到这段对话。', 404, 'not_found');
    return row;
  };
  const threadView = (row, session) => ({ id: row.id, kind: row.kind, owner: row.owner,
    title: row.kind === 'direct' ? members(row.id).find((a) => a.key !== session.key)?.displayName || '私聊' : row.title,
    unread: db.prepare("SELECT count(*) AS n FROM chat_messages msg WHERE thread_id=? AND sender_key!=? AND status='complete' AND NOT EXISTS(SELECT 1 FROM chat_message_reads r WHERE r.account_key=? AND r.message_id=msg.id)").get(row.id, session.key, session.key).n,
    createdAt: row.created_at, updatedAt: row.updated_at });
  const social = createSocial(db, { emit, own, invalidate: (thread) => { for (const run of runs.values()) if (run.thread === thread) run.controller.abort();ai?.invalidate(thread); } });
  const management=createManagement(db,config,{social,emit,onConnection:()=>ai?.reconfigure()});
  const publishMessage = (owner, thread, id) => {
    if (closing) return;
    const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(id);
    if (row) emit(owner, thread, 'message', { item: message(row) });
  };
  ai=createChatAI(db,config,{social,own,emit,publish:publishMessage,message});
  function submittedMessages(threadId, storageKey, fingerprint) {
    const rows = db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND request_key=? ORDER BY id').all(threadId, storageKey);
    if (!rows.length) return null;
    const user = rows.find(row => row.role === 'user');
    check(user && JSON.parse(user.metadata).fingerprint === fingerprint, '重试标识已用于另一条消息。', 409, 'idempotency_conflict');
    const replies = db.prepare('SELECT m.* FROM chat_ai_jobs j JOIN chat_messages m ON m.id=j.reply_id WHERE j.source_id=? ORDER BY m.id').all(user.id);
    return [...rows, ...replies];
  }
  async function syncNotices(session,req) {
    requireManager(session);
    const created = [];
    const cursorKey='website-event-cursor:'+session.key;
    const external=config.siteBridge?await config.siteBridge.events(Number(db.prepare('SELECT value FROM app_flags WHERE key=?').get(cursorKey)?.value||0),req):null;
    const result = transaction(db, () => {
      const consumer = 'app-chat:' + session.id;
      const events = external||listEvents(db, consumer, null, 100, false, '');
      const relevant = events.items.filter((event) => event.type === 'content.synced' || event.state === 'pending');
      let inbox;
      if (relevant.length) {
        const flag = 'chat-inbox:' + session.key;
        const old = db.prepare('SELECT value FROM app_flags WHERE key=?').get(flag)?.value;
        inbox = old && db.prepare('SELECT id FROM chat_threads WHERE id=? AND owner=?').get(old, session.key)?.id;
        if (!inbox) {
          inbox = newId(); const at = now();
          db.prepare('INSERT INTO chat_threads VALUES (?,?,?,?,?,?)').run(inbox, session.key, 'ai', '庭院来信', at, at);
          db.prepare('INSERT INTO chat_members (thread_id,account_key,joined_at) VALUES (?,?,?)').run(inbox, session.key, at);
          db.prepare('INSERT INTO app_flags VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(flag, inbox);
        }
        for (const event of relevant) {
          const question = event.type === 'question.created';
          const text = question ? '庭院收到一封新来信。\n\n' + event.author + '：' + event.question
            : '庭院更新已同步。\n批次：' + event.batchId + '\n新增：' + (event.newItems.map((i) => i.title).join('、') || '无') + '\n更新：' + (event.updatedItems.map((i) => i.title).join('、') || '无');
          const metadata = { noticeEventId: event.id, ...(question ? { questions: [{ id: event.questionId, author: event.author, question: event.question }] } : { noticeBatchId: event.batchId }) };
          const at = now(); const insert = db.prepare("INSERT INTO chat_messages (thread_id,role,sender_key,sender_name,body,status,metadata,request_key,created_at,updated_at) VALUES (?,'assistant','system','庭院来信',?,'complete',?,?,?,?) ON CONFLICT(thread_id,request_key,role) DO NOTHING")
            .run(inbox, text, JSON.stringify(metadata), 'notice_' + event.id, at, at);
          if (insert.changes) created.push({ thread: inbox, id: Number(insert.lastInsertRowid) });
        }
        if (created.length) db.prepare('UPDATE chat_threads SET updated_at=? WHERE id=?').run(now(), inbox);
      }
      if (events.items.length) {if(external)db.prepare('INSERT INTO app_flags VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(cursorKey,String(events.nextCursor));else ackEvents(db, consumer, events.nextCursor);}
      return { created: created.length, threadId: inbox || null, hasMore: events.hasMore, acknowledgedThrough: events.nextCursor };
    });
    for (const item of created) publishMessage(session.key, item.thread, item.id);
    if (created.length) emit(session.key, created[0].thread, 'threads', {});
    return result;
  }
  function requireManager(session) { check(session.role === 'admin', '此操作仅管理员可用。', 403, 'admin_required'); }
  function attachments(session, ids) {
    check(Array.isArray(ids) && ids.length <= 8 && new Set(ids).size === ids.length, '附件列表无效。');
    return ids.map((id) => {
      check(idPattern.test(id || ''), '附件 ID 无效。');
      const item = db.prepare('SELECT m.id,m.name,m.mime,m.size,s.kind FROM media m JOIN staged_files s ON s.media_id=m.id WHERE m.id=? AND s.actor=?')
        .get(id, 'chat:' + session.key);
      check(item, '附件不存在或不属于当前账号。', 403, 'file_forbidden');
      return { ...item, url: '/chat-media/' + id };
    });
  }
  async function command(session, text, files,req) {
    const raw = text.replace(/^\/月站\s+/, '/');
    const query = /^\/(查询|播放)\s+(.+)$/.exec(raw) || /^(播放|听听)\s+(.+)$/.exec(raw);
    const browse = /^查看\s*(音乐分享|音乐|游戏分享|游戏|猫猫图|猫图|关于我|提问箱|首页)$/.exec(raw);
    if (query || browse) {
      const playing = query && ['播放', '听听'].includes(query[1]);
      const parts = playing ? ['音乐', query[2]] : (query?.[2] || browse[1]).split(/\s+/, 2);
      const category = categories[parts[0]];
      if (!category && browse) return { body: '已找到这个栏目，可以在应用内打开。', metadata: { section: { 关于我: 'about', 提问箱: 'questions', 首页: 'home' }[browse[1]] } };
      check(category, '查询类别为音乐、游戏或猫图。');
      const keyword = parts[1] || '';
      const catalog=config.siteBridge?(await config.siteBridge.get('/api/public/'+category,req)).items:listContent(db, category);
      const items = catalog.filter((item) => !keyword || [item.title, item.translation, item.artist, item.genre].some((v) => v?.toLowerCase().includes(keyword.toLowerCase()))).slice(0, 12);
      return { body: items.length ? (playing ? '找到这些旋律，点播放即可听完整歌曲。' : '这些是网站已同步的收藏。') : '月下暂时没有找到这份收藏。',
        metadata: { category, items, section: category } };
    }
    if (raw === '/帮助') return { body: help };
    if (!raw.startsWith('/')) return null;
    requireManager(session);
    if (raw === '/待办') return { body: '待处理来信如下。答复需要保存，再明确确认同步。', metadata: { questions: (config.siteBridge?(await config.siteBridge.get('/api/admin/questions?state=pending',req)).items:getQuestions(db,'pending')).slice(0,30) } };
    if (raw === '/草稿') return { body: '这些修改尚未同步到前台。', metadata: { drafts: (config.siteBridge?(await config.siteBridge.get('/api/admin/drafts',req)).items:listDrafts(db,null,config)).filter(d=>d.state==='draft').slice(0,30) } };
    const reply = /^\/回复\s+(\S+)\s+([\s\S]+)$/.exec(raw);
    if (reply) {
      const current = config.siteBridge?(await config.siteBridge.get('/api/admin/questions?state=pending',req)).items.find(q=>q.id===reply[1]):editItem(db,'questions',reply[1],config);check(current,'没有找到这封待处理来信。',404);
      return { body: '核对答复后点击「确认保存」。保存草稿后还需要单独同步。', metadata: { action: { type: 'reply', id: current.id, version: current.version, reply: cleanText(reply[2], '回复', 2400, true), question: current.question } } };
    }
    const publish = /^\/(发布|同步)\s+(\S+)$/.exec(raw);
    if (publish) {
      const current = config.siteBridge?(publish[1]==='发布'?(await config.siteBridge.get('/api/admin/questions?state=pending',req)).items.find(q=>q.id===publish[2]):(await config.siteBridge.get('/api/admin/drafts/'+publish[2],req)).item):publish[1] === '发布' ? editItem(db, 'questions', publish[2], config) : draftDetails(db, publish[2], config).item;check(current,'没有找到待同步内容。',404);
      check(current.draftId, '请先保存草稿，再确认同步。', 409, 'save_required');
      return { body: '请核对本次修改。同步后网站访客即可看到。', metadata: { action: { type: 'sync', id: current.draftId, version: current.version, title: current.title || current.question || '站点修改' } } };
    }
    const upload = /^\/(音乐|游戏)\s+([\s\S]+)$/.exec(raw);
    if (upload) {
      let fields; try { fields = JSON.parse(upload[2]); } catch { throw new Problem(400, 'invalid_json', '请在音乐或游戏指令后提供有效 JSON。'); }
      check(fields && typeof fields === 'object' && !Array.isArray(fields), '内容字段须为 JSON 对象。');
      const category = upload[1] === '音乐' ? 'music' : 'games';
      const mapped = {}; let images = 0;
      for (const file of files) {
        const key = file.kind === 'audio' ? 'audio' : file.kind === 'lyrics' ? 'lyricsFile' : category === 'music' ? 'cover' : images++ === 0 ? 'logo' : 'images';
        (mapped[key] ??= []).push(file.id);
      }
      return { body: '文件已私有保存，尚未创建或发布内容。请核对字段，再确认保存草稿。', metadata: { action: { type: 'content', category, fields, files: mapped } } };
    }
    return { body: help };
  }
  async function generate(session, thread, id) {
    const controller = new AbortController();
    const run = { owner: session.key, thread, id, controller, text: '', timer: null };
    runs.set(id, run);
    let finished = false;
    const update = (status = 'generating', error = null) => {
      if (closing || !db.prepare('SELECT 1 FROM chat_messages WHERE id=?').get(id)) return;
      const previous = JSON.parse(db.prepare('SELECT metadata FROM chat_messages WHERE id=?').get(id).metadata);
      if (error) previous.error = error; else delete previous.error;
      db.prepare('UPDATE chat_messages SET body=?,status=?,metadata=?,updated_at=? WHERE id=?').run(run.text, status, JSON.stringify(previous), now(), id);
      publishMessage(session.key, thread, id);
    };
    try {
      const settings = config.chat || {};
      check(settings.apiBase && settings.apiKey && settings.model, '尚未配置聊天模型。网站浏览与管理仍可使用，请由管理员配置 CHAT_AI_*。', 503, 'model_unconfigured');
      const history = db.prepare("SELECT role,body,sender_name FROM chat_messages WHERE thread_id=? AND id<? AND (role='user' OR status='complete') ORDER BY id DESC LIMIT 30").all(thread, id).reverse();
      const shared = db.prepare('SELECT kind FROM chat_threads WHERE id=?').get(thread)?.kind !== 'ai';
      let budget = 24_000;
      const contexts = [];
      for (const row of history.reverse()) { if (budget <= 0) break; contexts.unshift({ role: row.role, content: (shared && row.role === 'user' ? row.sender_name + '：' : '') + row.body.slice(-Math.min(budget, 8000)) }); budget -= row.body.length; }
      const catalog = ['music', 'games'].flatMap((category) => listContent(db, category).slice(0, 12).map((item) => ({ title: item.title, artist: item.artist, category, url: paths[category] + '?id=' + item.id })));
      const messages = [{ role: 'system', content: settings.systemPrompt + '\n可用指令：' + help + '\n网站已同步收藏（仅供查询参考）：' + JSON.stringify(catalog) }, ...contexts];
      const endpoint = new URL('chat/completions', settings.apiBase.replace(/\/?$/, '/'));
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]),
        headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: settings.model, messages, stream: true, max_tokens: 2400,
          ...(endpoint.hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}) }) });
      check(response.ok, response.status === 429 ? '模型服务繁忙，请稍后重试。' : '模型连接暂时失败，请检查服务端模型配置后重试。', 502, 'model_unavailable');
      if (response.headers.get('content-type')?.includes('application/json')) {
        const value = await response.json(); run.text = cleanText(value.choices?.[0]?.message?.content, '回复', 40_000, true); finished = true;
      } else {
        check(response.body && response.headers.get('content-type')?.includes('text/event-stream'), '模型未返回可读取的流式回复。', 502, 'invalid_model_response');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
        const accept = (line) => {
          if (!line.startsWith('data:')) return;
          const data = line.slice(5).trim(); if (!data) return;
          if (data === '[DONE]') { finished = true; return; }
          const chunk = JSON.parse(data); if (chunk.error) throw new Error('model_error');
          const choice = chunk.choices?.[0]; if (choice?.finish_reason) finished = true;
          const delta = choice?.delta?.content;
          if (typeof delta === 'string') {
            run.text += delta; check(run.text.length <= 80_000, '本次回复超过长度限制。');
            if (!run.timer) run.timer = setTimeout(() => { run.timer = null; update(); }, 100);
          }
        };
        try {
          while (!finished) {
            const { done, value } = await reader.read();
            pending += decoder.decode(value || new Uint8Array(), { stream: !done });
            check(pending.length <= 1_000_000, '模型返回格式异常。');
            let newline; while ((newline = pending.indexOf('\n')) >= 0) { accept(pending.slice(0, newline).replace(/\r$/, '')); pending = pending.slice(newline + 1); }
            if (done) { if (pending.trim()) accept(pending); break; }
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      check(finished && run.text.trim(), '模型回复中断，已保留收到的文字。可点击重试。', 502, 'response_interrupted');
      update('complete');
    } catch (error) {
      const stopped = controller.signal.aborted;
      update(stopped ? 'stopped' : 'failed', stopped ? null : error instanceof Problem ? error.message : '回复暂时中断，已保留收到的文字，可重试。');
    } finally { clearTimeout(run.timer); runs.delete(id); }
  }
  const heartbeat = setInterval(() => {
    for (const stream of connections) {
      try {
        requireAccount(db, stream.req);
        if (stream.res.writableLength > 128 * 1024) stream.res.destroy();
        else { stream.res.write(': connected\n\n'); social.keepConnection(stream.id); }
      } catch { stream.res.end(); }
    }
  }, 15_000); heartbeat.unref();

  async function handle(req, res, url, ip) {
    const path = url.pathname, method = req.method;
    if (path.startsWith('/api/admin/accounts')) {
      const admin = requireAdmin(db, req), actor = 'admin:' + admin.username;
      if (path === '/api/admin/accounts' && method === 'GET') {
        return json(res, { items: db.prepare('SELECT id,username,disabled,created_at AS createdAt FROM chat_accounts ORDER BY created_at DESC LIMIT 200').all(), administrators: db.prepare('SELECT username FROM admins').all().map((x) => x.username) });
      }
      if (path === '/api/admin/accounts' && method === 'POST') {
        const item = await setChatAccount(db, await readJson(req, 4096)); social.ensureProfiles(); recordChange(db, actor, 'account.create', 'accounts', item.id, '创建普通应用账号', null); return json(res, { item }, 201);
      }
      const account = /^\/api\/admin\/accounts\/([0-9a-f-]{36})$/.exec(path);
      if (account && method === 'PATCH') {
        const current = db.prepare('SELECT id,username FROM chat_accounts WHERE id=?').get(account[1]); check(current, '没有找到此账号。', 404, 'not_found');
        const data = await readJson(req, 4096);
        if (Object.hasOwn(data, 'disabled')) {
          check(typeof data.disabled === 'boolean', '账号状态无效。');
          transaction(db, () => { db.prepare('UPDATE chat_accounts SET disabled=? WHERE id=?').run(Number(data.disabled), current.id); db.prepare('DELETE FROM chat_sessions WHERE account_id=?').run(current.id); });
          for (const run of runs.values()) if (run.owner === 'member:' + current.id) run.controller.abort();
          for (const stream of connections) if (stream.owner === 'member:' + current.id) stream.res.end();
        } else await setChatAccount(db, { username: current.username, password: data.password }, current.id);
        recordChange(db, actor, 'account.update', 'accounts', current.id, '更新应用账号状态或登录凭据', null); return json(res, { ok: true });
      }
      throw new Problem(404, 'not_found', '找不到账号接口。');
    }
    if (!path.startsWith('/api/chat/')) return false;
    if (path === '/api/chat/login' && method === 'POST') {
      check(loggingIn < 2, '登录请求较多，请稍后再试。', 503, 'login_busy'); loggingIn++;
      try { const credentials=await readJson(req,4096);const result = await loginAccount(db,credentials,ip,config.secureCookie,req.chatAdminCookieName);if(config.siteBridge&&result.data.role==='admin'){try{result.cookies.push(...await config.siteBridge.login(credentials));result.data.websiteLinked=true;}catch{result.data.websiteLinked=false;}}json(res, result.data, 200, { 'Set-Cookie': result.cookies }); } finally { loggingIn--; }
      return true;
    }
    if(path==='/api/chat/bootstrap'){
      const available=!!config.initializeAdmin&&!db.prepare('SELECT 1 FROM admins LIMIT 1').get();
      if(method==='GET'){json(res,{available});return true;}
      check(available,'管理员已初始化，请正常登录。',409);const d=await readJson(req,4096);await config.initializeAdmin(d);social.ensureProfiles();json(res,{ok:true});return true;
    }
    const session = requireAccount(db, req);
    if(await management(session,req,res,url,json))return true;
    if (await social.handle(session, req, res, url, json)) return true;
    if (await ai.handle(session, req, res, url, json)) return true;
    if (path === '/api/chat/notices/sync' && method === 'POST') { json(res,await syncNotices(session,req)); return true; }
    if(path==='/api/chat/site/media-export'&&method==='POST'){requireManager(session);const data=await readJson(req);json(res,{items:config.siteBridge?await config.siteBridge.exportMedia(session,req,data.ids):Object.fromEntries(data.ids.map(id=>[id,id]))});return true;}
    if(path==='/api/chat/site/login'&&method==='POST'){requireManager(session);check(config.siteBridge,'当前未启用独立网站后端。');const credentials=await readJson(req,4096);json(res,{linked:true},200,{'Set-Cookie':await config.siteBridge.login(credentials)});return true;}
    if (path === '/api/chat/contacts' && method === 'GET') { json(res, { items: social.friends(session.key) }); return true; }
    if (path === '/api/chat/files' && method === 'POST') {
      check(fileUploads < 2, '文件正在处理，请稍后重试。', 503, 'upload_busy'); fileUploads++;
      try { consumeQuota(db, 'chat-file:' + session.key, 30, 3600_000); json(res, { item: await uploadFile(db, await readUpload(req), 'chat:' + session.key, requestKey(req)) }, 201); }
      finally { fileUploads--; } return true;
    }
    if (path === '/api/chat/events' && method === 'GET') {
      check(connections.size < 64 && [...connections].filter((s) => s.owner === session.key).length < 5, '实时连接较多，请关闭多余窗口后重试。', 503, 'stream_busy');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
      res.write('retry: 1500\nevent: ready\ndata: {}\n\n'); const stream = { id:newId(), res, req, owner: session.key }; connections.add(stream); social.openConnection(session.key,stream.id); res.once('close', () => {connections.delete(stream);social.closeConnection(stream.id);}); return true;
    }
    if (path === '/api/chat/session' && method === 'GET') {
      let profile = social.profile(session.key, session.key);
      if (!profile) { social.ensureProfiles(); profile = social.profile(session.key, session.key); }
      json(res, { ...publicAccount(session), profile, assistantName: config.chat?.assistantName || '大肥鱼',
        astrbotConfigured: ai.configured, aiReady: ai.configured || Boolean(config.chat?.apiBase && config.chat?.apiKey && config.chat?.model) });
      return true;
    }
    if (path === '/api/chat/logout' && method === 'POST') { json(res, { ok: true }, 200, { 'Set-Cookie': logoutAccount(db, req, config.secureCookie) }); for (const s of connections) if (s.owner === session.key) s.res.end(); return true; }
    if (path === '/api/chat/threads' && method === 'GET') {
      const offset = Number(url.searchParams.get('offset') || 0); check(Number.isSafeInteger(offset) && offset >= 0, '分页参数无效。');
      const limit = Number(url.searchParams.get('limit') || 50);
      check(Number.isInteger(limit) && limit >= 1 && limit <= 300, '会话分页大小无效。');
      const rows = db.prepare('SELECT t.* FROM chat_threads t JOIN chat_members m ON m.thread_id=t.id WHERE m.account_key=? AND m.hidden=0 ORDER BY t.updated_at DESC,t.id DESC LIMIT ? OFFSET ?').all(session.key, limit + 1, offset);
      const totalUnread=db.prepare("SELECT count(*) AS n FROM chat_messages msg JOIN chat_members m ON m.thread_id=msg.thread_id WHERE m.account_key=? AND m.hidden=0 AND msg.sender_key!=? AND msg.status='complete' AND NOT EXISTS(SELECT 1 FROM chat_message_reads r WHERE r.account_key=? AND r.message_id=msg.id)").get(session.key,session.key,session.key).n;
      json(res, { items: rows.slice(0, limit).map((r) => threadView(r, session)), totalUnread, nextOffset: rows.length > limit ? offset + limit : null }); return true;
    }
    if (path === '/api/chat/threads' && method === 'POST') {
      const key = requestKey(req), data = await readJson(req, 8192); const title = cleanText(data.title || '新的夜话', '对话标题', 80, true);
      const kind = data.kind || 'ai'; check(['ai', 'direct', 'group'].includes(kind), '对话类型无效。');
      check(data.aiId == null || kind === 'ai' && idPattern.test(data.aiId), '新建会话的 AI 选项无效。');
      check(data.members == null || Array.isArray(data.members) && data.members.every((v) => typeof v === 'string'), '成员列表无效。');
      const joined = [...new Set([session.key, ...(data.members || [])])];
      check(joined.length <= 30 && (kind === 'ai' ? joined.length === 1 : kind === 'direct' ? joined.length === 2 : joined.length >= 1), '私聊需要另一位成员，群聊最多30人。');
      const known = contactKeys();
      check(joined.every(id => known.has(id)), '成员不存在或账号已停用。');
      const pair = kind === 'direct' ? [...joined].sort().join('|') : null;
      if (kind === 'direct') check(social.isFriend(joined[0],joined[1]),'请先发送好友申请，并由对方接受。',403,'friend_required');
      const scope = 'chat-thread:' + session.key;
      const fingerprint = sha256(JSON.stringify(data.aiId ? [title, kind, [...joined].sort(), data.aiId] : [title, kind, [...joined].sort()]));
      if (data.aiId && !db.prepare('SELECT 1 FROM idempotency WHERE scope=? AND key=?').get(scope, key)) {
        await ai.refreshAgents();
        requireAccount(db, req);
      }
      let item;
      transaction(db, () => {
        const previous = db.prepare('SELECT fingerprint,result FROM idempotency WHERE scope=? AND key=?').get(scope, key);
        if (previous) { check(previous.fingerprint === fingerprint, '重试标识已用于另一段对话。', 409, 'idempotency_conflict'); item = threadView(own(session, JSON.parse(previous.result).id), session); return; }
        const priorDirect = pair && db.prepare('SELECT thread_id FROM chat_direct_pairs WHERE pair_key=?').get(pair);
        if (priorDirect) { db.prepare('UPDATE chat_members SET hidden=0 WHERE thread_id=?').run(priorDirect.thread_id); item = threadView(own(session, priorDirect.thread_id), session); return; }
        consumeQuota(db, 'chat-new:' + session.key, 30, 3600_000);
        check(db.prepare('SELECT count(*) AS n FROM chat_threads WHERE owner=?').get(session.key).n < 300, '对话数量已达上限，请先整理旧对话。');
        const id = newId(), at = now(); db.prepare('INSERT INTO chat_threads VALUES (?,?,?,?,?,?)').run(id, session.key, kind, title, at, at);
        for (const member of kind==='group'?[session.key]:joined) db.prepare('INSERT INTO chat_members (thread_id,account_key,joined_at) VALUES (?,?,?)').run(id, member, at);
        if(kind==='group')for(const member of joined.filter(key=>key!==session.key))social.invite(session,id,member);
        if (pair) db.prepare('INSERT INTO chat_direct_pairs VALUES (?,?)').run(pair, id);
        if (data.aiId) ai.addAI(session, id, data.aiId);
        item = threadView(own(session, id), session); db.prepare('INSERT INTO idempotency VALUES (?,?,?,?)').run(scope, key, fingerprint, JSON.stringify(item));
      }); emit(null, item.id, 'threads', {}); json(res, { item }, 201); return true;
    }
    const threadRoute = /^\/api\/chat\/threads\/([0-9a-f-]{36})(?:\/(messages|members|read|stop|retry))?$/.exec(path);
    if (threadRoute) {
      const [, id, action] = threadRoute; const thread = own(session, id);
      if (!action && method === 'GET') {
        const item = { ...threadView(thread, session), members: members(id) };
        if (url.searchParams.has('after')) {
          const after = Number(url.searchParams.get('after'));
          check(Number.isSafeInteger(after) && after >= 0 && !url.searchParams.has('before'), '分页参数无效。');
          const rows = db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND id>? ORDER BY id LIMIT 61').all(id, after);
          json(res, { item, messages: rows.slice(0, 60).map(message), nextAfter: rows.length > 60 ? rows[59].id : null });
          return true;
        }
        const before = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER); check(Number.isSafeInteger(before) && before > 0, '分页参数无效。');
        const rows = db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND id<? ORDER BY id DESC LIMIT 61').all(id, before);
        json(res, { item, messages: rows.slice(0, 60).reverse().map(message), before: rows.length > 60 ? rows[59].id : null }); return true;
      }
      if (!action && method === 'PATCH') {
        check(thread.kind !== 'direct' && thread.owner === session.key, '只有创建者可修改这段对话的名称。', 403, 'owner_required');
        const data = await readJson(req, 4096); db.prepare('UPDATE chat_threads SET title=?,updated_at=? WHERE id=?').run(cleanText(data.title, '对话标题', 80, true), now(), id); emit(null, id, 'threads', {}); json(res, { item: threadView(own(session, id), session) }); return true;
      }
      if (!action && method === 'DELETE') {
        if (thread.kind === 'direct') db.prepare('UPDATE chat_members SET hidden=1 WHERE thread_id=? AND account_key=?').run(id, session.key);
        else if (thread.kind === 'group' && thread.owner !== session.key) social.removeMember(id,session.key);
        else { ai.invalidate(id);for (const run of runs.values()) if (run.thread === id) run.controller.abort(); emit(null, id, 'deleted', { id }); db.prepare('DELETE FROM chat_threads WHERE id=?').run(id); }
        emit(session.key, null, 'deleted', { id }); json(res, { ok: true }); return true;
      }
      if (action === 'members' && method === 'PUT') {
        check(thread.kind === 'group' && thread.owner === session.key, '只有群主可管理群成员。', 403, 'owner_required');
        const data = await readJson(req, 8192); check(Array.isArray(data.members) && data.members.every((v) => typeof v === 'string'), '成员列表无效。');
        const joined = [...new Set([session.key, ...data.members])], known = contactKeys();
        check(joined.length >= 1 && joined.length <= 30 && joined.every(key => known.has(key)), '群成员最多30个有效账号。');
        transaction(db, () => {
          for (const old of members(id)) if (old.kind!=='ai' && !joined.includes(old.key)) social.removeMember(id,old.key);
          for (const key of joined.filter(key=>!members(id).some(m=>m.key===key))) social.invite(session,id,key);
        }); emit(null, id, 'threads', {}); json(res, { members: members(id) }); return true;
      }
      if (action === 'read' && method === 'POST') {
        const through = Number(url.searchParams.get('through') ?? Number.MAX_SAFE_INTEGER);
        check(Number.isSafeInteger(through) && through >= 0, '已读位置无效。');
        const changes = transaction(db, () => {
          const result = db.prepare("INSERT INTO chat_message_reads SELECT ?,id FROM chat_messages WHERE thread_id=? AND id<=? AND status='complete' AND sender_key!=? ON CONFLICT DO NOTHING").run(session.key, id, through, session.key);
          if (result.changes) db.prepare('UPDATE chat_members SET last_read_id=max(last_read_id,(SELECT coalesce(max(id),0) FROM chat_messages WHERE thread_id=? AND id<=?)) WHERE thread_id=? AND account_key=?').run(id, through, id, session.key);
          return result.changes;
        });
        if (changes) emit(session.key, null, 'read', { id });
        json(res, { ok: true }); return true;
      }
      if (action === 'stop' && method === 'POST') {ai.stop(session,id); for (const run of runs.values()) if (run.thread === id && run.owner === session.key) run.controller.abort(); json(res, { ok: true }); return true; }
      if (action === 'retry' && method === 'POST') {
        const data = await readJson(req, 4096), row = db.prepare('SELECT * FROM chat_messages WHERE id=? AND thread_id=? AND role=?').get(Number(data.messageId), id, 'assistant');
        if(row&&ai.retry(session,row.id)){json(res,{ok:true});return true;}
        check(row && ['failed', 'stopped'].includes(row.status), '这条回复当前不能重试。', 409, 'retry_unavailable');
        check(JSON.parse(row.metadata).requestedBy === session.key, '只能重试由自己发起的回复。', 403, 'message_forbidden');
        check(![...runs.values()].some((run) => run.thread === id || run.owner === session.key) && runs.size < 4, '请先等待当前回复结束。', 409, 'chat_busy');
        check(db.prepare('SELECT max(id) AS id FROM chat_messages WHERE thread_id=?').get(id).id === row.id, '请重试最后一条回复，或开始新的对话。', 409, 'retry_unavailable');
        consumeQuota(db, 'chat:' + session.key, 20, 60_000);
        db.prepare("UPDATE chat_messages SET body='',status='generating',updated_at=? WHERE id=?").run(now(), row.id); publishMessage(session.key, id, row.id); void generate(session, id, row.id); json(res, { ok: true }); return true;
      }
      if (action === 'messages' && method === 'POST') {
        const data = await readJson(req, 64 * 1024), key = requestKey(req); const text = cleanText(data.text, '消息', 8000, true);
        own(requireAccount(db, req), id);
        const storageKey = session.key + ':' + key;
        check(data.mentionAssistant == null || typeof data.mentionAssistant === 'boolean', '@助理选项无效。');
        const files = attachments(session, data.attachmentIds || []); const fingerprint = sha256(JSON.stringify([text, files.map((f) => f.id), data.mentionAssistant === true]));
        if (thread.kind !== 'ai' && /^\/(?:月站\s+)?(?:待办|草稿|回复|发布|同步|音乐|游戏)(?:\s|$)/.test(text)) {
          throw new Problem(403, 'private_command_required', '网站管理指令请在与助理的私人对话中使用。');
        }
        const existing = submittedMessages(id, storageKey, fingerprint);
        if (existing) { json(res, { items: existing.map(message) }); return true; }
        const raw = text.replace(/^\/月站\s+/, '/');
        const publicCommand = raw === '/帮助' || /^\/(?:查询|播放)\s/.test(raw) || /^(?:播放|听听)\s/.test(raw) || /^查看\s*(?:音乐分享|音乐|游戏分享|游戏|猫猫图|猫图|关于我|提问箱|首页)$/.test(raw);
        const explicitGroupReply = thread.kind === 'group' && data.mentionAssistant === true;
        // Local commands can still answer while the model service is offline.
        const result = thread.kind === 'ai' || publicCommand ? await command(session, text, files, req) : null;
        if (!result && ai.configured && thread.kind !== 'direct') {
          await ai.prepare(session, thread, data.aiId, () => own(requireAccount(db, req), id));
        }
        const current = own(requireAccount(db, req), id);
        let rows, created = false;
        let assistantId;
        transaction(db, () => {
          rows = submittedMessages(id, storageKey, fingerprint);
          if (rows) return;
          const selectedAgents = !result && ai.configured && current.kind !== 'direct' ? ai.memberAIs(id) : [];
          const needsAssistant = Boolean(result) || current.kind === 'ai' || explicitGroupReply || selectedAgents.length > 0;
          if (ai.configured && explicitGroupReply && !selectedAgents.length && !result) throw new Problem(409, 'invite_ai_first', '请先从服务器 AI 列表邀请 AI 入群。');
          if (needsAssistant && !result && !selectedAgents.length) {
            check(![...runs.values()].some(run => run.thread === id || run.owner === session.key) && runs.size < 4, '请先等待当前回复结束，或停止生成。', 409, 'chat_busy');
          }
          consumeQuota(db, 'chat-message:' + session.key, 60, 60_000);
          if (needsAssistant) { consumeQuota(db, 'chat:' + session.key, 20, 60_000); consumeQuota(db, 'chat-day:' + session.key, session.role === 'admin' ? 1000 : 200, 86400_000); }
          const at = now(); const insert = db.prepare('INSERT INTO chat_messages (thread_id,role,sender_key,sender_name,body,status,metadata,request_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
          const inserted=insert.run(id, 'user', session.key, session.username, text, 'complete', JSON.stringify({ attachments: files, fingerprint }), storageKey, at, at);
          const sourceRow=db.prepare('SELECT * FROM chat_messages WHERE id=?').get(Number(inserted.lastInsertRowid));ai.remember(sourceRow);
          if(selectedAgents.length)ai.queue(session,current,sourceRow,selectedAgents);
          else if (needsAssistant) assistantId = Number(insert.run(id, 'assistant', 'assistant', config.chat?.assistantName || '大肥鱼', result?.body || '', result ? 'complete' : 'generating', JSON.stringify({ ...result?.metadata, requestedBy: session.key }), storageKey, at, at).lastInsertRowid);
          db.prepare('UPDATE chat_threads SET title=?,updated_at=? WHERE id=?').run(current.kind === 'ai' && current.title === '新的夜话' ? text.replace(/^\//, '').slice(0, 28) : current.title, at, id);
          db.prepare('UPDATE chat_members SET hidden=0 WHERE thread_id=?').run(id);
          rows = submittedMessages(id, storageKey, fingerprint);
          created = true;
        });
        if (created) {
          for (const row of rows) publishMessage(session.key, id, row.id);
          emit(null, id, 'threads', { reason: 'message' });
          if (assistantId && !result) void generate(session, id, assistantId);
        }
        json(res, { items: rows.map(message) }, created ? 201 : 200); return true;
      }
    }
    throw new Problem(404, 'not_found', '找不到聊天接口。');
  }
  return { handle, close() {
    closing = true; clearInterval(heartbeat); social.close();ai.close();
    for (const run of runs.values()) { clearTimeout(run.timer); db.prepare("UPDATE chat_messages SET body=?,status='stopped',updated_at=? WHERE id=?").run(run.text, now(), run.id); run.controller.abort(); }
    for (const stream of connections) stream.res.end(); connections.clear();
  } };
}

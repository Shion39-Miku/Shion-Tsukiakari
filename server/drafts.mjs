import { check, cleanText, idPattern, newId, now, priorResult, saveResult, sha256, transaction } from './core.mjs';
import { background, getContent, getArtists, prepareUpload } from './catalog.mjs';
import { describeMedia, isTransferred, loadMediaFile, prepareAudio, prepareImage, readLyrics, storeMedia, uploadFingerprint } from './media.mjs';
import { saveLyricsRecord } from './media-maintenance.mjs';
import { getSite, materializeSettings, prepareSettingsChange } from './settings.mjs';
import { recordChange } from './logs.mjs';
import { canReadChatFile } from './chat-access.mjs';

const tables = { music: 'songs', games: 'games', cats: 'cats' };
const supported = ['music', 'games', 'cats', 'background', 'settings', 'questions'];
const paths = { music: '/music', games: '/games', cats: '/cats', questions: '/questions' };
const latest = (db, category, objectId) => db.prepare('SELECT * FROM drafts WHERE category = ? AND object_id = ?').get(category, objectId);
const privateStore = (db, file) => storeMedia(db, file, { published: false });

function active(db, category, id) {
  check(!db.prepare('SELECT 1 FROM deleted_objects WHERE category = ? AND object_id = ?').get(category, id), '此内容已删除，不能由重试恢复。', 410, 'content_deleted');
  if (category === 'questions') {
    const row = db.prepare('SELECT state FROM questions WHERE id = ?').get(id);
    check(row, '没有找到这封来信。', 404, 'not_found');
    check(row.state !== 'deleted', '这封来信已删除。', 410, 'question_deleted');
  }
}
function canonicalVersion(db, category, id) {
  if (category === 'settings') return db.prepare('SELECT version FROM site_settings WHERE id = 1').get().version;
  if (category === 'background') return db.prepare('SELECT coalesce(max(version), 0) AS version FROM background_tracks').get().version;
  const exists = category === 'questions'
    ? db.prepare("SELECT 1 FROM questions WHERE id = ? AND state = 'published'").get(id)
    : db.prepare('SELECT 1 FROM ' + tables[category] + ' WHERE id = ?').get(id);
  return exists ? db.prepare('SELECT version FROM content_versions WHERE category = ? AND object_id = ?').get(category, id)?.version || 1 : 0;
}
function canUse(db, id, actor) {
  check(idPattern.test(id || ''), '媒体 ID 无效。');
  const row = db.prepare('SELECT published FROM media WHERE id = ?').get(id);
  const staged = db.prepare('SELECT actor FROM staged_files WHERE media_id=?').get(id);
  if (row && !row.published && staged?.actor.startsWith('chat:')) {
    const admin = actor.startsWith('admin:') && db.prepare('SELECT id FROM admins WHERE username=?').get(actor.slice(6));
    check(admin && canReadChatFile(db, 'admin:' + admin.id, id), '不能复用未加入会话的私有附件。', 403, 'media_forbidden');
  }
  check(row && (row.published || actor.startsWith('admin:') || db.prepare('SELECT 1 FROM staged_files WHERE media_id = ? AND actor = ?').get(id, actor)), '不能复用此媒体。', 403, 'media_forbidden');
  return loadMediaFile(db, id, true);
}
export function resolveFiles(db, payload, actor) {
  check(payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields), 'fields 须为对象。');
  check(payload.files == null || typeof payload.files === 'object' && !Array.isArray(payload.files), 'files 须为对象。');
  const files = {};
  let count = 0;
  for (const [name, values] of Object.entries(payload.files || {})) {
    check(Array.isArray(values), '文件引用须为数组。');
    files[name] = values.map((entry) => { count++; if (typeof entry === 'string') return canUse(db, entry, actor); check(Buffer.isBuffer(entry?.data) || isTransferred(entry), 'JSON 文件引用必须为已授权的媒体 ID。'); return entry; });
  }
  check(count <= 8, '单次保存最多包含 8 个文件。');
  return { fields: { ...payload.fields }, files };
}

export async function uploadFile(db, payload, actor, key) {
  const kind = payload.fields.kind;
  check(['image', 'audio', 'lyrics'].includes(kind) && Object.keys(payload.fields).length === 1
    && Object.keys(payload.files).length === 1 && payload.files.file?.length === 1, '请上传一个指定类型的文件。');
  const fingerprint = uploadFingerprint(payload);
  const scope = actor + ':file';
  const prior = priorResult(db, scope, key, fingerprint);
  if (prior) return prior;
  const file = payload.files.file[0];
  const prepared = kind === 'image' ? await prepareImage(file) : kind === 'audio' ? prepareAudio(file)
    : (readLyrics(file), { ...file, mime: 'text/plain; charset=utf-8' });
  return transaction(db, () => {
    const retry = priorResult(db, scope, key, fingerprint); if (retry) return retry;
    const id = privateStore(db, prepared);
    db.prepare('INSERT INTO staged_files VALUES (?, ?, ?, ?)').run(id, actor, kind, now());
    recordChange(db, actor, 'file.upload', 'media', id, '文件已上传至私有暂存，等待保存内容草稿', null);
    return saveResult(db, scope, key, fingerprint, { ...describeMedia(db, id), name: file.name, kind, status: 'uploaded' });
  });
}

function nameReference(db, kind, name, materials) {
  if (!name) return null;
  let row = db.prepare('SELECT * FROM reusable_names WHERE kind = ? AND name = ?').get(kind, name);
  const reused = Boolean(row);
  if (!row) { row = { id: newId(), name }; db.prepare('INSERT INTO reusable_names VALUES (?, ?, ?)').run(row.id, kind, name); }
  materials.push({ kind, id: row.id, name: row.name, reused });
  return row.id;
}

export function batchDetails(db, id, base = '') {
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  check(batch, '没有找到此批次。', 404, 'not_found');
  const items = db.prepare('SELECT * FROM batch_items WHERE batch_id = ? ORDER BY category, object_id').all(id).map((row) => ({
    id: row.object_id, draftId: row.draft_id, category: row.category, title: row.title, operation: row.operation,
    createdAt: batch.created_at, result: 'success', state: row.state, version: row.version,
    ...(row.state === 'synced' && paths[row.category] ? { url: base + paths[row.category] + (row.category === 'questions' ? '' : '?id=' + row.object_id) } : {}),
    materials: JSON.parse(row.materials),
  }));
  return { id, batchId: id, actor: batch.actor, createdAt: batch.created_at, syncedAt: batch.synced_at, state: batch.state,
    newItems: items.filter((item) => item.operation === 'new'), updatedItems: items.filter((item) => item.operation === 'update'),
    materials: items.flatMap((item) => item.materials) };
}

function display(db, row, config, base = '') {
  const doc = JSON.parse(row.document);
  const common = { id: row.object_id, version: row.version, draftId: row.id, batchId: row.batch_id, status: row.state, createdAt: row.created_at, demo: false };
  if (row.category === 'settings') return { ...getSite(db, config, { document: doc, version: row.version }), ...common };
  if (row.category === 'questions') {
    const question = db.prepare('SELECT * FROM questions WHERE id = ?').get(row.object_id);
    return { ...common, createdAt: question.created_at, author: question.author || '匿名', anonymous: question.author === null, question: question.question, reply: doc.reply,
      state: question.state, publishedAt: question.published_at };
  }
  const media = (key) => describeMedia(db, doc.files[key]?.[0], base);
  if (row.category === 'background') return { ...common, audio: media('audio'), volume: Number(doc.fields.volume ?? .05) };
  if (row.category === 'cats') return { ...common, image: media('image') };
  if (row.category === 'games') return { ...common, ...doc.fields, logo: media('logo'),
    images: doc.files.images.map((id) => describeMedia(db, id, base)), genreId: doc.genreId };
  const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(doc.fields.artistId);
  return { ...common, ...doc.fields, artist: artist.name, artistId: artist.id, producerId: doc.producerId,
    cover: media('cover') || describeMedia(db, artist.image_id, base), audio: media('audio'),
    lyricsFile: describeMedia(db, doc.sources?.lyricsFile, base) };
}
export function draftDetails(db, id, config, base = '') {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  check(row, '没有找到此草稿。', 404, 'not_found'); active(db, row.category, row.object_id);
  check(row.state !== 'deleted', '草稿已删除。', 410, 'content_deleted');
  return { id: row.id, objectId: row.object_id, category: row.category, version: row.version, state: row.state, actor: row.actor,
    batchId: row.batch_id, item: display(db, row, config, base), batch: batchDetails(db, row.batch_id, base) };
}
export function editItem(db, category, id, config) {
  const row = latest(db, category, id);
  if (row && row.state !== 'deleted') return display(db, row, config);
  active(db, category, id);
  if (category === 'settings') return getSite(db, config);
  if (category === 'background') { const audio = background(db); return { id: 'background', version: row?.version || canonicalVersion(db, category, id), audio, volume: audio?.volume ?? .05 }; }
  if (category === 'questions') {
    const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    return { id, version: canonicalVersion(db, category, id), question: q.question, author: q.author || '匿名', anonymous: !q.author,
      reply: q.reply || '', state: q.state, createdAt: q.created_at, publishedAt: q.published_at };
  }
  return getContent(db, category, id);
}
export function listDrafts(db, category, config, actor = null) {
  check(!category || supported.includes(category), '草稿类别无效。');
  return db.prepare("SELECT * FROM drafts WHERE state != 'deleted'" + (category ? ' AND category = ?' : '') + (actor ? ' AND actor = ?' : '') + ' ORDER BY updated_at DESC')
    .all(...(category ? [category] : []), ...(actor ? [actor] : [])).map((row) => ({ ...display(db, row, config), category: row.category, state: row.state }));
}

export async function saveContentDraft(db, config, category, incoming, actor, key, objectId = null) {
  check(supported.includes(category), '草稿类别无效。');
  objectId ||= category === 'settings' ? 'site' : category === 'background' ? 'background' : null;
  const scope = actor + ':draft:' + category + ':' + (objectId || 'new');
  const payload = resolveFiles(db, incoming, actor);
  const fingerprint = sha256(uploadFingerprint(payload) + JSON.stringify(Object.keys(payload.files).sort().map((key) => [key, payload.files[key].map((file) => file.storedId || '')])));
  const prior = priorResult(db, scope, key, fingerprint);
  if (prior) { active(db, category, prior.objectId); return prior; }
  const id = objectId || newId(); active(db, category, id);
  const old = latest(db, category, id);
  const publicVersion = canonicalVersion(db, category, id);
  const expected = old?.version ?? publicVersion;
  const requested = payload.fields.version;
  if (expected) check(Number(requested) === expected, '草稿已在另一窗口更新，请重新读取后再保存。', 409, 'draft_conflict');
  delete payload.fields.version;
  let existing;
  if (old || publicVersion || category === 'background' || category === 'questions') existing = editItem(db, category, id, config);
  let prepared, settingsChange;
  if (category === 'settings') settingsChange = await prepareSettingsChange(payload);
  else if (category === 'questions') {
    check(Object.keys(payload.fields).every((key) => key === 'reply') && !Object.keys(payload.files).length, '答复草稿字段无效。');
    prepared = { reply: cleanText(payload.fields.reply, '回复', 2400) };
  } else {
    const fields = payload.fields;
    for (const [key, kind, target] of [['producerId', 'producer', 'producer'], ['genreId', 'genre', 'genre']]) {
      if (fields[key]) { const row = db.prepare('SELECT * FROM reusable_names WHERE id = ? AND kind = ?').get(fields[key], kind); check(row, '署名或分类不存在。'); fields[target] = row.name; }
      delete fields[key];
    }
    if (fields.coverId) { check(!payload.files.cover, '已有封面和新封面请选择一种。'); payload.files.cover = [canUse(db, fields.coverId, actor)]; }
    delete fields.coverId;
    if (category === 'background' && !payload.files.audio && existing?.audio) payload.files.audio = [canUse(db, existing.audio.id, actor)];
    prepared = await prepareUpload(category, payload, existing);
  }
  return transaction(db, () => {
    const retry = priorResult(db, scope, key, fingerprint); if (retry) return retry;
    active(db, category, id);
    const current = latest(db, category, id);
    check((current?.version ?? canonicalVersion(db, category, id)) === expected, '草稿已更新，请重新读取。', 409, 'draft_conflict');
    const materials = [];
    let document;
    if (category === 'settings') {
      const baseline = old && old.state === 'draft' ? JSON.parse(old.document) : JSON.parse(db.prepare('SELECT document FROM site_settings WHERE id = 1').get().document);
      document = materializeSettings(db, settingsChange, baseline);
    } else if (category === 'questions') document = prepared;
    else if (category === 'cats') document = { fields: {}, files: { image: [prepared ? privateStore(db, prepared) : existing.image.id] } };
    else if (category === 'background') document = { fields: { volume: String(payload.fields.volume ?? existing?.volume ?? .05) }, files: { audio: [privateStore(db, prepared)] } };
    else {
      const common = { title: prepared.title, translation: prepared.translation, note: prepared.note };
      if (category === 'games') {
        document = { fields: { ...common, genre: prepared.genre, description: prepared.description },
          files: { logo: [prepared.logo ? privateStore(db, prepared.logo) : existing.logo.id], images: [...prepared.keepImages, ...prepared.images.map((file) => privateStore(db, file))] },
          genreId: nameReference(db, 'genre', prepared.genre, materials) };
      } else {
        let artistId = prepared.artistId;
        if (!artistId) {
          check(!db.prepare('SELECT 1 FROM artists WHERE name = ?').get(prepared.artistName), '该歌手已存在，请选择已有署名。', 409, 'artist_exists');
          artistId = newId();
          db.prepare('INSERT INTO artists VALUES (?, ?, ?)').run(artistId, prepared.artistName, prepared.artistImage ? privateStore(db, prepared.artistImage) : null);
          materials.push({ kind: 'artist', id: artistId, name: prepared.artistName, reused: false });
        } else {
          const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(artistId); check(artist, '歌手不存在。');
          materials.push({ kind: 'artist', id: artist.id, name: artist.name, reused: true });
        }
        document = { fields: { ...common, artistId, producer: prepared.producer, lyricist: prepared.lyricist, lyrics: prepared.lyrics },
          files: { audio: [prepared.audio ? privateStore(db, prepared.audio) : existing.audio.id] },
          producerId: nameReference(db, 'producer', prepared.producer, materials), sources: {} };
        const coverId = prepared.cover ? privateStore(db, prepared.cover) : existing?.cover?.id;
        if (coverId) { document.files.cover = [coverId]; materials.push({ kind: 'cover', id: coverId, reused: Boolean(prepared.cover?.storedId || !prepared.cover) }); }
        if (payload.files.lyricsFile) {
          const file = payload.files.lyricsFile[0]; document.sources.lyricsFile = file.storedId || privateStore(db, { ...file, mime: 'text/plain; charset=utf-8' });
        } else if (existing?.lyricsFile && existing.lyrics === prepared.lyrics) document.sources.lyricsFile = existing.lyricsFile.id;
      }
    }
    const draftId = old?.id || newId(); const batchId = newId(); const version = expected + 1; const date = now();
    function register(value) {
      if (typeof value === 'string' && idPattern.test(value)) {
        const file = db.prepare('SELECT published, mime FROM media WHERE id = ?').get(value);
        if (file && !file.published) db.prepare('INSERT INTO staged_files VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(value, actor, file.mime.startsWith('image/') ? 'image' : file.mime.startsWith('audio/') ? 'audio' : 'lyrics', date);
        if (file) db.prepare("UPDATE modification_logs SET batch_id = ? WHERE category = 'media' AND object_id = ? AND actor = ? AND batch_id IS NULL").run(batchId, value, actor);
      } else if (Array.isArray(value)) value.forEach(register);
      else if (value && typeof value === 'object') Object.values(value).forEach(register);
    }
    register(document);
    if (category === 'music') register(db.prepare('SELECT image_id FROM artists WHERE id = ?').get(document.fields.artistId)?.image_id);
    if (old?.state === 'draft') db.prepare("UPDATE batch_items SET state = 'superseded' WHERE draft_id = ? AND state = 'draft'").run(draftId);
    db.prepare('INSERT INTO batches (id,actor,created_at,state) VALUES (?, ?, ?, ?)').run(batchId, actor, date, 'draft');
    db.prepare(`INSERT INTO drafts VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      ON CONFLICT(category, object_id) DO UPDATE SET actor = excluded.actor, document = excluded.document, version = excluded.version,
      base_version = excluded.base_version, state = 'draft', batch_id = excluded.batch_id, updated_at = excluded.updated_at`)
      .run(draftId, category, id, actor, JSON.stringify(document), version, old?.state === 'draft' ? old.base_version : publicVersion, batchId, old?.created_at || date, date);
    const title = category === 'settings' ? document.name : category === 'questions' ? '提问回复' : document.fields.title || (category === 'cats' ? '猫猫图' : '背景音乐');
    db.prepare('INSERT INTO batch_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(batchId, draftId, id, category, title, publicVersion ? 'update' : 'new', version, 'draft', JSON.stringify(materials));
    recordChange(db, actor, 'draft.save', category, id, '草稿已保存，公开版本保持不变', null, batchId);
    const result = draftDetails(db, draftId, config);
    return saveResult(db, scope, key, fingerprint, result);
  });
}

function markDocumentPublic(db, document) {
  function walk(value) {
    if (typeof value === 'string' && idPattern.test(value)) db.prepare('UPDATE media SET published = 1 WHERE id = ?').run(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  }
  walk(document);
}
function absoluteResult(value, base) {
  if (!base) return value;
  const result = structuredClone(value);
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (typeof item === 'string' && ['url', 'thumbnail'].includes(key) && item.startsWith('/')) node[key] = base + item;
      else if (key === 'srcset' && typeof item === 'string') node[key] = item.split(', ').map((part) => part.startsWith('/') ? base + part : part).join(', ');
      else if (typeof item === 'object') walk(item);
    }
  }
  walk(result); return result;
}
async function prepareSync(db, config, id, version, actor, base = '') {
  const row = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  check(row, '没有找到此草稿。', 404, 'not_found'); active(db, row.category, row.object_id);
  const scope = 'sync:' + id; const retryKey = 'version_' + String(version); const fingerprint = sha256(id + ':' + String(version));
  const replay = priorResult(db, scope, retryKey, fingerprint);
  if (replay) return () => absoluteResult(replay, base);
  check(Number(version) === row.version, '仍有未保存的编辑或草稿已更新，请先保存最新内容。', 409, 'draft_conflict');
  if (row.state === 'synced') return () => draftDetails(db, id, config, base);
  check(row.state === 'draft', '草稿已删除。', 410, 'content_deleted');
  const document = JSON.parse(row.document);
  // Revalidate saved files and text before publishing, using the same rules as saves.
  const prepared = tables[row.category] || row.category === 'background'
    ? await prepareUpload(row.category, { fields: document.fields, files: Object.fromEntries(Object.entries(document.files).map(([key, ids]) => [key, ids.map((id) => loadMediaFile(db, id, true))])) }) : null;
  return () => transaction(db, () => {
    active(db, row.category, row.object_id);
    const current = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
    check(current.version === row.version, '草稿已在同步期间更新。', 409, 'draft_conflict');
    if (current.state === 'synced') return draftDetails(db, id, config, base);
    check(canonicalVersion(db, row.category, row.object_id) === row.base_version, '已同步版本发生变化，请重新读取并保存。', 409, 'published_conflict');
    const objectId = row.object_id; const category = row.category; const date = now();
    if (category === 'settings') db.prepare('UPDATE site_settings SET document = ?, version = ?, updated_at = ? WHERE id = 1').run(row.document, row.version, date);
    else if (category === 'questions') {
      const reply = cleanText(document.reply, '回复', 2400, true);
      db.prepare("UPDATE questions SET reply = ?, state = 'published', published_at = coalesce(published_at, ?) WHERE id = ?").run(reply, date, objectId);
    } else if (category === 'background') {
      db.prepare('INSERT INTO background_tracks (media_id, created_at, volume) VALUES (?, ?, ?)').run(document.files.audio[0], date, Number(document.fields.volume ?? .05));
    } else if (category === 'cats') {
      db.prepare('INSERT INTO cats VALUES (?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET image_id = excluded.image_id, demo = 0').run(objectId, document.files.image[0], date);
    } else if (category === 'games') {
      db.prepare(`INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title,
        translation = excluded.translation, genre = excluded.genre, note = excluded.note, description = excluded.description, logo_id = excluded.logo_id, demo = 0`)
        .run(objectId, prepared.title, prepared.translation, prepared.genre, prepared.note, prepared.description, document.files.logo[0], date);
      db.prepare('DELETE FROM game_images WHERE game_id = ?').run(objectId);
      document.files.images.forEach((image, index) => db.prepare('INSERT INTO game_images VALUES (?, ?, ?)').run(objectId, index, image));
    } else {
      const artist = db.prepare('SELECT * FROM artists WHERE id = ?').get(prepared.artistId); check(artist, '歌手不存在。');
      db.prepare(`INSERT INTO songs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title,
        translation = excluded.translation, artist_id = excluded.artist_id, producer = excluded.producer, lyricist = excluded.lyricist,
        note = excluded.note, lyrics = excluded.lyrics, audio_id = excluded.audio_id, cover_id = excluded.cover_id, demo = 0`)
        .run(objectId, prepared.title, prepared.translation, prepared.artistId, prepared.producer, prepared.lyricist, prepared.note,
          prepared.lyrics, document.files.audio[0], document.files.cover?.[0] || null, date);
      if (artist.image_id) db.prepare('UPDATE media SET published = 1 WHERE id = ?').run(artist.image_id);
      saveLyricsRecord(db, objectId, prepared.lyrics, document.sources?.lyricsFile);
    }
    markDocumentPublic(db, document);
    if (category !== 'settings' && category !== 'background') db.prepare('INSERT INTO content_versions VALUES (?, ?, ?) ON CONFLICT(category, object_id) DO UPDATE SET version = excluded.version').run(category, objectId, row.version);
    db.prepare("UPDATE drafts SET state = 'synced' WHERE id = ?").run(id);
    db.prepare("UPDATE batch_items SET state = 'synced' WHERE batch_id = ? AND draft_id = ?").run(row.batch_id, id);
    db.prepare("UPDATE batches SET state = 'synced', synced_at = ? WHERE id = ?").run(date, row.batch_id);
    recordChange(db, actor, 'draft.sync', category, objectId, '已将确认的草稿同步为公开版本', category, row.batch_id);
    const batch = batchDetails(db, row.batch_id);
    if (['music', 'games', 'cats'].includes(category)) db.prepare('INSERT INTO bot_events (type, batch_id, payload, created_at) VALUES (?, ?, ?, ?)').run('content.synced', row.batch_id, JSON.stringify(batch), date);
    const result = draftDetails(db, id, config);
    saveResult(db, scope, retryKey, fingerprint, result);
    return absoluteResult(result, base);
  });
}

export async function syncDraft(db, config, id, version, actor, base = '') {
  return (await prepareSync(db, config, id, version, actor, base))();
}

export async function syncAllDrafts(db, config, items, actor) {
  check(Array.isArray(items) && items.length > 0 && items.length <= 200 && new Set(items.map((item) => item.id)).size === items.length, '请选择 1 至 200 项不同草稿。');
  const operations = [];
  for (const item of items) {
    check(idPattern.test(item.id || '') && Number.isSafeInteger(item.version), '草稿标识或版本无效。');
    operations.push(await prepareSync(db, config, item.id, item.version, actor));
  }
  // Every publish, event and audit write commits together, or all roll back.
  return transaction(db, () => ({ items: operations.map((apply) => apply()) }));
}

export function publicReleases(db, limit = 8) {
  const labels = { music: '音乐', games: '游戏', cats: '猫猫图', background: '背景音乐', settings: '站点与文字', questions: '公开回信' };
  return db.prepare("SELECT * FROM batches b WHERE state = 'synced' AND EXISTS (SELECT 1 FROM batch_items i WHERE i.batch_id = b.id AND i.state = 'synced') ORDER BY synced_at DESC, id DESC LIMIT ?").all(limit).map((batch) => {
    const format = (item) => ({ id: item.id, category: item.category, title: ['questions', 'settings', 'background'].includes(item.category) ? labels[item.category] : item.title,
      ...(item.url ? { url: item.url } : {}) });
    const detail = batchDetails(db, batch.id);
    const items = [...detail.newItems, ...detail.updatedItems].filter((item) => item.state === 'synced');
    return { batchId: batch.id, publishedAt: batch.synced_at, summary: items.map((item) => (item.operation === 'new' ? '新增' : '更新') + labels[item.category]).join('、'),
      newItems: detail.newItems.filter((item) => item.state === 'synced').map(format), updatedItems: detail.updatedItems.filter((item) => item.state === 'synced').map(format) };
  });
}

export function deleteDraftObject(db, category, id, actor = 'admin:local') {
  const draft = latest(db, category, id);
  if (draft?.state === 'draft' && draft.base_version === 0 && category !== 'questions') recordChange(db, actor, 'delete', category, id, '删除尚未同步的草稿', null, draft.batch_id);
  if (category !== 'background') db.prepare('INSERT INTO deleted_objects VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(category, id, now());
  db.prepare("UPDATE drafts SET state = 'deleted' WHERE category = ? AND object_id = ?").run(category, id);
  db.prepare("UPDATE batch_items SET state = 'deleted' WHERE category = ? AND object_id = ?").run(category, id);
  db.prepare("UPDATE batches SET state = 'deleted' WHERE id IN (SELECT batch_id FROM batch_items WHERE category = ? AND object_id = ?)").run(category, id);
}

export function materialLibrary(db, kind, search = '') {
  const query = cleanText(search, '搜索', 100).toLowerCase();
  if (kind === 'artists') return getArtists(db, '', true).filter((item) => item.name.toLowerCase().includes(query));
  if (kind === 'covers') return db.prepare('SELECT id, name FROM media WHERE width IS NOT NULL AND instr(lower(name), ?) > 0 ORDER BY created_at DESC LIMIT 100').all(query)
    .map((row) => ({ ...row, image: describeMedia(db, row.id) }));
  check(['producers', 'genres'].includes(kind), '素材类别无效。');
  for (const name of (kind === 'producers' ? db.prepare("SELECT DISTINCT producer AS name FROM songs WHERE producer != ''").all() : db.prepare('SELECT DISTINCT genre AS name FROM games').all())) {
    if (!db.prepare('SELECT 1 FROM reusable_names WHERE kind = ? AND name = ?').get(kind === 'producers' ? 'producer' : 'genre', name.name)) db.prepare('INSERT INTO reusable_names VALUES (?, ?, ?)').run(newId(), kind === 'producers' ? 'producer' : 'genre', name.name);
  }
  return db.prepare('SELECT id, name FROM reusable_names WHERE kind = ? ORDER BY name').all(kind === 'producers' ? 'producer' : 'genre').filter((item) => item.name.toLowerCase().includes(query));
}

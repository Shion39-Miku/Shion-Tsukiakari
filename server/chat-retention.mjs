import { sha256, transaction } from './core.mjs';

export const chatRetentionMs = 30 * 24 * 60 * 60 * 1000;
export const retainedAfter = (clock = Date.now) => new Date(clock() - chatRetentionMs).toISOString();
export const expiredSendHash = (thread, key) => sha256(JSON.stringify([thread, key]));

// Private chat uploads are candidates. Content owned by the website or used as
// an avatar/persona asset is kept, even in legacy databases with shared media.
const protectedMedia = `
  EXISTS(SELECT 1 FROM songs WHERE audio_id=@id OR cover_id=@id)
  OR EXISTS(SELECT 1 FROM artists WHERE image_id=@id)
  OR EXISTS(SELECT 1 FROM games WHERE logo_id=@id)
  OR EXISTS(SELECT 1 FROM game_images WHERE image_id=@id)
  OR EXISTS(SELECT 1 FROM cats WHERE image_id=@id)
  OR EXISTS(SELECT 1 FROM background_tracks WHERE media_id=@id)
  OR EXISTS(SELECT 1 FROM song_lyrics WHERE original_media_id=@id)
  OR EXISTS(SELECT 1 FROM chat_profiles WHERE avatar_id=@id)
  OR EXISTS(SELECT 1 FROM chat_site_exports WHERE media_id=@id)
  OR EXISTS(SELECT 1 FROM chat_ai_agents WHERE instr(avatar_url,@id) OR instr(document,@id))
  OR EXISTS(SELECT 1 FROM chat_persona_drafts WHERE instr(document,@id))
  OR EXISTS(SELECT 1 FROM site_settings WHERE instr(document,@id))
  OR EXISTS(SELECT 1 FROM drafts WHERE state!='deleted' AND instr(document,@id))
  OR EXISTS(SELECT 1 FROM batch_items WHERE state IN ('draft','synced') AND instr(materials,@id))
  OR EXISTS(SELECT 1 FROM idempotency WHERE scope NOT LIKE '%:file' AND instr(result,@id))`;

export function pruneChatBatch(db, cutoff, batchSize = 128) {
  const messages = transaction(db, () => {
    const expired = db.prepare('SELECT id,thread_id,role,request_key FROM chat_messages WHERE created_at<=? ORDER BY created_at,id LIMIT ?').all(cutoff, batchSize);
    if (!expired.length) return 0;
    const ids = expired.map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const tombstone = db.prepare('INSERT OR IGNORE INTO chat_expired_sends VALUES(?)');
    for (const row of expired) if (row.role === 'user' && row.request_key) tombstone.run(expiredSendHash(row.thread_id, row.request_key));
    db.prepare(`UPDATE chat_threads SET title='新的夜话' WHERE id IN (
      SELECT thread_id FROM chat_generated_titles WHERE message_id IN (${placeholders}))`).run(...ids);
    db.prepare(`UPDATE chat_ai_sessions SET summary='',summary_through=0 WHERE summary<>''
      AND thread_id IN (SELECT thread_id FROM chat_messages WHERE id IN (${placeholders}))`).run(...ids);
    return db.prepare(`DELETE FROM chat_messages WHERE id IN (${placeholders})`).run(...ids).changes;
  });
  // Limit BLOB deletions per transaction. The durable queue resumes after a restart.
  const files = transaction(db, () => {
    const candidates = db.prepare(`SELECT q.media_id AS id FROM chat_expired_media q WHERE NOT EXISTS
      (SELECT 1 FROM chat_attachment_refs a WHERE a.media_id=q.media_id) LIMIT 4`).all();
    const remove = db.prepare(`DELETE FROM media WHERE id=@id AND published=0 AND NOT (${protectedMedia})`);
    for (const { id } of candidates) {
      if (remove.run({ id }).changes) db.prepare("DELETE FROM idempotency WHERE scope LIKE 'chat:%:file' AND json_extract(result,'$.id')=?").run(id);
      else if (!db.prepare('SELECT 1 FROM chat_profiles WHERE avatar_id=?').get(id)) {
        db.prepare("DELETE FROM staged_files WHERE media_id=? AND actor LIKE 'chat:%'").run(id);
      }
      db.prepare('DELETE FROM chat_expired_media WHERE media_id=?').run(id);
    }
    return candidates.length;
  });
  return { messages, files, more: messages === batchSize || files === 4 };
}

export async function pruneChat(db, { clock, keepRunning = () => true } = {}) {
  const cutoff = retainedAfter(clock);
  let messages = 0, files = 0;
  while (keepRunning()) {
    const batch = pruneChatBatch(db, cutoff);
    messages += batch.messages;
    files += batch.files;
    if (!batch.more) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  return { cutoff, messages, files };
}

export function scheduleChatPrune(db, { clock, onPruned, interval = 15 * 60_000 } = {}) {
  let stopped = false, running = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await pruneChat(db, { clock, keepRunning: () => !stopped });
      if (!stopped && result.messages) onPruned?.();
    }
    catch { console.error('聊天记录清理未完成，将在下一轮重试。'); }
    finally { running = false; }
  };
  const startup = setImmediate(run);
  const timer = setInterval(run, interval).unref();
  return () => { stopped = true; clearImmediate(startup); clearInterval(timer); };
}

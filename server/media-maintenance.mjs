import { createHash } from 'node:crypto';
import { cleanText, check, now, transaction } from './core.mjs';
import { loadMediaFile, storeMedia } from './media.mjs';
import { parseLrc } from '../public/parse-lrc.js';

export function saveLyricsRecord(db, songId, source, originalId = null) {
  const timeline = parseLrc(source);
  if (!originalId && source) originalId = storeMedia(db, { name: 'lyrics-' + songId + (timeline.length ? '.lrc' : '.txt'), mime: 'text/plain; charset=utf-8', data: Buffer.from(source, 'utf8') });
  db.prepare('INSERT INTO song_lyrics VALUES (?, ?, ?, ?) ON CONFLICT(song_id) DO UPDATE SET original_media_id=excluded.original_media_id, source_text=excluded.source_text, timeline=excluded.timeline')
    .run(songId, originalId, source, JSON.stringify(timeline));
}

export function migrateMediaMetadata(db) {
  for (const row of db.prepare('SELECT id,size FROM media WHERE sha256 IS NULL').all()) {
    const hash = createHash('sha256'); let size = 0; let expected = 0;
    for (const block of db.prepare('SELECT seq,data FROM media_chunks WHERE media_id=? ORDER BY seq').iterate(row.id)) {
      check(block.seq === expected++, '旧媒体分块顺序不完整。', 500, 'media_corrupt'); hash.update(block.data); size += block.data.length;
    }
    check(size === row.size, '旧媒体大小与元数据不一致。', 500, 'media_corrupt');
    db.prepare('UPDATE media SET sha256=? WHERE id=? AND sha256 IS NULL').run(hash.digest('hex'),row.id);
  }
  for (const song of db.prepare('SELECT id,lyrics FROM songs WHERE NOT EXISTS (SELECT 1 FROM song_lyrics WHERE song_id=songs.id)').all()) {
    let originalId;
    const draft = db.prepare("SELECT document FROM drafts WHERE category='music' AND object_id=? AND state!='deleted'").get(song.id);
    const candidate = draft && JSON.parse(draft.document).sources?.lyricsFile;
    if (candidate && db.prepare('SELECT 1 FROM media WHERE id=? AND published=1').get(candidate)) {
      const file = loadMediaFile(db,candidate);
      try { if (cleanText(new TextDecoder('utf-8',{fatal:true}).decode(file.data),'歌词',24000) === song.lyrics) originalId=candidate; } catch { /* Preserve a canonical text source if no matching original is available. */ }
    }
    transaction(db,()=>saveLyricsRecord(db,song.id,song.lyrics,originalId));
  }
}

export function verifyMedia(db) {
  const result = { media:0, bytes:0, lyrics:0, integrity:db.prepare('PRAGMA quick_check').get().quick_check };
  check(result.integrity === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0,'数据库完整性校验失败。',500);
  for (const row of db.prepare('SELECT id,size,sha256 FROM media').all()) {
    const hash=createHash('sha256'); let size=0; let seq=0;
    for (const block of db.prepare('SELECT seq,data FROM media_chunks WHERE media_id=? ORDER BY seq').iterate(row.id)) {check(block.seq === seq++,'媒体缺少分块：'+row.id,500);hash.update(block.data);size+=block.data.length;}
    check(size===row.size && hash.digest('hex')===row.sha256,'媒体校验失败：'+row.id,500);result.media++;result.bytes+=size;
  }
  for (const row of db.prepare('SELECT * FROM song_lyrics').iterate()) {check(JSON.stringify(parseLrc(row.source_text))===row.timeline,'歌词时间轴不一致。',500);if(row.source_text)check(row.original_media_id,'缺少歌词原始文本文件。',500);result.lyrics++;}
  return result;
}

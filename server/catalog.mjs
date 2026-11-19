import { check, cleanText, idPattern, newId, now, transaction } from './core.mjs';
import { describeMedia, prepareAudio, prepareImage, readLyrics, storeMedia } from './media.mjs';
import { recordChange } from './logs.mjs';

export const categories = ['music', 'games', 'cats'];

const songQuery = `SELECT s.id AS id, s.title, s.translation, s.note, s.producer, s.lyricist,
  s.audio_id, coalesce(s.cover_id, a.image_id) AS cover_id, s.demo, s.created_at,
  a.id AS artist_id, a.name AS artist FROM songs s JOIN artists a ON s.artist_id = a.id`;
const catalog = {
  music: {
    page: '/music',
    query: songQuery,
    filter: 's.artist_id = ?',
    detail: `SELECT s.lyrics, base.* FROM songs s JOIN (${songQuery}) base ON s.id = base.id WHERE s.id = ?`,
    format(db, row, base, detail, bot) {
      return {
        title: row.title, translation: row.translation, note: row.note, producer: row.producer, lyricist: row.lyricist,
        artist: row.artist, artistId: row.artist_id, cover: describeMedia(db, row.cover_id, base),
        ...(detail || bot ? { audio: describeMedia(db, row.audio_id, base) } : {}),
        ...(detail ? { lyrics: row.lyrics, lyricsSource: describeMedia(db, db.prepare('SELECT original_media_id FROM song_lyrics WHERE song_id = ?').get(row.id)?.original_media_id, base),
          timedLyrics: JSON.parse(db.prepare('SELECT timeline FROM song_lyrics WHERE song_id = ?').get(row.id)?.timeline || '[]') } : {}),
      };
    },
  },
  games: {
    page: '/games',
    query: 'SELECT id, title, translation, genre, note, logo_id, demo, created_at FROM games',
    filter: 'genre = ?',
    detail: 'SELECT * FROM games WHERE id = ?',
    format(db, row, base, detail) {
      return {
        title: row.title, translation: row.translation, genre: row.genre, note: row.note,
        logo: describeMedia(db, row.logo_id, base),
        ...(detail ? {
          description: row.description,
          images: db.prepare('SELECT image_id FROM game_images WHERE game_id = ? ORDER BY position').all(row.id)
            .map(({ image_id: id }) => describeMedia(db, id, base)),
        } : {}),
      };
    },
  },
  cats: {
    page: '/cats',
    query: 'SELECT id, image_id, demo, created_at FROM cats',
    detail: 'SELECT id, image_id, demo, created_at FROM cats WHERE id = ?',
    format(db, row, base) {
      return { image: describeMedia(db, row.image_id, base) };
    },
  },
};

function formatItem(db, category, row, { base = '', detail = false, bot = false } = {}) {
  const source = catalog[category];
  return {
    id: row.id, createdAt: row.created_at, demo: Boolean(row.demo),
    version: db.prepare('SELECT version FROM content_versions WHERE category = ? AND object_id = ?').get(category, row.id)?.version || 1,
    url: `${base}${source.page}?id=${row.id}`,
    ...source.format(db, row, base, detail, bot),
  };
}

export function listContent(db, category, { base = '', bot = false, limit = -1, offset = 0, filter = '' } = {}) {
  const source = catalog[category];
  const sql = `${source.query} ${filter && source.filter ? `WHERE ${source.filter}` : ''}
    ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  const params = filter && source.filter ? [filter, limit, offset] : [limit, offset];
  return db.prepare(sql).all(...params).map((row) => formatItem(db, category, row, { base, bot }));
}

export function getContent(db, category, id, base = '') {
  const row = catalog[category].detail && db.prepare(catalog[category].detail).get(id);
  check(row, '没有找到这条内容。', 404, 'not_found');
  return formatItem(db, category, row, { base, detail: true });
}

export function getArtists(db, base = '', includeUnused = false) {
  return db.prepare('SELECT * FROM artists ' + (includeUnused ? '' : 'WHERE EXISTS (SELECT 1 FROM songs WHERE songs.artist_id = artists.id) ') + 'ORDER BY name COLLATE NOCASE, id').all()
    .map((row) => ({ id: row.id, name: row.name, image: describeMedia(db, row.image_id, base) }));
}

export function background(db) {
  const row = db.prepare('SELECT media_id, volume FROM background_tracks ORDER BY version DESC LIMIT 1').get();
  return row ? { ...describeMedia(db, row.media_id), volume: row.volume } : null;
}

export function insertSong(db, item, demo = 0) {
  const id = newId();
  let artistId = item.artistId;
  if (!artistId) {
    check(!db.prepare('SELECT id FROM artists WHERE name = ?').get(item.artistName),
      '该歌手已存在，请选择已有歌手。', 409, 'artist_exists');
    artistId = newId();
    const imageId = item.artistImage ? storeMedia(db, item.artistImage) : null;
    db.prepare('INSERT INTO artists VALUES (?, ?, ?)').run(artistId, item.artistName, imageId);
  } else {
    check(db.prepare('SELECT id FROM artists WHERE id = ?').get(artistId), '未找到该歌手。');
  }
  const audioId = storeMedia(db, item.audio);
  const coverId = item.cover ? storeMedia(db, item.cover) : null;
  db.prepare('INSERT INTO songs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.title, item.translation, artistId, item.producer, item.lyricist, item.note,
      item.lyrics, audioId, coverId, demo, now());
  return id;
}

export function insertGame(db, item, demo = 0) {
  const id = newId();
  const logoId = storeMedia(db, item.logo);
  db.prepare('INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.title, item.translation, item.genre, item.note, item.description, logoId, demo, now());
  const insert = db.prepare('INSERT INTO game_images VALUES (?, ?, ?)');
  item.images.forEach((image, position) => insert.run(id, position, storeMedia(db, image)));
  return id;
}

export function insertCat(db, image, demo = 0, date = now()) {
  const id = newId();
  db.prepare('INSERT INTO cats VALUES (?, ?, ?, ?)').run(id, storeMedia(db, image), demo, date);
  return id;
}

export function insertBackground(db, audio) {
  const id = storeMedia(db, audio);
  db.prepare('INSERT INTO background_tracks (media_id, created_at) VALUES (?, ?)').run(id, now());
  return id;
}

function validateParts({ fields, files }, names, counts) {
  check(Object.keys(fields).every((key) => names.includes(key)), '表单包含未支持的字段。');
  for (const [key, entries] of Object.entries(files)) {
    check(Object.hasOwn(counts, key) && entries.length <= counts[key], '表单包含未支持的文件或文件过多。');
  }
}

export async function prepareUpload(category, payload, existing = null) {
  const { fields, files } = payload;
  if (category === 'cats') {
    validateParts(payload, [], { image: 1 });
    return existing && !files.image ? null : prepareImage(files.image?.[0]);
  }
  if (category === 'background') {
    validateParts(payload, ['volume'], { audio: 1 });
    check(fields.volume == null || String(fields.volume).trim() !== '' && Number.isFinite(Number(fields.volume)) && Number(fields.volume) >= 0 && Number(fields.volume) <= 1, '背景音乐音量须为 0% 至 100%。');
    return prepareAudio(files.audio?.[0]);
  }
  const text = (name, label, length, required) => cleanText(fields[name], label, length, required);
  const common = {
    title: text('title', '标题', 100, true),
    translation: text('translation', '译名', 100),
    note: text('note', '寄语', 500, true),
  };
  if (category === 'music') {
    validateParts(payload, ['title', 'translation', 'note', 'artistId', 'artistName', 'producer', 'lyricist', 'lyrics'],
      { audio: 1, cover: 1, artistImage: 1, lyricsFile: 1 });
    const artistId = text('artistId', '歌手 ID', 36);
    const artistName = text('artistName', '新歌手名', 80);
    check(artistId ? idPattern.test(artistId) && !artistName && !files.artistImage : artistName,
      '请选择已有歌手，或填写新歌手名和可选歌手图片。');
    const rawLyrics = text('lyrics', '歌词', 24_000);
    check(!files.lyricsFile || !rawLyrics, '歌词请在文件和文本中任选一种方式填写。');
    const lyrics = files.lyricsFile ? cleanText(readLyrics(files.lyricsFile[0]), '歌词', 24_000) : Object.hasOwn(fields, 'lyrics') ? rawLyrics : existing?.lyrics || '';
    const audio = existing && !files.audio ? null : prepareAudio(files.audio?.[0]);
    const [cover, artistImage] = await Promise.all([
      files.cover ? prepareImage(files.cover[0]) : null,
      files.artistImage ? prepareImage(files.artistImage[0]) : null,
    ]);
    return {
      ...common, artistId, artistName, lyrics, audio, cover, artistImage,
      producer: text('producer', 'P 主', 80),
      lyricist: text('lyricist', '作词', 80),
    };
  }
  validateParts(payload, ['title', 'translation', 'genre', 'note', 'description', ...(existing ? ['keepImages'] : [])], { logo: 1, images: 5 });
  const genre = text('genre', '游戏类型', 48, true);
  const description = text('description', '游戏介绍', 6000, true);
  let keepImages = [];
  if (existing) {
    try { keepImages = JSON.parse(fields.keepImages || JSON.stringify(existing.images.map((image) => image.id))); } catch { check(false, '保留图片列表无效。'); }
    check(Array.isArray(keepImages) && new Set(keepImages).size === keepImages.length
      && keepImages.every((id) => existing.images.some((image) => image.id === id)), '保留图片列表无效。');
  }
  check((files.images?.length || 0) + keepImages.length >= 1 && (files.images?.length || 0) + keepImages.length <= 5, '游戏介绍图须为 1 至 5 张。');
  const logo = existing && !files.logo ? null : await prepareImage(files.logo?.[0]);
  const images = [];
  for (const file of files.images || []) images.push(await prepareImage(file));
  return { ...common, genre, description, logo, images, keepImages };
}

export function deleteContent(db, category, id, actor) {
  return transaction(db, () => {
    const tables = { music: 'songs', games: 'games', cats: 'cats' };
    const result = db.prepare('DELETE FROM ' + tables[category] + ' WHERE id = ?').run(id);
    if (result.changes) recordChange(db, actor, 'delete', category, id, '删除已发布的收藏');
    return { id, deleted: true };
  });
}

export function deleteBackground(db, actor) {
  return transaction(db, () => {
    if (db.prepare('DELETE FROM background_tracks').run().changes) recordChange(db, actor, 'delete', 'background', '', '移除当前背景音乐');
    return { deleted: true };
  });
}

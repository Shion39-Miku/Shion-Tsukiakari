import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { createWriteStream, openSync, readSync, closeSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import Busboy from 'busboy';
import sharp from 'sharp';
import { check, newId, now, Problem, sha256, transaction } from './core.mjs';

export const MiB = 1024 * 1024;
export const chunkSize = 256 * 1024;
export const audioLimit = 100_000_000;
const imageLimit = 8 * MiB;
export const uploadLimit = 150_000_000;
const transferred = new WeakSet();
export const isTransferred = (file) => transferred.has(file);
const lyricLimit = 64 * 1024;

async function readBody(req, limit) {
  const tooLarge = () => new Problem(413, 'too_large', '请求内容超过大小限制。', { Connection: 'close' });
  if (Number(req.headers['content-length']) > limit) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export async function readJson(req, limit = 16 * 1024) {
  check(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''),
    '请使用 application/json。', 415, 'unsupported_type');
  const body = await readBody(req, limit);
  let result;
  try {
    result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new Problem(400, 'invalid_json', '请求内容不是有效的 UTF-8 JSON。');
  }
  check(result && typeof result === 'object' && !Array.isArray(result), '请提交 JSON 对象。');
  return result;
}

export async function cleanupUpload(req) {
  const directory = req.moonlitUploadDirectory;
  if (!directory) return;
  req.moonlitUploadDirectory = null;
  if (dirname(directory) !== resolve(process.env.UPLOAD_TEMP_DIR || tmpdir()) || !directory.split(/[\\/]/).at(-1).startsWith('moonlit-upload-')) throw new Error('临时目录越界');
  await rm(directory, { recursive: true, force: true });
}
export async function readUpload(req) {
  check(/^multipart\/form-data\s*;/i.test(req.headers['content-type'] || ''), '请选择 multipart/form-data 上传。', 415, 'unsupported_type');
  check(!(Number(req.headers['content-length']) > uploadLimit), '上传请求超过 150,000,000 字节；请分文件上传。', 413, 'too_large');
  let parser;
  try { parser = Busboy({ headers: req.headers, defParamCharset: 'utf8', limits: { files: 8, fields: 16, parts: 25, fileSize: audioLimit + 1, fieldSize: 100 * 1024 } }); }
  catch { throw new Problem(400, 'invalid_multipart', '上传请求的分隔符无效。'); }
  const directory = await mkdtemp(join(resolve(process.env.UPLOAD_TEMP_DIR || tmpdir()), 'moonlit-upload-')); req.moonlitUploadDirectory = directory;
  const fields = Object.create(null); const files = Object.create(null); const jobs = [];
  let failure; let fileIndex = 0;
  const tooLarge = () => { failure ||= new Problem(413, 'too_large', '单个音频最大为 100,000,000 字节；文件、字段或请求大小超过限制。'); };
  for (const event of ['filesLimit','fieldsLimit','partsLimit']) parser.on(event, tooLarge);
  parser.on('field', (key, value, info) => { if (info.valueTruncated || info.nameTruncated) tooLarge(); if (key in fields) failure ||= new Problem(400, 'invalid_multipart', '表单字段重复。'); fields[key] = value; });
  parser.on('file', (key, stream, info) => {
    const entries = files[key] ??= []; const position = entries.length; entries.push(null);
    const path = join(directory, String(fileIndex++)); const hash = createHash('sha256'); let size = 0;
    stream.on('limit', tooLarge);
    const tap = new Transform({ transform(chunk, _encoding, done) { size += chunk.length; hash.update(chunk); done(null, chunk); } });
    const job = pipeline(stream, tap, createWriteStream(path, { mode: 0o600, flags: 'wx' })).then(async () => {
      if (!info.filename && !size) return;
      if (size > audioLimit) tooLarge();
      const file = { name: (info.filename || 'file').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180), path, size, checksum: hash.digest('hex') };
      if (size <= imageLimit) file.data = await readFile(path);
      transferred.add(file); entries[position] = file;
    }).catch((error) => { failure ||= error instanceof Problem ? error : new Problem(400, 'invalid_multipart', '上传文件不完整或临时空间不足。'); });
    jobs.push(job);
  });
  let received = 0;
  const counter = new Transform({ transform(chunk, _encoding, done) { received += chunk.length; done(received > uploadLimit ? new Problem(413, 'too_large', '上传请求超过 150,000,000 字节；请分文件上传。') : null, chunk); } });
  try { await pipeline(req, counter, parser); await Promise.all(jobs); if (failure) throw failure;
    return { fields, files: Object.fromEntries(Object.entries(files).map(([key, values]) => [key, values.filter(Boolean)]).filter(([, values]) => values.length)) }; }
  catch (error) { await Promise.all(jobs); await cleanupUpload(req); throw error instanceof Problem ? error : new Problem(400, 'invalid_multipart', '上传表单不完整。'); }
}

export function uploadFingerprint({ fields, files }) {
  const text = Object.keys(fields).sort().map((key) => [key, fields[key]]);
  const binary = Object.keys(files).sort().map((key) => [
    key, files[key].map((file) => [file.name, file.checksum || sha256(file.data)]),
  ]);
  return sha256(JSON.stringify([text, binary]));
}

function requireFile(file, limit, label) {
  check(file && (file.size ?? file.data?.length), `请选择${label}。`);
  check((file.size ?? file.data.length) <= limit, `${label}超过大小限制。`, 413, 'too_large');
  return file;
}

export async function prepareImage(file) {
  const { name, data } = requireFile(file, imageLimit, '图片（最大 8 MiB）');
  check(Buffer.isBuffer(data), '图片超过大小限制。', 413, 'too_large');
  if (file.storedId && file.width && file.mime?.startsWith('image/')) return file;
  let mime;
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) mime = 'image/jpeg';
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') mime = 'image/webp';
  check(mime, '图片格式须为 JPEG、PNG 或静态 WebP。', 415, 'unsupported_type');
  try {
    const image = sharp(data, { limitInputPixels: 24_000_000, failOn: 'warning' });
    const meta = await image.metadata();
    check((meta.pages ?? 1) === 1 && meta.width && meta.height, '请选择静态图片。');
    const thumb = await image.autoOrient().resize(480, 480, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 }).toBuffer();
    const { width, height } = meta.autoOrient || meta;
    const previews = [];
    for (const size of [...new Set([320, 480, 800, 1200, 1600, 2400].map((size) => Math.min(size, width)))]) {
      previews.push({ width: size, data: await sharp(data).autoOrient().resize(size, undefined, { withoutEnlargement: true }).webp({ quality: 90 }).toBuffer() });
    }
    return { name, mime, data, width, height, thumb, previews, storedId: file.storedId };
  } catch {
    throw new Problem(415, 'invalid_image', '图片无法解码、含动画或超过 2400 万像素。');
  }
}

function validWave(data, totalSize = data.length, readAt = null) {
  if (data.length < 44 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE') {
    return false;
  }
  const end = data.readUInt32LE(4) + 8;
  if (end > totalSize) return false;
  let format = false;
  let samples = false;
  for (let start = 12, count = 0; start + 8 <= end && count < 4096; count++) {
    const header = start + 24 <= data.length ? data.subarray(start, start + 24) : readAt?.(start, 24);
    if (!header || header.length < 8) return false;
    const id = header.toString('latin1', 0, 4);
    const size = header.readUInt32LE(4);
    const offset = start + 8;
    if (offset + size > end) return false;
    if (id === 'fmt ' && size >= 16) {
      if (header.length < 24) return false;
      const codec = header.readUInt16LE(8);
      const channels = header.readUInt16LE(10);
      const sampleRate = header.readUInt32LE(12);
      const bits = header.readUInt16LE(22);
      format = (codec === 1 && [8, 16, 24, 32].includes(bits) || codec === 3 && [32, 64].includes(bits))
        && channels >= 1 && channels <= 8 && sampleRate >= 8000 && sampleRate <= 192000;
    }
    if (id === 'data' && size > 0) samples = true;
    if (format && samples) return true;
    start = offset + size + (size % 2);
  }
  return false;
}

function validMp3(data, totalSize = data.length, readAt = null) {
  let offset = 0;
  if (data.toString('latin1', 0, 3) === 'ID3') {
    if (data.length < 10 || data.subarray(6, 10).some((byte) => byte >= 128)) return false;
    offset = 10 + data.subarray(6, 10).reduce((size, byte) => (size << 7) | byte, 0);
    if (data[3] === 4 && (data[5] & 0x10)) offset += 10;
  }
  if (offset + 24 > totalSize) return false;
  const frame = offset + 24 <= data.length ? data.subarray(offset) : readAt?.(offset, 2048);
  if (!frame || frame[0] !== 0xff || frame.length < 24) return false;
  const second = frame[1];
  const third = frame[2];
  const version = (second >> 3) & 3;
  const bitrate = third >> 4;
  const sampleRate = (third >> 2) & 3;
  if ((second & 0xe6) !== 0xe2 || version === 1 || bitrate === 0 || bitrate === 15 || sampleRate === 3) return false;
  const rates = version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const frequency = [44100, 48000, 32000][sampleRate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const frameSize = Math.floor((version === 3 ? 144000 : 72000) * rates[bitrate] / frequency) + ((third >> 1) & 1);
  return totalSize >= offset + frameSize;
}

function validOgg(data) {
  if (data.length < 64 || data.toString('latin1', 0, 4) !== 'OggS' || data[4] !== 0 || !(data[5] & 2)) return false;
  const offset = 27 + data[26];
  if (!data[26] || offset >= data.length) return false;
  const pageSize = data.subarray(27, offset).reduce((length, segment) => length + segment, 0);
  if (offset + pageSize > data.length) return false;
  return data[27] >= 19 && data.toString('latin1', offset, offset + 8) === 'OpusHead'
    || data[27] >= 30 && data.toString('latin1', offset, offset + 7) === '\u0001vorbis';
}

export function prepareAudio(file) {
  requireFile(file, audioLimit, '音频（最大 100,000,000 字节）');
  if (file.trustedReference && file.storedId && file.checksum && ['audio/wav','audio/mpeg','audio/ogg'].includes(file.mime)) return file;
  let fd;
  try {
    const readAt = file.path && isTransferred(file) ? (offset, length) => { fd ??= openSync(file.path, 'r'); const buffer = Buffer.alloc(length); return buffer.subarray(0, readSync(fd, buffer, 0, length, offset)); } : null;
    const data = file.data || readAt?.(0, 65536); check(Buffer.isBuffer(data), '请选择有效的音频文件。');
    const size = file.size ?? data.length;
    const mime = validWave(data, size, readAt) ? 'audio/wav' : validMp3(data, size, readAt) ? 'audio/mpeg' : validOgg(data) ? 'audio/ogg' : null;
    check(mime, '请上传有效的 MP3、PCM WAV 或 Ogg 音频。', 415, 'unsupported_type');
    const prepared = { ...file, mime }; if (isTransferred(file)) transferred.add(prepared); return prepared;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readLyrics(file) {
  const { data } = requireFile(file, lyricLimit, '歌词文件（最大 64 KiB）');
  check(/\.(?:lrc|txt)$/i.test(file.name), '歌词文件须为 .lrc 或 .txt。', 415, 'unsupported_type');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Problem(415, 'invalid_lyrics', '歌词文件须使用 UTF-8 编码。');
  }
}

export function storeMedia(db, file, { published = true } = {}) {
  const { name, mime, data, width = null, height = null, thumb = null, previews = [], storedId } = file;
  if (storedId) { check(db.prepare('SELECT 1 FROM media WHERE id = ?').get(storedId), '引用的媒体已不存在。', 409, 'media_missing'); return storedId; }
  const size = file.size ?? data?.length;
  check(size > 0 && (Buffer.isBuffer(data) || isTransferred(file)), '媒体来源无效。');
  const id = newId(); const checksum = file.checksum || sha256(data);
  db.prepare('INSERT INTO media (id,name,mime,size,width,height,thumb,created_at,published,preview_version,sha256) VALUES (?,?,?,?,?,?,?,?,?,2,?)').run(id,name,mime,size,width,height,thumb,now(),published ? 1 : 0,checksum);
  const insert = db.prepare('INSERT INTO media_chunks VALUES (?, ?, ?)');
  if (data) for (let offset = 0, seq = 0; offset < data.length; offset += chunkSize, seq++) insert.run(id,seq,data.subarray(offset,offset+chunkSize));
  else {
    const fd = openSync(file.path, 'r'); const buffer = Buffer.alloc(chunkSize);
    try { for (let offset = 0, seq = 0; offset < size; seq++) { const count = readSync(fd,buffer,0,Math.min(chunkSize,size-offset),offset); check(count > 0, '临时文件不完整。'); insert.run(id,seq,buffer.subarray(0,count)); offset += count; } }
    finally { closeSync(fd); }
  }
  for (const preview of previews) db.prepare('INSERT INTO media_previews VALUES (?, ?, ?)').run(id, preview.width, preview.data);
  return id;
}

export function loadMediaFile(db, id, reference = false) {
  const row = db.prepare('SELECT name, mime, size, width, height, sha256 AS checksum FROM media WHERE id = ?').get(id);
  check(row, '没有找到引用的媒体。', 404, 'media_missing');
  if (reference && row.checksum && row.mime.startsWith('audio/')) return { ...row, storedId: id, trustedReference: true };
  return { ...row, storedId: id, data: Buffer.concat(db.prepare('SELECT data FROM media_chunks WHERE media_id = ? ORDER BY seq').all(id).map((row) => row.data)) };
}

export async function regeneratePreviews(db, all = false) {
  const rows = db.prepare('SELECT id, preview_version FROM media WHERE width IS NOT NULL' + (all ? '' : ' AND preview_version < 2')).all();
  for (const row of rows) {
    const prepared = await prepareImage({ ...loadMediaFile(db, row.id), storedId: undefined });
    transaction(db, () => {
      db.prepare('DELETE FROM media_previews WHERE media_id = ?').run(row.id);
      for (const preview of prepared.previews) db.prepare('INSERT INTO media_previews VALUES (?, ?, ?)').run(row.id, preview.width, preview.data);
      db.prepare('UPDATE media SET thumb = ?, preview_version = ? WHERE id = ?').run(prepared.thumb, Math.max(2, row.preview_version + 1), row.id);
    });
  }
  return rows.length;
}

export function describeMedia(db, id, base = '') {
  if (!id) return null;
  const row = db.prepare('SELECT id, mime, size, width, height, preview_version, sha256 FROM media WHERE id = ?').get(id);
  if (!row) return null;
  const url = `${base}/media/${row.id}`;
  const version = row.id + '-p' + row.preview_version;
  const previews = row.width ? db.prepare('SELECT width FROM media_previews WHERE media_id = ? ORDER BY width').all(id)
    .map(({ width }) => ({ width, url: url + '/preview/' + width + '?v=' + row.preview_version })) : [];
  return { ...row, version, url, thumbnail: row.width ? `${url}/thumb?v=${row.preview_version}` : null, previews,
    srcset: previews.map((item) => item.url + ' ' + item.width + 'w').join(', ') };
}

function getRange(range, size) {
  const matches = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!matches || (!matches[1] && !matches[2])) return null;
  if (!matches[1]) {
    const suffix = Number(matches[2]);
    return suffix > 0 ? [Math.max(0, size - suffix), size - 1] : null;
  }
  const start = Number(matches[1]);
  const end = matches[2] ? Math.min(size - 1, Number(matches[2])) : size - 1;
  return start < size && start <= end ? [start, end] : null;
}

export async function sendMedia(db, req, res, id, thumbnail, privateAccess = false) {
  const meta = db.prepare('SELECT mime, size, length(thumb) AS thumb_size, preview_version, published FROM media WHERE id = ?').get(id);
  const variant = typeof thumbnail === 'number' && db.prepare('SELECT length(data) AS size FROM media_previews WHERE media_id = ? AND width = ?').get(id, thumbnail);
  if (typeof thumbnail === 'number') check(variant, '没有找到此尺寸预览。', 404, 'not_found');
  check(meta && (!thumbnail || meta.thumb_size), '没有找到媒体。', 404, 'not_found');
  const size = variant ? variant.size : thumbnail ? meta.thumb_size : meta.size;
  const etag = `"${id}${thumbnail ? '-p' + meta.preview_version + '-' + thumbnail : ''}"`;
  const headers = {
    'Content-Type': thumbnail ? 'image/webp' : meta.mime,
    'Cache-Control': meta.published && !privateAccess ? 'public, max-age=31536000, immutable' : 'private, no-store',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  if (req.headers['if-none-match']?.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*')) {
    res.writeHead(304, headers).end();
    return;
  }
  const useRange = req.headers.range && (!req.headers['if-range'] || req.headers['if-range'] === etag);
  const range = useRange ? getRange(req.headers.range, size) : [0, size - 1];
  if (!range) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }).end();
    return;
  }
  const [start, end] = range;
  headers['Content-Length'] = end - start + 1;
  if (useRange) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(useRange ? 206 : 200, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else if (variant) {
    const { data } = db.prepare('SELECT substr(data, ?, ?) AS data FROM media_previews WHERE media_id = ? AND width = ?').get(start + 1, end - start + 1, id, thumbnail);
    res.end(data);
  } else if (thumbnail) {
    const { data } = db.prepare('SELECT substr(thumb, ?, ?) AS data FROM media WHERE id = ?').get(start + 1, end - start + 1, id);
    res.end(data);
  } else {
    const statement = db.prepare('SELECT data FROM media_chunks WHERE media_id = ? AND seq = ?');
    function* blocks() {
      for (let seq = Math.floor(start / chunkSize); seq <= Math.floor(end / chunkSize); seq += 1) {
        const { data } = statement.get(id, seq);
        yield data.subarray(Math.max(0, start - seq * chunkSize), end - seq * chunkSize + 1);
      }
    }
    await pipeline(Readable.from(blocks()), res);
  }
}

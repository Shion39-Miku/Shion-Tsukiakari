// Local-only, bounded metadata readers. No file is sent while parsing.
const decoder = new TextDecoder('utf-8');
const ascii = (bytes) => new TextDecoder('latin1').decode(bytes);
const syncSafe = (bytes) => bytes.reduce((n, byte) => (n << 7) | (byte & 127), 0);
function text(bytes) {
  if (!bytes.length) return '';
  const encoding = bytes[0]; const data = bytes.subarray(1);
  try {
    if (encoding === 0) return ascii(data).replace(/\0+$/g, '').trim();
    if (encoding === 2) return new TextDecoder('utf-16be').decode(data).replace(/\0+$/g, '').trim();
    if (encoding === 1) return new TextDecoder(data[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(data).replace(/^\uFEFF/, '').replace(/\0+$/g, '').trim();
    return decoder.decode(data).replace(/\0+$/g, '').trim();
  } catch { return ''; }
}
function explicitProducer(key) { return /^(?:P\s*主|VOCALOID[_ -]?P|NICONICO[_ -]?P|VOCALOID PRODUCER)$/i.test(key.trim()); }
export function readLrcTags(source) {
  const value = (key) => new RegExp('^\\s*\\[' + key + ':([^\\]]*)\\]', 'im').exec(source)?.[1].trim() || '';
  return { title: value('ti'), artist: value('ar'), producer: value('vocaloid_p') || value('P主'), source: 'LRC 标题／歌手标签' };
}
export async function readAudioTags(file) {
  if (file.size > 100_000_000) throw new Error('音频超过 100 MB（100,000,000 字节）。');
  const bytes = new Uint8Array(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = { title: '', artist: '', producer: '', source: '' };
  if (ascii(bytes.subarray(0, 3)) === 'ID3' && bytes.length >= 10) {
    const version = bytes[3]; const end = Math.min(bytes.length, syncSafe(bytes.subarray(6, 10)) + 10, 2 * 1024 * 1024);
    let offset = 10;
    if (bytes[5] & 0x40 && offset + 4 < end) offset += version === 4 ? syncSafe(bytes.subarray(offset, offset + 4)) : view.getUint32(offset) + 4;
    for (let count = 0; offset + 10 <= end && count < 256; count++) {
      const id = ascii(bytes.subarray(offset, offset + 4)); if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = version === 4 ? syncSafe(bytes.subarray(offset + 4, offset + 8)) : view.getUint32(offset + 4);
      if (!size || offset + 10 + size > end) break;
      const data = bytes.subarray(offset + 10, offset + 10 + size);
      if (id === 'TIT2') result.title = text(data);
      if (id === 'TPE1') result.artist = text(data).replaceAll('\0', ' / ');
      if (id === 'TXXX') {
        const decoded = text(data); const split = decoded.indexOf('\0');
        if (split > 0 && explicitProducer(decoded.slice(0, split))) result.producer = decoded.slice(split + 1).trim();
      }
      offset += 10 + size;
    }
    result.source = 'ID3 音频标签';
  }
  const tail = file.size > bytes.length ? new Uint8Array(await file.slice(-128).arrayBuffer()) : bytes.subarray(-128);
  if (!result.title && tail.length >= 128 && ascii(tail.subarray(0, 3)) === 'TAG') {
    result.title = ascii(tail.subarray(3, 33)).replace(/\0+$/g, '').trim();
    result.artist ||= ascii(tail.subarray(33, 63)).replace(/\0+$/g, '').trim(); result.source = 'ID3v1 音频标签';
  }
  if (ascii(bytes.subarray(0, 4)) === 'RIFF' && ascii(bytes.subarray(8, 12)) === 'WAVE') {
    if (file.size > bytes.length) {
      for (let offset = 12, count = 0; offset + 8 < file.size && count < 4096; count++) {
        const header = new Uint8Array(await file.slice(offset, offset + 12).arrayBuffer());
        if (header.length < 12) break;
        const length = new DataView(header.buffer).getUint32(4, true);
        if (ascii(header.subarray(0, 4)) === 'LIST' && ascii(header.subarray(8, 12)) === 'INFO' && length <= 256 * 1024) {
          const info = new Uint8Array(await file.slice(offset + 12, offset + 8 + length).arrayBuffer()); const tags = new DataView(info.buffer);
          for (let cursor = 0; cursor + 8 <= info.length;) {
            const id = ascii(info.subarray(cursor, cursor + 4)); const size = tags.getUint32(cursor + 4, true); if (cursor + 8 + size > info.length) break;
            const value = decoder.decode(info.subarray(cursor + 8, cursor + 8 + size)).replace(/\0+$/g, '').trim();
            if (id === 'INAM') result.title = value; if (id === 'IART') result.artist = value; cursor += 8 + size + size % 2;
          }
          result.source = 'WAV INFO 标签';
        }
        const next = offset + 8 + length + length % 2; if (next <= offset || next > file.size) break; offset = next;
      }
    }
    for (let offset = 12, count = 0; offset + 8 < bytes.length && count < 4096; count++) {
      const kind = ascii(bytes.subarray(offset, offset + 4)); const size = view.getUint32(offset + 4, true); const end = Math.min(bytes.length, offset + 8 + size);
      if (kind === 'LIST' && ascii(bytes.subarray(offset + 8, offset + 12)) === 'INFO') {
        for (let cursor = offset + 12; cursor + 8 <= end;) {
          const id = ascii(bytes.subarray(cursor, cursor + 4)); const length = view.getUint32(cursor + 4, true);
          if (cursor + 8 + length > end) break;
          const value = decoder.decode(bytes.subarray(cursor + 8, cursor + 8 + length)).replace(/\0+$/g, '').trim();
          if (id === 'INAM') result.title = value; if (id === 'IART') result.artist = value;
          cursor += 8 + length + length % 2;
        }
        result.source = 'WAV INFO 标签';
      }
      if (end <= offset) break; offset = end + size % 2;
    }
  }
  if (ascii(bytes.subarray(0, 4)) === 'OggS') {
    const scan = ascii(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)));
    const opus = scan.indexOf('OpusTags'); const vorbis = scan.indexOf('\x03vorbis');
    let cursor = opus >= 0 ? opus + 8 : vorbis >= 0 ? vorbis + 7 : -1;
    if (cursor >= 0 && cursor + 4 < bytes.length) {
      cursor += 4 + view.getUint32(cursor, true);
      if (cursor + 4 < bytes.length) {
        const count = Math.min(256, view.getUint32(cursor, true)); cursor += 4;
        for (let i = 0; i < count && cursor + 4 < bytes.length; i++) {
          const size = view.getUint32(cursor, true); cursor += 4; if (cursor + size > bytes.length || size > 65536) break;
          const tag = decoder.decode(bytes.subarray(cursor, cursor + size)); cursor += size;
          const at = tag.indexOf('='); const key = tag.slice(0, at); const value = tag.slice(at + 1);
          if (key.toUpperCase() === 'TITLE') result.title = value;
          if (key.toUpperCase() === 'ARTIST') result.artist = value;
          if (explicitProducer(key)) result.producer = value;
        }
        result.source = 'Ogg 注释标签';
      }
    }
  }
  for (const key of ['title', 'artist', 'producer']) result[key] = result[key].slice(0, key === 'title' ? 100 : 80);
  result.fallbackTitle = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
  return result;
}

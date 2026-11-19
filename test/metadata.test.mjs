import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAudioTags, readLrcTags } from '../public/metadata.js';
import { demoWave } from '../server/demo.mjs';

function tag(id, value, encoding = 3) {
  const body = Buffer.concat([Buffer.from([encoding]), encoding === 1 ? Buffer.concat([Buffer.from([255, 254]), Buffer.from(value, 'utf16le')]) : Buffer.from(value)]);
  const header = Buffer.alloc(10); header.write(id); header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]);
}
function id3(frames) {
  const body = Buffer.concat(frames); const header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i++) header[9 - i] = (body.length >> (i * 7)) & 127;
  return new File([header, body], '备用文件名.mp3');
}
test('local metadata preserves Chinese tags and identifies P only from explicit tags', async () => {
  const result = await readAudioTags(id3([tag('TIT2', '银白的旋律', 1), tag('TPE1', '原有歌手'), tag('TPE2', '不能推断为 P 主'), tag('TXXX', 'VOCALOID_P\0明确的 P 主')]));
  assert.equal(result.title, '银白的旋律'); assert.equal(result.artist, '原有歌手'); assert.equal(result.producer, '明确的 P 主');
  assert.equal((await readAudioTags(id3([tag('TXXX', 'PRODUCER\0录音制作人'), tag('TPE1', '名字含P也不能推断')]))).producer, '');
  const fallback = await readAudioTags(new File([demoWave(1)], '文件名备用.wav'));
  assert.equal(fallback.title, ''); assert.equal(fallback.fallbackTitle, '文件名备用');
  assert.deepEqual(readLrcTags('[ti:歌词标题]\n[ar:歌手署名]\n[by:歌词上传者P]\n[p:其他标签]'), { title: '歌词标题', artist: '歌手署名', producer: '', source: 'LRC 标题／歌手标签' });
});

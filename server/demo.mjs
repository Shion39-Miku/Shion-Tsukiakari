import sharp from 'sharp';
import { newId, now, transaction } from './core.mjs';
import { insertBackground, insertCat, insertGame, insertSong } from './catalog.mjs';
import { prepareImage } from './media.mjs';

const TAU = 2 * Math.PI;
const pitch = (semitones) => 220 * 2 ** (semitones / 12);

// A short, original synthesized tune. No third-party music or remote requests.
export function demoWave(seconds = 40, mode = 0) {
  const rate = 24000;
  const count = Math.round(rate * seconds);
  const out = Buffer.alloc(44 + 2 * count);
  out.write('RIFF', 0);
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(count * 2, 40);
  const melodies = [
    [0, 7, 12, 14, 10, 5, 9, 12, 0, 7, 15, 14, 5, 9, 7, 2],
    [3, 10, 15, 19, 5, 12, 17, 15, 0, 7, 14, 12, 2, 7, 10, 7],
    [-12, 0, 7, 12, -8, 4, 7, 11, -7, 0, 5, 9, -10, 2, 5, 7],
  ][mode].map(pitch);
  const beat = mode === 2 ? 1.25 : 0.8;
  const voice = (frequency, t) => Math.sin(TAU * frequency * t + 0.16 * Math.sin(TAU * 2 * frequency * t)) * 0.72
    + Math.sin(TAU * frequency * 2 * t) * 0.20 + Math.sin(TAU * frequency * 3 * t) * 0.08;
  for (let frame = 0; frame < count; frame += 1) {
    const t = frame / rate;
    const step = Math.floor(t / beat);
    const age = t - step * beat;
    const current = melodies[step % melodies.length];
    const previous = melodies[(step + melodies.length - 1) % melodies.length];
    const bell = voice(current, age) * Math.min(1, age / 0.035) * Math.exp(-age * 2.8);
    const tail = voice(previous, age + beat) * Math.exp(-(age + beat) * 2.8) * 0.55;
    const drone = (Math.sin(TAU * 55 * t) + 0.4 * Math.sin(TAU * 82.5 * t)) * (0.6 + 0.4 * Math.cos(TAU * t / 8));
    const envelope = Math.min(1, t / 0.65, (seconds - t) / 0.65);
    const sample = (bell * 0.22 + tail * 0.17 + drone * 0.035) * envelope;
    out.writeInt16LE(Math.round(sample * 32767), 44 + 2 * frame);
  }
  return out;
}

const wave = (name, length, mode) => ({ name, data: demoWave(length, mode), mime: 'audio/wav' });

function drawSky({ sky = '#24213e', accent = '#d5b5d4', moonX = 410, moonY = 183, stars = 28 } = {}) {
  const dots = Array.from({ length: stars }, (_, i) =>
    `<circle cx="${(i * 107 + 23) % 730}" cy="${(i * 71 + 12) % 440}" r="${i % 5 ? 1.4 : 2.7}" opacity="${0.3 + i % 7 / 10}"/>`).join('');
  return `<defs>
    <linearGradient id="sky" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#0f1227"/><stop offset="1" stop-color="${sky}"/></linearGradient>
    <radialGradient id="halo"><stop stop-color="${accent}" stop-opacity=".38"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    <linearGradient id="moon" x1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#ffedf4"/><stop offset="1" stop-color="${accent}"/></linearGradient>
    </defs><rect width="720" height="600" fill="url(#sky)"/>
    <g fill="#eee0ef">${dots}</g><circle cx="${moonX}" cy="${moonY}" r="145" fill="url(#halo)"/>
    <circle cx="${moonX}" cy="${moonY}" r="55" fill="url(#moon)"/>
    <circle cx="${moonX - 15}" cy="${moonY + 8}" r="14" fill="#b39abd" opacity=".21"/>`;
}

const tides = `<path d="M0 352L103 283L169 311L271 232L338 315L436 267L562 319L720 261V600H0Z" fill="#252743"/>
  <path d="M0 371L108 331L244 360L341 316L461 362L559 328L720 377V600H0Z" fill="#15182c"/>
  <path d="M0 396H720V600H0Z" fill="#20233e"/>
  <g stroke="#d0b4d5" stroke-linecap="round" opacity=".58">
    <path d="M342 411h133m-90 15h143m-206 23h99m37 1h97m-193 29h173m-154 31h180m-228 38h188"/>
    <path opacity=".38" d="M48 442h65m41 24h140m324-34h63m-110 56h71M25 516h106m24 28h117m316-4h67"/></g>`;

const station = `<path d="M0 354h720v246H0z" fill="#1c2037"/>
  <path d="M57 395l274-83h220l121 83z" fill="#111426" stroke="#8b7796" stroke-width="5"/>
  <path d="M134 395v107m431-107v107" stroke="#625873" stroke-width="9"/>
  <path d="M332 400h146v60H332z" fill="#ceb0bf" stroke="#3a324d" stroke-width="8"/>
  <path d="M366 422h78m-62 15h45" stroke="#5c4667" stroke-width="6"/>
  <path d="M0 504h720v96H0z" fill="#111424"/><path d="M0 523h720m-720 47h720" stroke="#524a66" stroke-width="5"/>
  <path d="M180 600l15-74m135 74l4-74m137 74l-9-74m135 74l-26-74" stroke="#444158" stroke-width="6"/>
  <path d="M105 492h510" stroke="#c398a9" stroke-width="4" stroke-dasharray="21 11"/>`;

const forest = `<path d="M0 382L148 286L252 363L396 250L560 367L720 275V600H0Z" fill="#243747"/>
  <path d="M0 430L96 340L224 416L360 321L533 389L720 310V600H0Z" fill="#1b2d3b"/>
  <path d="M0 467L176 420L398 449L612 407L720 431V600H0Z" fill="#15222e"/>
  <path d="M256 600q21-93 120-156 38-20 53-36-12 27-40 55-59 59-47 137z" fill="#42616b" opacity=".63"/>
  <g fill="#101a24"><path d="M52 316l-46 118h92zm60 18l-29 92h58zm493-45l-48 149h96zm66 37l-42 133h84z"/></g>
  <g fill="#e3c8b8"><circle cx="360" cy="495" r="5"/><circle cx="426" cy="432" r="3"/><circle cx="292" cy="554" r="4"/></g>`;

function catDrawing(index) {
  const palettes = [
    ['#443453', '#e6ccb8', '#d6a2b2', '#aa708c'],
    ['#2b3b53', '#a5a6b9', '#e2b6c7', '#667186'],
    ['#4b3045', '#e0ad89', '#f3ced2', '#b58182'],
    ['#333655', '#8586ad', '#c7abd4', '#796385'],
    ['#283e48', '#dacfc9', '#d4b6be', '#657d85'],
    ['#4d3b59', '#dfc3bd', '#efccd8', '#926d99'],
  ];
  const [sky, fur, blush, ground] = palettes[index];
  const eyes = index % 3 === 0
    ? '<path d="M-83-2q18 22 36 0m94 0q18 22 36 0" fill="none" stroke="#382940" stroke-width="7" stroke-linecap="round"/>'
    : '<g fill="#342940"><ellipse cx="-64" cy="1" rx="11" ry="17"/><ellipse cx="64" cy="1" rx="11" ry="17"/></g><g fill="#fff0ef"><circle cx="-67" cy="-5" r="3"/><circle cx="61" cy="-5" r="3"/></g>';
  const markings = index === 4 ? '<path d="M-137-33q57 21 72-63-57-2-72 63zm225-33q-30 47 48 56l-12-41z" fill="#8d8595" opacity=".75"/>'
    : '<path d="M-33-91q5 28 22 36m11-42v39m33-33q-5 28-22 36" fill="none" stroke="#342940" stroke-width="8" stroke-linecap="round" opacity=".20"/>';
  return `${drawSky({ sky, accent: blush, moonX: index % 2 ? 157 : 562, moonY: 143 })}
    <path d="M0 441Q174 386 353 438T720 421V600H0Z" fill="${ground}" opacity=".49"/>
    <ellipse cx="360" cy="513" rx="232" ry="43" fill="#161323" opacity=".63"/>
    <g transform="translate(${index % 2 ? 380 : 350} 369) rotate(${index % 2 ? 8 : -6})">
      <path d="M104 112q163 11 101-102" stroke="${fur}" stroke-width="30" fill="none" stroke-linecap="round"/>
      <ellipse cx="5" cy="83" rx="137" ry="67" fill="${fur}"/>
      <path d="M-129-19l-2-115q0-23 15-11l75 60q40-18 82 0l75-60q15-12 15 11l-2 115q24 108-129 112-153-4-129-112Z" fill="${fur}" stroke="#382940" stroke-width="6"/>
      <path d="M-109-119l48 40-47 27zm218 0L61-79l47 27z" fill="${blush}" opacity=".76"/>
      ${markings}${eyes}
      <ellipse cx="-90" cy="31" rx="23" ry="10" fill="${blush}"/><ellipse cx="90" cy="31" rx="23" ry="10" fill="${blush}"/>
      <path d="M-12 25q12-7 24 0L0 35Z" fill="#6f4e68"/><path d="M0 33v7m0 0q-10 14-24 2m24-2q10 14 24 2" stroke="#6f4e68" stroke-width="4" fill="none" stroke-linecap="round"/>
      <path d="M-104 31l-53-13m54 26-57 6m264-19 53-13m-54 26 57 6" fill="none" stroke="#766077" stroke-width="4" stroke-linecap="round"/>
      <ellipse cx="-58" cy="106" rx="41" ry="18" fill="${fur}" stroke="#4d3a51" stroke-width="3"/>
      <ellipse cx="58" cy="106" rx="41" ry="18" fill="${fur}" stroke="#4d3a51" stroke-width="3"/>
    </g>`;
}

async function picture(name, svg) {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="600" viewBox="0 0 720 600">${svg}</svg>`;
  const data = await sharp(Buffer.from(markup)).webp({ quality: 87 }).toBuffer();
  return prepareImage({ name: `${name}.webp`, data });
}

export async function seedDemo(db) {
  const alreadySeeded = () => db.prepare("SELECT 1 FROM app_flags WHERE key = 'demo_v1'").get();
  if (alreadySeeded()) return false;
  const [sea, fog, stationLogo, stationScene, forestLogo, forestScene, ...cats] = await Promise.all([
    picture('潮汐尽头', drawSky({ sky: '#453a5d' }) + tides),
    picture('凌晨四点', drawSky({ sky: '#30445c', moonX: 237, accent: '#a7c9e4' }) + tides),
    picture('月台拾光', drawSky({ sky: '#564159', moonX: 360, moonY: 167 }) + station),
    picture('夜班月台', drawSky({ sky: '#4d455b', moonX: 535 }) + station),
    picture('微光林径', drawSky({ sky: '#294852', moonX: 336, accent: '#abded6' }) + forest),
    picture('蓝雾森林', drawSky({ sky: '#314751', moonX: 482, accent: '#c0dae4' }) + forest),
    ...Array.from({ length: 6 }, (_, i) => picture(`演示猫猫-${i + 1}`, catDrawing(i))),
  ]);
  const songs = [
    {
      title: '凌晨四点', translation: 'Four in the Morning', artistName: '纸灯',
      artistImage: fog, producer: '纸灯 P', lyricist: '', audio: wave('凌晨四点.wav', 36, 1),
      note: '天亮前的那一小段蓝色，适合一个人慢慢走。',
      lyrics: '天还没有亮。\n灯在玻璃上，照出另一个房间。\n如果今天太长，就把剩下的留给明天。',
    },
    {
      title: '潮汐尽头', translation: 'Where the Tide Ends', artistName: '雾岛声像',
      artistImage: sea, producer: '雾岛 P', lyricist: '演示文案', audio: wave('潮汐尽头.wav', 44, 0),
      note: '把耳机留给夜晚的最后一站。像是潮水退去之后，终于听见自己。',
      lyrics: '[00:00.00]潮汐尽头 · 演示歌词\n[00:04.00]等浪花退去，月亮落在手心\n[00:10.00]远处的灯一盏一盏熄灭\n[00:17.00]海把我的名字轻声念了一遍\n[00:24.00]我把无处安放的信折给夜色\n[00:32.00]在潮汐尽头，听见自己的回声\n[00:39.00]慢慢走吧，月亮还在',
    },
  ];
  const ambience = wave('花笺夜色.wav', 20, 2);
  return transaction(db, () => {
    if (alreadySeeded()) return false;
    for (const song of songs) insertSong(db, song, 1);
    insertGame(db, {
      title: '微光林径', translation: 'Glimmer Trail', genre: '探索解谜',
      note: '每一盏小灯，都通向一段被遗忘的路。',
      description: '演示游戏设定。一座被雾包住的森林，几块刻着记号的石头，还有一条时隐时现的溪流。跟着萤火往前，把迷路者留下的灯一点一点点亮。',
      logo: forestLogo, images: [forestScene, forestLogo],
    }, 1);
    insertGame(db, {
      title: '月台拾光', translation: 'Fragments at Platform Nine', genre: '剧情冒险',
      note: '最后一班列车还没有来。就再陪这座城市一会儿吧。',
      description: '演示游戏设定。你在深夜走进一座空无一人的车站。在每个站台捡回一片乘客遗失的记忆，拼出同一晚的不同版本。列车到达时，可以选择要带走哪一封信。',
      logo: stationLogo, images: [stationScene, stationLogo],
    }, 1);
    cats.forEach((image, i) => insertCat(db, image, 1, new Date(Date.now() - i * 86400000).toISOString()));
    if (!db.prepare('SELECT 1 FROM background_tracks LIMIT 1').get()) insertBackground(db, ambience);
    const insert = db.prepare("INSERT INTO questions VALUES (?, ?, ?, ?, 'published', ?, ?)");
    const date = now();
    insert.run(newId(), '演示 · 晚灯', '想把什么留在这个小站里？',
      '一些夜深以后还想再听一遍的歌。还有路过这里的人，偶尔留下的一句话。', date, date);
    insert.run(newId(), '演示 · 月台旅客', '这封信会飘到哪里？',
      '落在月光照到的那一页。谢谢你把这一点心事交给这里。', date, date);
    db.prepare("INSERT INTO app_flags VALUES ('demo_v1', ?)").run(now());
    return true;
  });
}

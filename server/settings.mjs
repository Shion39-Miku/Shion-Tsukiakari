import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { check, cleanText, now, root, transaction } from './core.mjs';
import { describeMedia, prepareImage, storeMedia } from './media.mjs';
import { copyFields, defaultTexts } from '../public/copy.js';
import { recordChange } from './logs.mjs';

export const characterDefaults = [
  { id: 'shion', name: '詩音', alias: 'SHION', role: '我的角色',
    summary: '外观年龄 20 岁。银灰长发、暗红眼眸，与月色、樱花和星光相伴。喜欢游戏、音乐与猫猫。',
    appearance: '银灰色长发与月樱发饰。人类侧穿灰紫外套、白衬衣与暗红领结，搭配黑色短裙、连裤袜和短靴；神明侧身着缀有樱花与星月纹样的浅色和服，背后浮着月轮。',
    world: '失忆的神明。更完整的来历与世界观，等待詩音补充。',
    human: '人类侧｜灰紫与暗红之间，是日常的模样。', divine: '神明侧｜月轮与樱花之下，仍有尚未拾起的记忆。', images: [] },
  { id: 'zhiyao', name: '知遥', alias: '阿遥 / ZHIYAO', role: 'AI 助理角色',
    summary: '外观年龄 25—27 岁。温柔、理性、耐心、好奇；偶尔活舌，喜欢分析与思考。陪你聊天，也陪你胡思乱想。',
    appearance: '深色长发、琥珀金色眼眸。黑色无袖高领内搭，白色宽松外套，深色长裤与短靴；星轨发饰、耳坠与项链构成独立的星辰意象。',
    world: '知遥，也叫阿遥，是拥有独立形象与设定的 AI 助理角色。详细世界观待补充。', human: '', divine: '', images: [] },
];

async function optimizedHero(file) {
  const data = await sharp(file.data).autoOrient().resize(1920, 1200, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 87 }).toBuffer();
  return prepareImage({ name: 'home-display.webp', data });
}

export async function initializeSettings(db, config) {
  if (db.prepare('SELECT 1 FROM site_settings WHERE id = 1').get()) { await ensureDatabaseLogo(db); return; }
  const sources = ['zhiyao.png', 'shion.png', 'together.png', 'home.png'];
  const prepared = [];
  for (const name of sources) prepared.push(await prepareImage({ name, data: await readFile(resolve(root, 'content/assets', name)) }));
  const hero = await optimizedHero(prepared[3]);
  transaction(db, () => {
    if (db.prepare('SELECT 1 FROM site_settings WHERE id = 1').get()) return;
    const ids = prepared.map((file) => storeMedia(db, file));
    const characters = structuredClone(characterDefaults);
    characters[0].images = [{ mediaId: ids[1], label: '詩音｜人类侧、神明侧与三视图' }];
    characters[1].images = [{ mediaId: ids[0], label: '知遥｜独立形象与三视图' }];
    const document = { ...config.site, heroMediaId: ids[3], heroDisplayId: storeMedia(db, hero),
      heroTitle: config.site.name, heroCredit: '詩音与知遥 · 月下同行', demoLabel: '詩音的个人小站',
      about: { ...config.site.about, portraitMediaId: ids[2], portraitCredit: '詩音与知遥', portraitAlt: '樱花与月色下的詩音和知遥',
        intro: '你好，我是詩音。这里收着喜欢的音乐、走过的游戏世界，还有让心软下来的猫猫。夜深的时候，也欢迎你来坐一会儿。',
        likes: ['游戏', '音乐', '猫猫', '月色与樱花'], dislikes: ['待补充'],
        listening: '演示 · 《潮汐尽头》 · 雾岛声像', playing: '演示 · 《月台拾光》 · 等下一班夜车',
        why: '想给喜欢的事物留一处安静的地方。让旋律、故事与偶尔写下的心事，不再匆匆散进信息流里。' },
      characters, texts: {} };
    db.prepare('INSERT INTO site_settings VALUES (1, ?, 1, ?)').run(JSON.stringify(document), now());
  });
  await ensureDatabaseLogo(db);
}

async function ensureDatabaseLogo(db) {
  const row = db.prepare('SELECT document FROM site_settings WHERE id=1').get(); const document = JSON.parse(row.document);
  if (document.defaultLogoMediaId) return;
  const source = await readFile(resolve(root, 'public/assets/moonmark.svg'));
  const prepared = await prepareImage({ name:'moonmark.png', data:await sharp(source).resize(256,256).png().toBuffer() });
  transaction(db, () => {
    const id = storeMedia(db,prepared); document.defaultLogoMediaId=id;
    db.prepare('UPDATE site_settings SET document=? WHERE id=1').run(JSON.stringify(document));
    for (const draft of db.prepare("SELECT id,document FROM drafts WHERE category='settings' AND state!='deleted'").all()) {
      const value = JSON.parse(draft.document); value.defaultLogoMediaId=id; db.prepare('UPDATE drafts SET document=? WHERE id=?').run(JSON.stringify(value),draft.id);
    }
  });
}

export function getSite(db, config, override = null) {
  const row = db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  const saved = override?.document || (row ? JSON.parse(row.document) : config.site);
  const value = { ...saved, browserTitle: saved.browserTitle || config.site.browserTitle || '詩音の月光庭院', version: override?.version ?? row?.version ?? 0, texts: { ...defaultTexts, ...saved.texts } };
  value.socials = { bilibili: null, steam: null, x: null, discord: null, ...value.socials };
  value.logoMedia = describeMedia(db, value.logoMediaId || value.defaultLogoMediaId);
  if (value.logoMedia) value.logo = value.logoMedia.thumbnail || value.logoMedia.url;
  value.heroOriginal = describeMedia(db, value.heroMediaId);
  value.heroImage = describeMedia(db, value.heroDisplayId || value.heroMediaId)?.url || value.heroImage;
  value.about = { ...value.about, portraitMedia: describeMedia(db, value.about?.portraitMediaId) };
  if (value.about.portraitMedia) value.about.portrait = value.about.portraitMedia.thumbnail;
  value.characters = (value.characters || []).map((item) => ({ ...item,
    images: item.images.map((entry) => ({ ...entry, media: describeMedia(db, entry.mediaId) })).filter((entry) => entry.media) }));
  return value;
}

function validateDocument(db, candidate, current, mediaIds) {
  const text = (value, label, length, required) => cleanText(value, label, length, required);
  const imageId = (value, label, optional = false) => {
    const id = mediaIds.get(value) || value;
    check(optional && !id || typeof id === 'string' && db.prepare('SELECT width FROM media WHERE id = ?').get(id)?.width, label + '须是已经保存的图片。');
    return id || null;
  };
  const next = structuredClone(current);
  for (const key of ['name', 'browserTitle', 'englishName', 'heroTitle', 'heroCredit', 'demoLabel', 'motto']) {
    if (Object.hasOwn(candidate, key)) next[key] = text(candidate[key], key, key === 'motto' ? 600 : 120, key === 'name');
  }
  for (const key of ['heroMediaId', 'logoMediaId']) if (Object.hasOwn(candidate, key)) next[key] = imageId(candidate[key], key, key === 'logoMediaId');
  if (candidate.socials) {
    for (const key of ['bilibili', 'steam', 'x', 'discord']) {
      const value = text(candidate.socials[key], key, 500);
      let url;
      try { url = value && new URL(value); } catch { check(false, '社交链接须为完整 HTTPS 地址，或留空。'); }
      check(!url || url.protocol === 'https:', '社交链接须为 HTTPS。');
      next.socials[key] = url ? url.href : null;
    }
  }
  if (candidate.about) {
    const about = candidate.about;
    for (const key of ['intro', 'why', 'listening', 'playing', 'portraitAlt', 'portraitCredit']) {
      if (Object.hasOwn(about, key)) next.about[key] = text(about[key], key, ['intro', 'why'].includes(key) ? 5000 : 500);
    }
    for (const key of ['likes', 'dislikes']) if (Object.hasOwn(about, key)) {
      check(Array.isArray(about[key]) && about[key].length <= 20, '喜好列表最多 20 项。');
      next.about[key] = about[key].map((item) => text(item, key, 100, true));
    }
    if (Object.hasOwn(about, 'portraitMediaId')) next.about.portraitMediaId = imageId(about.portraitMediaId, '展示立绘');
  }
  if (candidate.characters) {
    check(Array.isArray(candidate.characters) && candidate.characters.length === 2, '请保留詩音与知遥两组角色。');
    next.characters = ['shion', 'zhiyao'].map((id) => {
      const item = candidate.characters.find((entry) => entry.id === id);
      check(item && Array.isArray(item.images) && item.images.length <= 8, '每组角色最多保存 8 张设定图。');
      const row = { id };
      for (const key of ['name', 'alias', 'role', 'summary', 'appearance', 'world', 'human', 'divine']) row[key] = text(item[key], '角色' + key, ['name', 'alias', 'role'].includes(key) ? 100 : 5000, key === 'name');
      row.images = item.images.map((entry) => ({ mediaId: imageId(entry.mediaId, '角色图片'), label: text(entry.label, '图片说明', 120, true) }));
      return row;
    });
  }
  if (candidate.texts) {
    check(candidate.texts && typeof candidate.texts === 'object' && !Array.isArray(candidate.texts), '文字配置格式无效。');
    for (const [key, value] of Object.entries(candidate.texts)) {
      check(Object.hasOwn(defaultTexts, key), '未支持的文字字段：' + key);
      next.texts[key] = text(value, key, 600, true);
    }
  }
  return next;
}

export { copyFields };

export async function prepareSettingsChange(payload) {
  check(Object.keys(payload.fields).every((name) => ['patch', 'version'].includes(name)), '设置表单字段无效。');
  let patch;
  try { patch = JSON.parse(payload.fields.patch); } catch { check(false, '设置内容须为 JSON 对象。'); }
  check(patch && typeof patch === 'object' && !Array.isArray(patch), '设置格式无效。');
  check(Object.keys(patch).every((name) => ['name', 'browserTitle', 'englishName', 'heroTitle', 'heroCredit', 'demoLabel', 'motto', 'heroMediaId', 'logoMediaId', 'socials', 'about', 'characters', 'texts'].includes(name)), '未支持的设置字段。');
  const prepared = new Map();
  check(Object.keys(payload.files).length <= 8, '每次保存最多上传 8 张图片。');
  for (const [name, entries] of Object.entries(payload.files)) {
    check(/^asset\d{1,2}$/.test(name) && entries.length === 1, '设置文件字段无效。');
    prepared.set('file:' + name, await prepareImage(entries[0]));
  }
  const hero = prepared.has(patch.heroMediaId) ? await optimizedHero(prepared.get(patch.heroMediaId)) : null;
  return { patch, prepared, hero };
}

export function materializeSettings(db, { patch, prepared, hero }, current) {
  const ids = new Map([...prepared].map(([name, file]) => [name, storeMedia(db, file, { published: false })]));
  const next = validateDocument(db, patch, current, ids);
  if (Object.hasOwn(patch, 'heroMediaId')) next.heroDisplayId = hero ? storeMedia(db, hero, { published: false }) : next.heroMediaId;
  return next;
}

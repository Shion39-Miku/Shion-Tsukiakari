import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(process.argv[2] || join(root, 'android/app/build/generated/tsukiakari'));
const web = join(out, 'assets', 'web');
const drawable = join(out, 'res', 'drawable-nodpi');
const raw = join(out, 'res', 'raw');
await Promise.all([web, drawable, raw, join(web, 'assets/brand')].map(path => mkdir(path, { recursive: true })));

const sources = [
  'styles.css', 'admin.css', 'chat.css', 'chat-social.css', 'tsukiakari.css', 'ui-dialog.css', 'chat-android.css',
  'chat.js', 'chat-library.js', 'chat-render.js', 'chat-social.js', 'chat-pages.js', 'chat-android.js', 'chat-android-drafts.js',
  'chat-contacts.js', 'ui.js', 'ui-dialog.js', 'copy.js', 'activity.js', 'player.js', 'lyrics.js', 'parse-lrc.js', 'request-signal.js',
  'admin.js', 'workroom.js', 'uploads.js', 'draft-controls.js', 'materials.js', 'metadata.js',
];
await Promise.all(sources.map(file => copyFile(join(root, 'public', file), join(web, file))));
const seed = { site: { title: '詩音の月光庭院', name: '詩音の月光庭院', motto: '让相逢，留在星光里。', heroImage: '/assets/moonlake.webp', logo: '/assets/moonmark.svg', texts: {} } };
const html = await readFile(join(root, 'public/chat.html'), 'utf8');
await writeFile(join(web, 'chat.html'), html.replace(/^  <link rel="manifest"[^>]+>\r?\n/m, '')
  .replace('<!--PAGE_DATA-->', JSON.stringify(seed).replaceAll('<', '\\u003c')));
for (const path of ['assets/moonlake.webp', 'assets/moonmark.svg', 'assets/message.wav', ...[32, 64, 192, 512].map(size => `assets/brand/tsukiakari-${size}.png`)]) {
  await copyFile(join(root, 'public', path), join(web, path));
}
const brand = join(root, 'public/assets/brand/tsukiakari-512.png');
await Promise.all([
  sharp(brand).resize(256).png().toFile(join(drawable, 'brand_art.png')),
  sharp(join(root, 'content/assets/together.png')).resize({ width: 760, withoutEnlargement: true }).webp({ quality: 82 }).toFile(join(web, 'assets/farewell.webp')),
  copyFile(join(root, 'public/assets/message.wav'), join(raw, 'message.wav')),
]);
console.log('已准备安卓内置界面与品牌资源。');

import { backup, DatabaseSync } from 'node:sqlite';
import { copyFile, cp, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import {createApplication} from '../server/app.mjs';
import {copyProductionDependencies} from './copy-dependencies.mjs';
import { root, readConfig, sha256 } from '../server/core.mjs';

export async function prepareDesktop({ sharedChat = false } = {}) {
  const desktop = join(root, 'desktop'), output = join(desktop, '.generated');
  const backend = join(output, 'backend'); await mkdir(backend, {recursive:true});
  const [dialog, dialogCss, preload] = await Promise.all([
    readFile(join(root, 'public/ui-dialog.js'), 'utf8'),
    readFile(join(root, 'public/ui-dialog.css'), 'utf8'),
    readFile(join(desktop, 'preload.cjs'), 'utf8'),
  ]);
  await writeFile(join(output, 'window-preload.cjs'), "'use strict';\n" + dialog + '\nconst nativePromptStyles = ' + JSON.stringify(dialogCss) + ';\n' + preload);
  for (const name of ['server','public','migrations','content','site.json']) await cp(join(root,name),join(backend,name),{recursive:true});
  await mkdir(join(backend,'runtime'),{recursive:true});await copyFile(process.execPath,join(backend,'runtime','node.exe'));
  const bundledLicense = join(desktop, 'licenses', 'node-' + process.version + '.txt');
  const licenseTarget = join(backend, 'runtime', 'NODE-LICENSE.txt');
  // The pinned runtime's upstream license travels with the source for repeatable offline builds.
  if (existsSync(bundledLicense)) await copyFile(bundledLicense, licenseTarget);
  else {
    const license = await fetch('https://raw.githubusercontent.com/nodejs/node/' + process.version + '/LICENSE', { signal: AbortSignal.timeout(25000) });
    if (!license.ok) throw Error('无法取得当前 Node 运行时许可证，请使用项目固定的 Node 版本。');
    await writeFile(licenseTarget, await license.text());
  }
  await copyProductionDependencies(join(backend,'node_modules'));
  await writeFile(join(backend,'package.json'),JSON.stringify({private:true,type:'module'}));
  await copyFile(join(desktop, 'backend.mjs'), join(backend, 'desktop-backend.mjs'));
  await mkdir(join(output, 'seed'), { recursive: true });
  // Public packages always start from a clean generated database, never a user profile.
  const source=join(output,'seed','clean-'+Date.now()+'.sqlite');
  const seed=await createApplication({...readConfig({envFile:false}),dbPath:source,seedDemo:true,ipGeoEnabled:false,disableChat:true,astrbot:{},chat:{},websiteUrl:''});
  await new Promise(done=>seed.listen(0,'127.0.0.1',done));await new Promise(done=>seed.close(done));
  const database=new DatabaseSync(source,{readOnly:true});let info;try{for(const name of ['moonlit.sqlite','website.sqlite']){const temp=join(output,'seed',name+'.new');await backup(database,temp);await rename(temp,join(output,'seed',name));}info={media:database.prepare('SELECT count(*) AS files,coalesce(sum(size),0) AS bytes FROM media').get(),migrations:database.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,adminAccounts:database.prepare('SELECT count(*) AS n FROM admins').get().n};}finally{database.close();}
  await writeFile(join(output,'initial-model.json'),'{}');await writeFile(join(output,'initial-astrbot.json'),'{}');
  const { origin } = JSON.parse(await readFile(join(root, 'deploy/chat-public.json'), 'utf8'));
  await writeFile(join(output, 'chat-public.json'), JSON.stringify({ origin, sharedChat }));
  await copyFile(join(root,'public/assets/brand/tsukiakari-512.png'),join(desktop,'icon.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256], entries = [];
  for (const size of sizes) entries.push(await sharp(join(desktop, 'icon.png')).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6 + entries.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  for (let i = 0; i < entries.length; i++) { const at = 6 + i * 16; header[at] = header[at + 1] = sizes[i] === 256 ? 0 : sizes[i]; header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6); header.writeUInt32LE(entries[i].length, at + 8); header.writeUInt32LE(offset, at + 12); offset += entries[i].length; }
  await writeFile(join(desktop, 'icon.ico'), Buffer.concat([header, ...entries]));
  const report = { at: new Date().toISOString(), sourceDatabase: source, ...info, seedSha256: sha256(await readFile(join(output, 'seed/moonlit.sqlite'))), credentialsBundled: false };
  await writeFile(join(output, 'preparation.json'), JSON.stringify(report, null, 2));
  return { desktop, output, report };
}

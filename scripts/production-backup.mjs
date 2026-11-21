import { backup, DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, readConfig, root } from '../server/core.mjs';
import { verifyMedia } from '../server/media-maintenance.mjs';
import { pruneChat } from '../server/chat-retention.mjs';

const chatBackup = process.env.SERVICE_MODE === 'chat';
const base=resolve(process.env.BACKUP_DIR || (chatBackup ? '/var/lib/moonlit-chat-backups' : '/www/backup/moonlit'));
const prefix = chatBackup ? 'moonlit-chat-' : 'moonlit-';
const keep=Math.max(2,Math.min(30,Number(process.env.BACKUP_KEEP_COUNT)||3));
const keepDays = chatBackup ? Math.max(1, Math.min(7, Number(process.env.BACKUP_KEEP_DAYS) || 3)) : null;
const parse=(name,fallback)=>{const items=JSON.parse(process.env[name]||JSON.stringify(fallback));if(!Array.isArray(items)||items.some(p=>typeof p!=='string'||!isAbsolute(p)))throw new Error(name+'须为绝对路径的JSON数组');return items;};
const botPaths=parse('BOT_BACKUP_DIRS',[]);
const configPaths=parse('CONFIG_BACKUP_PATHS', chatBackup ? [] : ['/etc/moonlit','/etc/systemd/system/moonlit.service','/etc/systemd/system/moonlit-backup.service','/etc/systemd/system/moonlit-backup.timer','/www/server/panel/vhost/nginx/shion.wiki.conf']);
await mkdir(base,{recursive:true,mode:0o700});await chmod(base,0o700);
const directory=join(base,prefix+new Date().toISOString().replaceAll(':','-'));
await mkdir(directory,{mode:0o700});
const source=new DatabaseSync(readConfig().dbPath,{readOnly:true});
let temporary, completed = false;
try {
 const size=source.prepare('PRAGMA page_count').get().page_count*source.prepare('PRAGMA page_size').get().page_size;
 const space=await statfs(base);if(space.bavail*space.bsize<size*3+128*1024*1024)throw new Error('备份空间不足，原数据库与已有备份保持不变');
 await backup(source,join(directory,'database.sqlite'));
 if (chatBackup) {
  const snapshot = openDatabase(join(directory,'database.sqlite'));
  try { snapshot.exec('PRAGMA secure_delete = ON'); await pruneChat(snapshot); snapshot.exec('DELETE FROM chat_sessions; DELETE FROM sessions; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)'); }
  finally { snapshot.close(); }
 }
 const archivePaths=[];
 for(const path of [...new Set([...botPaths,...configPaths,...(chatBackup?[]:[root])])]){try{await stat(path);archivePaths.push(path);}catch{if(botPaths.includes(path))throw new Error('配置的Bot备份目录不存在：'+path);}}
 if(archivePaths.length){const result=spawnSync('python3',['scripts/archive-backup.py',join(directory,'config-and-bot.tgz'),JSON.stringify(archivePaths)],{encoding:'utf8',timeout:600000,maxBuffer:2*1024*1024});if(result.status!==0)throw new Error('Bot与配置归档失败：'+String(result.stderr||result.error?.message||'').slice(-300));}
 temporary=await mkdtemp(join(process.env.UPLOAD_TEMP_DIR || tmpdir(),'moonlit-restore-'));
 await cp(join(directory,'database.sqlite'),join(temporary,'restored.sqlite'));
 const restored=new DatabaseSync(join(temporary,'restored.sqlite'),{readOnly:true});let verified;
 try{verified=verifyMedia(restored);}finally{restored.close();}
 const hash=createHash('sha256'); for await (const block of createReadStream(join(directory,'database.sqlite'))) hash.update(block); const checksum=hash.digest('hex');
 const manifest={createdAt:new Date().toISOString(),verified,dbSha256:checksum,botPaths,configPaths:archivePaths.filter(p=>!botPaths.includes(p)),restoreVerified:true};
 await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});await writeFile(join(directory,'.complete'),'verified\n',{mode:0o600});
 completed = true;
 const complete=[];
 for(const name of await readdir(base)){if(!name.startsWith(prefix)||!/^\d{4}-\d{2}-\d{2}T[\d.-]+Z$/.test(name.slice(prefix.length)))continue;try{await stat(join(base,name,'.complete'));complete.push(name);}catch{}}
 complete.sort().reverse();
 const olderThan = keepDays && prefix + new Date(Date.now() - keepDays * 86400_000).toISOString().replaceAll(':','-');
 const expired = complete.filter((name,index) => index >= keep || olderThan && name < olderThan);
 for(const name of expired){const path=resolve(base,name);if(relative(base,path)!==name||!name.startsWith(prefix))throw new Error('备份清理路径越界');await rm(path,{recursive:true,force:true});}
 console.log(JSON.stringify({directory,restoreVerified:true,media:verified.media,bytes:verified.bytes,botDirectories:botPaths.length,retained:complete.length-expired.length}));
}finally{
 source.close();
 if(temporary){const parent=resolve(process.env.UPLOAD_TEMP_DIR || tmpdir());const name=relative(parent,temporary);if(name.startsWith('moonlit-restore-')&&!name.includes('..')&&!name.includes('/')&&!name.includes('\\'))await rm(temporary,{recursive:true,force:true});}
 if(!completed && relative(base,directory).startsWith(prefix)) await rm(directory,{recursive:true,force:true});
}

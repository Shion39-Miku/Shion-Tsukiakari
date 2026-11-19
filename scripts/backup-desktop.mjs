import {backup,DatabaseSync} from 'node:sqlite';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
const source=process.env.TSUKIAKARI_DESKTOP_DATA||process.env.HOSHIFURU_DESKTOP_DATA||join(process.env.APPDATA,existsSync(join(process.env.APPDATA,'HoshifuruYoruNi'))?'HoshifuruYoruNi':'Tsukiakari');
const destination=resolve(process.argv[2]||join('backups','desktop-'+new Date().toISOString().replaceAll(':','-')));
await mkdir(dirname(destination),{recursive:true});await mkdir(destination,{recursive:false});const files=[];
for(const name of['moonlit.sqlite','chat.sqlite','website.sqlite']){
 const path=join(source,'data',name);if(!existsSync(path))continue;const db=new DatabaseSync(path,{readOnly:true});try{await backup(db,join(destination,name));const check=new DatabaseSync(join(destination,name),{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('数据库备份校验失败');}finally{check.close();}files.push(name);}finally{db.close();}
}
for(const name of['desktop-settings.json','model-credentials.json','connection-credentials.json'])if(existsSync(join(source,name))){await copyFile(join(source,name),join(destination,name));files.push(name);}
await writeFile(join(destination,'manifest.json'),JSON.stringify({at:new Date().toISOString(),source,files,integrity:'ok',privateAstrbotConfig:'back up separately in a restricted location'},null,2));
console.log(JSON.stringify({destination,files,integrity:'ok'}));

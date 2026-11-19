import { mkdir, readFile, readdir, cp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { root } from '../server/core.mjs';
const output=resolve(root,'dist');
// This is a generated, explicitly bounded directory; never remove application data.
if(relative(root,output)!=='dist') throw new Error('构建目录越界');
await mkdir(output,{recursive:true});
for(const entry of await readdir(output)) await rm(join(output,entry),{recursive:true,force:true});
for(const name of ['server','public','migrations','content','bot','deploy','scripts','desktop','package.json','pnpm-lock.yaml','site.json','README.md','.env.example','docs','启动网站.cmd','启动Tsukiakari.cmd']) await cp(resolve(root,name),resolve(output,name),{recursive:true,filter:path=>!path.split(/[\\/]/).some(part=>['__pycache__','node_modules','.generated'].includes(part))});
for(const name of ['启动网站.cmd','启动Tsukiakari.cmd']) {
  const path=resolve(output,name); await writeFile(path,(await readFile(path,'utf8')).replace(/\r?\n/g,'\r\n'));
}
const files=[];
async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else files.push({path:relative(output,path).replaceAll('\\','/'),sha256:createHash('sha256').update(await readFile(path)).digest('hex')});}}
await walk(output);files.sort((a,b)=>a.path.localeCompare(b.path));
await writeFile(join(output,'release.json'),JSON.stringify({createdAt:new Date().toISOString(),node:process.version,files},null,2));
console.log('生产源码已准备：'+output+'，共'+files.length+'个文件；不包含凭据、数据库或node_modules。');

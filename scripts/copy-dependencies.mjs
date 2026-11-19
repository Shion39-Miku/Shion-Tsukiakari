import {createRequire}from'node:module';
import{existsSync}from'node:fs';
import{readFile,cp,mkdir,realpath}from'node:fs/promises';
import{join,dirname,resolve,relative}from'node:path';
export async function copyProductionDependencies(destination){
 const found=new Set();
 async function copy(name,require,optional=false){let path;for(const dir of require.resolve.paths(name)||[]){const p=join(dir,name,'package.json');if(existsSync(p)){path=await realpath(p);break;}}if(!path){if(optional)return;throw Error('未安装生产依赖：'+name);}
  const pkg=JSON.parse(await readFile(path,'utf8'));if(found.has(pkg.name))return;found.add(pkg.name);await mkdir(dirname(join(destination,pkg.name)),{recursive:true});await cp(dirname(path),join(destination,pkg.name),{recursive:true,filter:p=>!relative(dirname(path),p).split(/[\\/]/).includes('node_modules')});
  const child=createRequire(path);for(const dep of Object.keys(pkg.dependencies||{}))await copy(dep,child);for(const dep of Object.keys(pkg.optionalDependencies||{}))await copy(dep,child,true);
 }
 const require=createRequire(resolve('package.json'));for(const name of Object.keys(JSON.parse(await readFile('package.json','utf8')).dependencies))await copy(name,require);return[...found];
}

import{mkdtemp,readFile,cp,rm,writeFile}from'node:fs/promises';
import{dirname,join,relative}from'node:path';
import{tmpdir}from'node:os';
import{spawn}from'node:child_process';
import{once}from'node:events';
const release=JSON.parse(await readFile('artifacts/desktop-app.json','utf8'));
const directory=await mkdtemp(join(tmpdir(),'tsukiakari-check-'));
try{await cp(dirname(release.executable),directory,{recursive:true});const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','scripts/check-tsukiakari.mjs'],{stdio:'inherit',env:{...process.env,TSUKIAKARI_QA_EXECUTABLE:join(directory,'Tsukiakari.exe'),NODE_PATH:''}});const[code]=await once(child,'exit');process.exitCode=code||0;}
finally{const name=relative(tmpdir(),directory);if(!name.startsWith('tsukiakari-check-')||name.includes('..')||/[\\/]/.test(name))throw Error('临时运行目录越界');await rm(directory,{recursive:true,force:true,maxRetries:8,retryDelay:300}).catch(()=>{});}

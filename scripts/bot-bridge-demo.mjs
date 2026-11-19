import { createApplication } from '../server/app.mjs';
import { openDatabase, readConfig, sha256 } from '../server/core.mjs';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm, rmdir, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { demoWave } from '../server/demo.mjs';

const directory=await mkdtemp(join(tmpdir(),'moonlit-bridge-'));const dbPath=join(directory,'site.sqlite');
const grants={reader:['catalog:read'],writer:['music:write','games:write','questions:submit'],reviewer:['content:sync','questions:review','batches:read'],notifier:['events:read','events:ack']};
const tokens=Object.fromEntries(Object.keys(grants).map(key=>[key,randomBytes(32).toString('base64url')]));
const server=await createApplication({...readConfig({envFile:false}),dbPath,seedDemo:false,baseUrl:'https://shion.wiki',host:'127.0.0.1',secureCookie:false,bots:new Map(Object.entries(grants).map(([id,scopes])=>[id,{id,hash:sha256(tokens[id]),scopes:new Set(scopes)}]))});
server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
try {
 await writeFile(join(directory,'demo.wav'),demoWave(8));await writeFile(join(directory,'demo.lrc'),'[00:00.00]第一句\n[00:04.00]第二句');
 const bundled=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');const python=process.env.PYTHON_BIN || (existsSync(bundled)?bundled:'python3');
 const child=spawn(python,[resolve('scripts/test_bridge.py')],{stdio:['pipe','inherit','inherit'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});
 child.stdin.end(JSON.stringify({api_base:base,state_path:join(directory,'state'),attachment_roots:[directory],admin_identities:['test-platform:admin'],reminder_targets:['test-platform:FriendMessage:admin'],...Object.fromEntries(Object.entries(tokens).map(([key,value])=>[key+'_token',value]))}));
 const [code]=await once(child,'exit');if(code!==0)throw new Error('Bot桥接联调失败，退出码'+code);
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));for(const name of await readdir(directory)){const path=join(directory,name);if(name==='state'){if(resolve(path)!==resolve(directory,'state'))throw new Error('清理路径无效');await rm(path,{recursive:true,force:true});}else await rm(path,{force:true});}await rmdir(directory);}

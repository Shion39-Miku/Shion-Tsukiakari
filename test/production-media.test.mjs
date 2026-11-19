import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { mkdtemp, open, rm, rmdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/app.mjs';
import { openDatabase, readConfig, sha256 } from '../server/core.mjs';
import { setAdmin } from '../server/auth.mjs';
import { audioLimit, loadMediaFile } from '../server/media.mjs';
import { verifyMedia } from '../server/media-maintenance.mjs';
import { collectStaged } from '../server/media-gc.mjs';

async function makeWave(path,size) {
 const file=await open(path,'wx'); const header=Buffer.alloc(44);
 header.write('RIFF');header.writeUInt32LE(size-8,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(8000,24);header.writeUInt32LE(8000,28);header.writeUInt16LE(1,32);header.writeUInt16LE(8,34);header.write('data',36);header.writeUInt32LE(size-44,40);
 await file.write(header);await file.truncate(size);await file.close();
}
async function digest(stream) { const hash=createHash('sha256');let bytes=0;for await(const data of stream){hash.update(data);bytes+=data.length;}return {sha256:hash.digest('hex'),bytes}; }

test('100 MB streamed uploads: near, exact and over limit; DB checksums, Range, reference reuse and restored media', {timeout:120000},async(t)=>{
 const directory=await mkdtemp(join(tmpdir(),'moonlit-100mb-'));const dbPath=join(directory,'site.sqlite');
 const password=randomBytes(20).toString('hex');const token=randomBytes(32).toString('base64url');
 let db=openDatabase(dbPath);await setAdmin(db,'tester',password);db.close();
 const config={...readConfig({envFile:false}),seedDemo:false,dbPath,host:'127.0.0.1',baseUrl:'',secureCookie:false,bots:new Map([['writer',{id:'writer',hash:sha256(token),scopes:new Set(['music:write','content:sync','catalog:read','batches:read','events:read'])}]])};
 let server=await createApplication(config);server.listen(0,'127.0.0.1');await once(server,'listening');let base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{if(server.listening){server.closeAllConnections();await new Promise(done=>server.close(done));}for(const name of await readdir(directory)) await rm(join(directory,name),{force:true});await rmdir(directory);});
 const request=async(path,{method='GET',json,body,auth={},key}={})=>{const res=await fetch(base+path,{method,headers:{...auth,...(key?{'Idempotency-Key':key}:{}),...(json?{'Content-Type':'application/json'}:{})},body:json?JSON.stringify(json):body});return {status:res.status,data:await res.json(),res};};
 const login=await request('/api/admin/login',{method:'POST',json:{username:'tester',password}});const admin={Cookie:login.res.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':login.data.csrf};const bot={Authorization:'Bearer '+token};
 const near=join(directory,'near.wav');const exact=join(directory,'exact.wav');const over=join(directory,'over.wav');await makeWave(near,audioLimit-2);await makeWave(exact,audioLimit);await makeWave(over,audioLimit+1);
 const before=process.memoryUsage().rss;
 const upload=new FormData();upload.set('kind','audio');upload.set('file',await openAsBlob(near),'near.wav');
 const uploaded=await request('/api/admin/files',{method:'POST',body:upload,auth:admin,key:randomUUID()});assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));assert.equal(uploaded.data.item.size,audioLimit-2);
 const expected=await digest(createReadStream(near));assert.equal(uploaded.data.item.sha256,expected.sha256);
 const music=new FormData();music.set('title','100MB验收曲');music.set('artistName','边界验收歌手');music.set('note','仅临时验收库');music.set('audio',await openAsBlob(exact),'exact.wav');
 const rawLyrics=Buffer.from('[ti:100MB验收曲]\r\n[00:00.00]第一句\r\n[00:04.00]第二句\r\n');music.set('lyricsFile',new Blob([rawLyrics]),'source.lrc');
 const key=randomUUID();const saved=await request('/api/v1/music',{method:'POST',body:music,auth:bot,key});assert.equal(saved.status,201,JSON.stringify(saved.data));assert.equal(saved.data.item.audio.size,audioLimit);
 assert.equal((await request('/api/public/music')).data.items.length,0);
 const published=await request('/api/v1/drafts/'+saved.data.id+'/sync',{method:'POST',json:{version:saved.data.version},auth:bot});assert.equal(published.status,200,JSON.stringify(published.data));
 const detail=(await request('/api/public/music/'+saved.data.objectId)).data.item;assert.equal(detail.timedLyrics.length,2);assert.ok(detail.lyricsSource?.sha256);
 const audio=await fetch(base+detail.audio.url);assert.equal(audio.status,200);assert.deepEqual(await digest(audio.body),await digest(createReadStream(exact)));
 const range=await fetch(base+detail.audio.url,{headers:{Range:'bytes=99999000-99999999'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),'bytes 99999000-99999999/100000000');assert.equal(range.headers.get('content-length'),'1000');assert.equal((await range.arrayBuffer()).byteLength,1000);
 const source=await fetch(base+detail.lyricsSource.url);assert.deepEqual(Buffer.from(await source.arrayBuffer()),rawLyrics);
 const tooLarge=new FormData();tooLarge.set('title','超限曲');tooLarge.set('artistName','禁止创建');tooLarge.set('note','拒绝');tooLarge.set('audio',await openAsBlob(over),'over.wav');
 const rejected=await request('/api/v1/music',{method:'POST',body:tooLarge,auth:bot,key:randomUUID()});assert.equal(rejected.status,413,JSON.stringify(rejected.data));assert.match(rejected.data.error.message,/100,000,000/);
 const fake=await request('/api/v1/music',{method:'POST',json:{fields:{title:'伪造文件',artistName:'无权限',note:'拒绝'},files:{audio:[{path:'/etc/passwd',size:1,checksum:'fake',trustedReference:true,storedId:detail.audio.id}]}},auth:bot,key:randomUUID()});assert.equal(fake.status,400);
 assert.equal((await request('/api/public/music')).data.items.length,1);
 server.closeAllConnections();await new Promise(done=>server.close(done));db=openDatabase(dbPath);const verified=verifyMedia(db);assert.ok(verified.bytes>=199999998);assert.equal(loadMediaFile(db,detail.audio.id,true).data,undefined,'reference validation must not load a 100 MB BLOB');db.close();
 server=await createApplication(config);server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;assert.equal((await request('/api/public/music/'+detail.id)).data.item.audio.sha256,detail.audio.sha256);
 db=openDatabase(dbPath);assert.equal(collectStaged(db,{days:0,ids:[uploaded.data.item.id,detail.audio.id],apply:true}).files,1);assert.equal(db.prepare('SELECT 1 FROM media WHERE id=?').get(uploaded.data.item.id),undefined);assert.ok(db.prepare('SELECT 1 FROM media WHERE id=?').get(detail.audio.id));db.close();
 console.log(JSON.stringify({near:audioLimit-2,exact:audioLimit,over:audioLimit+1,uploadedChecksum:detail.audio.sha256,rssGrowthMiB:Math.round((process.memoryUsage().rss-before)/1048576),verified}));
});

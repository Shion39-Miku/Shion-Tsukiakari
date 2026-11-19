import sharp from 'sharp';
import {mkdir,copyFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const directory=resolve('public/assets/brand');await mkdir(directory,{recursive:true});
if(process.argv[2])await copyFile(resolve(process.argv[2]),join(directory,'tsukiakari-source.png'));
const source=join(directory,'tsukiakari-source.png');
for(const size of[32,64,192,512])await sharp(source).resize(size,size,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toFile(join(directory,`tsukiakari-${size}.png`));
const tray='<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="9" fill="#252345"/><path d="M23 20A11 11 0 0 1 13 4a12 12 0 1 0 10 16" fill="#bdd1ff"/><path d="m24 3 1.3 4.7L30 9l-4.7 1.3L24 15l-1.3-4.7L18 9l4.7-1.3Z" fill="#efce91"/><ellipse cx="24" cy="25" rx="3" ry="2" transform="rotate(-35 24 25)" fill="#eab7ce"/></svg>';
await writeFile(join(directory,'tray.svg'),tray);await sharp(Buffer.from(tray)).resize(32,32).png().toFile(join(directory,'tray.png'));
const sizes=[16,24,32,48,64,128,256],images=[];for(const size of sizes)images.push(await sharp(source).resize(size,size,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer());
const header=Buffer.alloc(6+images.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;for(let i=0;i<images.length;i++){const at=6+i*16;header[at]=header[at+1]=sizes[i]===256?0:sizes[i];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(images[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=images[i].length;}
await writeFile('desktop/icon.ico',Buffer.concat([header,...images]));await copyFile(join(directory,'tsukiakari-512.png'),'desktop/icon.png');await copyFile(join(directory,'tray.png'),'desktop/tray.png');
console.log('Tsukiakari PNG、ICO和透明托盘资源已生成。');

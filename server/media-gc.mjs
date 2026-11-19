import { check, idPattern, transaction } from './core.mjs';

// Conservative collection: only old unpublished staged files. Public media and
// anything referenced by a live draft, settings, batch or business replay stay.
export function collectStaged(db,{days=7,apply=false,ids=null}={}) {
 if(ids!==null)check(Array.isArray(ids)&&ids.length>0&&ids.every(id=>typeof id==='string'&&idPattern.test(id)),'清理范围须为明确的媒体ID列表。');
 const selected=ids===null?null:new Set(ids);
 const used=new Set();
 const scan=(value)=>{if(typeof value==='string')used.add(value);else if(Array.isArray(value))value.forEach(scan);else if(value&&typeof value==='object')Object.values(value).forEach(scan);};
 for(const [table,columns] of [['songs',['audio_id','cover_id']],['artists',['image_id']],['games',['logo_id']],['game_images',['image_id']],['cats',['image_id']],['background_tracks',['media_id']],['song_lyrics',['original_media_id']]])
  for(const row of db.prepare('SELECT '+columns.join(',')+' FROM '+table).all())Object.values(row).forEach(scan);
 for(const row of db.prepare('SELECT document FROM site_settings UNION ALL SELECT document FROM drafts WHERE state!=\'deleted\'').all())scan(JSON.parse(row.document));
 for(const row of db.prepare('SELECT materials FROM batch_items WHERE state IN (\'draft\',\'synced\')').all())scan(JSON.parse(row.materials));
 for(const row of db.prepare('SELECT metadata FROM chat_messages').all())scan(JSON.parse(row.metadata));
 for(const row of db.prepare('SELECT avatar_id FROM chat_profiles WHERE avatar_id IS NOT NULL').all())scan(row.avatar_id);
 for(const row of db.prepare('SELECT media_id FROM chat_site_exports').all())scan(row.media_id);
 for(const row of db.prepare('SELECT result FROM idempotency WHERE scope NOT LIKE \'%:file\'').all())scan(JSON.parse(row.result));
 const before=new Date(Date.now()-Math.max(selected?0:1,days)*86400000).toISOString();
 const candidates=db.prepare('SELECT m.id,m.size FROM media m JOIN staged_files s ON m.id=s.media_id WHERE m.published=0 AND s.created_at<?').all(before).filter(row=>(!selected||selected.has(row.id))&&!used.has(row.id));
 if(apply)transaction(db,()=>{for(const row of candidates){db.prepare('DELETE FROM idempotency WHERE scope LIKE \'%:file\' AND json_extract(result,\'$.id\')=?').run(row.id);db.prepare('DELETE FROM media WHERE id=? AND published=0').run(row.id);}});
 return {apply,days,files:candidates.length,bytes:candidates.reduce((n,row)=>n+row.size,0)};
}

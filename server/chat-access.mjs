// Website admin rights do not implicitly join a private chat conversation.
export function canReadChatFile(db, key, id) {
  if(db.prepare('SELECT 1 FROM chat_profiles WHERE avatar_id=?').get(id))return true;
  if (db.prepare('SELECT 1 FROM staged_files WHERE media_id=? AND actor=?').get(id, 'chat:' + key)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM chat_messages msg JOIN chat_members member ON member.thread_id=msg.thread_id,
    json_each(msg.metadata,'$.attachments') attachment
    WHERE member.account_key=? AND json_extract(attachment.value,'$.id')=? LIMIT 1`).get(key, id));
}

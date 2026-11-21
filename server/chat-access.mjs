import { retainedAfter } from './chat-retention.mjs';

export function usableChatUpload(db, key, id, cutoff) {
  return db.prepare(`SELECT m.id,m.name,m.mime,m.size,s.kind FROM media m JOIN staged_files s ON s.media_id=m.id
    WHERE m.id=@id AND s.actor=@actor AND (
      (NOT EXISTS(SELECT 1 FROM chat_attachment_refs WHERE media_id=@id)
        AND NOT EXISTS(SELECT 1 FROM chat_expired_media WHERE media_id=@id))
      OR EXISTS(SELECT 1 FROM chat_attachment_refs a JOIN chat_messages msg ON msg.id=a.message_id
        JOIN chat_members member ON member.thread_id=msg.thread_id
        WHERE a.media_id=@id AND member.account_key=@key AND msg.created_at>@cutoff)
    )`).get({ id, actor: 'chat:' + key, key, cutoff });
}

// Website admin rights do not implicitly join a private chat conversation.
export function canReadChatFile(db, key, id, cutoff = retainedAfter()) {
  if (db.prepare('SELECT 1 FROM chat_profiles WHERE avatar_id=?').get(id)) return true;
  if (usableChatUpload(db, key, id, cutoff)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM chat_attachment_refs a JOIN chat_messages msg ON msg.id=a.message_id
    JOIN chat_members member ON member.thread_id=msg.thread_id
    WHERE member.account_key=? AND a.media_id=? AND msg.created_at>? LIMIT 1`).get(key, id, cutoff));
}

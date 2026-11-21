CREATE INDEX chat_messages_created ON chat_messages(created_at, id);
CREATE INDEX chat_reads_message ON chat_message_reads(message_id);
CREATE INDEX chat_claims_message ON chat_notification_claims(message_id);
CREATE INDEX chat_memories_source ON chat_memories(source_message_id);
CREATE INDEX chat_jobs_reply ON chat_ai_jobs(reply_id);

CREATE TABLE chat_generated_titles (
  thread_id TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE
) STRICT;
INSERT INTO chat_generated_titles
  SELECT t.id, m.id FROM chat_threads t JOIN chat_messages m ON m.id=(
    SELECT first.id FROM chat_messages first WHERE first.thread_id=t.id AND first.role='user' ORDER BY first.id LIMIT 1
  ) WHERE t.kind='ai' AND t.title=substr(CASE WHEN substr(m.body,1,1)='/' THEN substr(m.body,2) ELSE m.body END,1,28);

CREATE TABLE chat_message_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE REFERENCES chat_messages(id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL
) STRICT;
CREATE INDEX chat_changes_thread ON chat_message_changes(thread_id, seq);
INSERT INTO chat_message_changes(message_id, thread_id) SELECT id, thread_id FROM chat_messages ORDER BY id;
CREATE TRIGGER chat_change_insert AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_message_changes(message_id, thread_id) VALUES(NEW.id, NEW.thread_id);
END;
CREATE TRIGGER chat_change_update AFTER UPDATE ON chat_messages BEGIN
  DELETE FROM chat_message_changes WHERE message_id=NEW.id;
  INSERT INTO chat_message_changes(message_id, thread_id) VALUES(NEW.id, NEW.thread_id);
END;

CREATE TABLE chat_attachment_refs (
  message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  PRIMARY KEY(message_id, media_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX chat_attachment_media ON chat_attachment_refs(media_id, message_id);
INSERT OR IGNORE INTO chat_attachment_refs
  SELECT msg.id, m.id FROM chat_messages msg, json_each(msg.metadata,'$.attachments') a
  JOIN media m ON m.id=json_extract(a.value,'$.id');
CREATE TRIGGER chat_attachment_insert AFTER INSERT ON chat_messages BEGIN
  INSERT OR IGNORE INTO chat_attachment_refs
    SELECT NEW.id, m.id FROM json_each(NEW.metadata,'$.attachments') a
    JOIN media m ON m.id=json_extract(a.value,'$.id');
END;

CREATE TABLE chat_expired_sends (key_hash TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
CREATE TABLE chat_expired_media (media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE) STRICT, WITHOUT ROWID;
CREATE TRIGGER chat_attachment_delete BEFORE DELETE ON chat_messages BEGIN
  INSERT OR IGNORE INTO chat_expired_media
    SELECT a.media_id FROM chat_attachment_refs a JOIN staged_files s ON s.media_id=a.media_id
    WHERE a.message_id=OLD.id AND s.actor LIKE 'chat:%';
END;

ALTER TABLE sessions ADD COLUMN renew_until INTEGER;
ALTER TABLE chat_sessions ADD COLUMN renew_until INTEGER;

ALTER TABLE media ADD COLUMN published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1));
ALTER TABLE media ADD COLUMN preview_version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE media_previews (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  width INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (media_id, width)
) STRICT, WITHOUT ROWID;

CREATE TABLE staged_files (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE reusable_names (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('producer', 'genre')),
  name TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (kind, name)
) STRICT;
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  object_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  document TEXT NOT NULL,
  version INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'synced', 'deleted')),
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (category, object_id)
) STRICT;
CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'synced', 'deleted'))
) STRICT;
CREATE TABLE batch_items (
  batch_id TEXT NOT NULL REFERENCES batches(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  object_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('new', 'update')),
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'synced', 'deleted', 'superseded')),
  materials TEXT NOT NULL,
  PRIMARY KEY (batch_id, draft_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE deleted_objects (
  category TEXT NOT NULL,
  object_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (category, object_id)
) STRICT, WITHOUT ROWID;
ALTER TABLE modification_logs ADD COLUMN batch_id TEXT;

CREATE TABLE bot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  question_id TEXT REFERENCES questions(id),
  batch_id TEXT REFERENCES batches(id),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO bot_events (id, type, question_id, payload, created_at)
  SELECT id, 'question.created', question_id, '{}', created_at FROM events;
CREATE TABLE event_cursors (
  bot_id TEXT PRIMARY KEY,
  through_event INTEGER NOT NULL REFERENCES bot_events(id)
) STRICT;
INSERT INTO event_cursors SELECT bot_id, through_event FROM bot_cursors;

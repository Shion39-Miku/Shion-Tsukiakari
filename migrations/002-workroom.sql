CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  document TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE site_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE modification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  category TEXT NOT NULL,
  object_id TEXT NOT NULL,
  result TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX modification_logs_time ON modification_logs(created_at DESC, id DESC);

CREATE TABLE visitor_visits (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  path TEXT NOT NULL,
  entry_path TEXT NOT NULL,
  source TEXT NOT NULL,
  source_basis TEXT NOT NULL,
  browser TEXT NOT NULL,
  device TEXT NOT NULL,
  entered_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  repeats INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX visitor_merge ON visitor_visits(visitor_id, path, entered_at DESC);
CREATE INDEX visitor_time ON visitor_visits(entered_at DESC);

CREATE TABLE visit_segments (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visitor_visits(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  visible_ms INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 1
) STRICT;
CREATE INDEX segment_visit ON visit_segments(visit_id);

CREATE TABLE visitor_events (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visitor_visits(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX visitor_event_time ON visitor_events(created_at DESC);

CREATE TABLE content_versions (
  category TEXT NOT NULL,
  object_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (category, object_id)
) STRICT, WITHOUT ROWID;

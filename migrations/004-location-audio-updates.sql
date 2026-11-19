ALTER TABLE visitor_visits ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE visitor_visits ADD COLUMN province TEXT NOT NULL DEFAULT '';
ALTER TABLE visitor_visits ADD COLUMN city TEXT NOT NULL DEFAULT '';
ALTER TABLE visitor_visits ADD COLUMN location_kind TEXT NOT NULL DEFAULT 'unknown';
CREATE TABLE ip_locations (
  ip_hash TEXT PRIMARY KEY, country TEXT NOT NULL, province TEXT NOT NULL, city TEXT NOT NULL,
  kind TEXT NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
ALTER TABLE background_tracks ADD COLUMN volume REAL NOT NULL DEFAULT 0.05 CHECK(volume >= 0 AND volume <= 1);
UPDATE drafts SET document = json_set(document, '$.fields.volume', '0.05') WHERE category = 'background';
ALTER TABLE batches ADD COLUMN synced_at TEXT;
UPDATE batches SET synced_at = coalesce(
  (SELECT min(created_at) FROM modification_logs WHERE batch_id = batches.id AND action = 'draft.sync' AND result = 'success'),
  created_at) WHERE state = 'synced';
CREATE INDEX batches_public_time ON batches(state, synced_at DESC);

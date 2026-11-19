ALTER TABLE media ADD COLUMN sha256 TEXT;
CREATE TABLE song_lyrics (
  song_id TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  original_media_id TEXT REFERENCES media(id),
  source_text TEXT NOT NULL,
  timeline TEXT NOT NULL
) STRICT;

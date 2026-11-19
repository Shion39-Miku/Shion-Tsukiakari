CREATE TABLE media (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  width INTEGER,
  height INTEGER,
  thumb BLOB,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE media_chunks (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (media_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TABLE artists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  image_id TEXT REFERENCES media(id)
) STRICT;

CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  translation TEXT NOT NULL,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  producer TEXT NOT NULL,
  lyricist TEXT NOT NULL,
  note TEXT NOT NULL,
  lyrics TEXT NOT NULL,
  audio_id TEXT NOT NULL REFERENCES media(id),
  cover_id TEXT REFERENCES media(id),
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE games (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  translation TEXT NOT NULL,
  genre TEXT NOT NULL,
  note TEXT NOT NULL,
  description TEXT NOT NULL,
  logo_id TEXT NOT NULL REFERENCES media(id),
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE game_images (
  game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  image_id TEXT NOT NULL REFERENCES media(id),
  PRIMARY KEY (game_id, position)
) STRICT, WITHOUT ROWID;

CREATE TABLE cats (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL REFERENCES media(id),
  demo INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE background_tracks (
  version INTEGER PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  author TEXT,
  question TEXT NOT NULL,
  reply TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'deleted')),
  created_at TEXT NOT NULL,
  published_at TEXT,
  CHECK (state != 'published' OR (reply IS NOT NULL AND length(reply) > 0 AND published_at IS NOT NULL)),
  CHECK (state != 'deleted' OR (author IS NULL AND question = '' AND reply IS NULL AND published_at IS NULL))
) STRICT;

CREATE INDEX questions_pending ON questions(created_at DESC, id) WHERE state = 'pending';
CREATE INDEX questions_published ON questions(published_at DESC, id) WHERE state = 'published';

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL UNIQUE REFERENCES questions(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE bot_cursors (
  bot_id TEXT PRIMARY KEY,
  through_event INTEGER NOT NULL REFERENCES events(id)
) STRICT;

CREATE TABLE idempotency (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
) STRICT;

CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE app_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE chat_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE chat_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES chat_accounts(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ai' CHECK (kind IN ('ai', 'direct', 'group')),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX chat_threads_owner ON chat_threads(owner, updated_at DESC);

CREATE TABLE chat_members (
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  account_key TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, account_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX chat_members_account ON chat_members(account_key, hidden);

CREATE TABLE chat_direct_pairs (
  pair_key TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL UNIQUE REFERENCES chat_threads(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  sender_key TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'generating', 'stopped', 'failed')),
  metadata TEXT NOT NULL DEFAULT '{}',
  request_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(thread_id, request_key, role)
) STRICT;
CREATE INDEX chat_messages_thread ON chat_messages(thread_id, id DESC);

UPDATE site_settings SET document=json_set(document,'$.browserTitle','詩音の月光庭院')
  WHERE json_extract(document,'$.browserTitle') IS NULL;
UPDATE drafts SET document=json_set(document,'$.browserTitle','詩音の月光庭院')
  WHERE category='settings' AND json_extract(document,'$.browserTitle') IS NULL;

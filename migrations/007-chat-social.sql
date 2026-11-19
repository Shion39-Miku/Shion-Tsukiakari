CREATE TABLE chat_profiles (
  account_key TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  avatar_id TEXT REFERENCES media(id),
  preferred_status TEXT NOT NULL DEFAULT 'online' CHECK(preferred_status IN('online','away','busy','invisible','offline')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO chat_profiles(account_key,public_id,display_name,updated_at)
SELECT 'admin:'||id,'A-'||id,username,datetime('now') FROM admins;
INSERT INTO chat_profiles(account_key,public_id,display_name,updated_at)
SELECT 'member:'||id,'U-'||id,username,datetime('now') FROM chat_accounts;
CREATE TABLE chat_friendships (
  pair_key TEXT PRIMARY KEY, a_key TEXT NOT NULL,b_key TEXT NOT NULL,created_at TEXT NOT NULL
) STRICT;
INSERT INTO chat_friendships SELECT pair_key,substr(pair_key,1,instr(pair_key,'|')-1),substr(pair_key,instr(pair_key,'|')+1),datetime('now') FROM chat_direct_pairs;
CREATE TABLE chat_friend_requests (
  id TEXT PRIMARY KEY,pair_key TEXT NOT NULL UNIQUE,requester TEXT NOT NULL,target TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('pending','accepted','rejected','canceled')),version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX chat_friend_requests_target ON chat_friend_requests(target,state);
CREATE TABLE chat_presence_connections (
  id TEXT PRIMARY KEY,account_key TEXT NOT NULL,heartbeat_at INTEGER NOT NULL
) STRICT;
CREATE INDEX chat_presence_account ON chat_presence_connections(account_key,heartbeat_at);
CREATE TABLE chat_membership_epochs (
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, account_key TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(thread_id,account_key)
) STRICT,WITHOUT ROWID;
CREATE TABLE chat_group_invitations (
  id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  inviter TEXT NOT NULL,target TEXT NOT NULL,target_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN('pending','accepted','rejected','revoked','expired')),
  expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX chat_pending_group_invite ON chat_group_invitations(thread_id,target) WHERE state='pending';
CREATE INDEX chat_invites_target ON chat_group_invitations(target,state);
CREATE TABLE chat_ai_agents (
  id TEXT PRIMARY KEY,remote_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,version TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'astrbot',document TEXT NOT NULL DEFAULT '{}',checked_at TEXT NOT NULL
) STRICT;
CREATE TABLE chat_ai_members (
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  ai_id TEXT NOT NULL REFERENCES chat_ai_agents(id),added_by TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,epoch INTEGER NOT NULL DEFAULT 1,joined_at TEXT NOT NULL,removed_at TEXT,
  PRIMARY KEY(thread_id,ai_id)
) STRICT,WITHOUT ROWID;
CREATE TABLE chat_ai_sessions (
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  ai_id TEXT NOT NULL,umo TEXT NOT NULL UNIQUE,conversation_id TEXT,
  summary TEXT NOT NULL DEFAULT '',summary_through INTEGER NOT NULL DEFAULT 0,
  roster_version INTEGER NOT NULL DEFAULT 1,last_message_id INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,PRIMARY KEY(thread_id,ai_id)
) STRICT,WITHOUT ROWID;
CREATE TABLE chat_memories (
  id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN('private','group','shared')),
  thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE,body TEXT NOT NULL,
  source_message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,source_actor TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  UNIQUE(owner_key,source_message_id,body)
) STRICT;
CREATE INDEX chat_memories_owner ON chat_memories(owner_key,scope,revoked);
CREATE TABLE chat_ai_jobs (
  id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  ai_id TEXT NOT NULL,source_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  reply_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN('queued','running','complete','failed','canceled')),
  attempt INTEGER NOT NULL DEFAULT 0,roster_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(ai_id,source_id)
) STRICT;
CREATE TABLE chat_notification_claims (
  account_key TEXT NOT NULL,message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,PRIMARY KEY(account_key,message_id)
) STRICT,WITHOUT ROWID;
CREATE TABLE chat_message_reads (
  account_key TEXT NOT NULL,message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  PRIMARY KEY(account_key,message_id)
) STRICT,WITHOUT ROWID;
INSERT INTO chat_message_reads SELECT m.account_key,msg.id FROM chat_members m JOIN chat_messages msg ON msg.thread_id=m.thread_id WHERE msg.id<=m.last_read_id AND msg.status='complete';
CREATE TABLE chat_client_preferences (
  account_key TEXT PRIMARY KEY,sound INTEGER NOT NULL DEFAULT 1,taskbar INTEGER NOT NULL DEFAULT 1,
  desktop INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE chat_persona_drafts (
  account_key TEXT NOT NULL,remote_id TEXT NOT NULL,document TEXT NOT NULL,base_version TEXT,
  updated_at TEXT NOT NULL,PRIMARY KEY(account_key,remote_id)
) STRICT,WITHOUT ROWID;
CREATE TABLE chat_site_exports (
  account_key TEXT NOT NULL,media_id TEXT NOT NULL REFERENCES media(id),site_media_id TEXT NOT NULL,
  created_at TEXT NOT NULL,PRIMARY KEY(account_key,media_id)
) STRICT,WITHOUT ROWID;

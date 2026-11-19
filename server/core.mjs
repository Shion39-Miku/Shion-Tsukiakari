import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProxies } from './location.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const now = () => new Date().toISOString();
export const newId = randomUUID;
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export class Problem extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    Object.assign(this, { status, code, headers });
  }
}

export function check(condition, message, status = 400, code = 'invalid_input') {
  if (!condition) throw new Problem(status, code, message);
}

export function cleanText(value, label, limit, required = false) {
  const line = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  check(value == null || typeof value === 'string', `${label}格式有误。`);
  check(!required || line, `请填写${label}。`);
  check([...line].length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(line),
    `${label}最多 ${limit} 个字符，且不能包含控制字符。`);
  return line;
}

export const scopes = ['catalog:read', 'music:write', 'games:write', 'questions:submit',
  'events:read', 'events:ack', 'questions:review', 'content:sync', 'batches:read', 'content-events:read'];

export function readConfig({ envFile = true } = {}) {
  const dotEnv = resolve(root, '.env');
  if (envFile && existsSync(dotEnv)) process.loadEnvFile(dotEnv);
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
  let baseUrl = '';
  if (process.env.PUBLIC_BASE_URL) {
    const url = new URL(process.env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.href !== `${url.origin}/`) {
      throw new Error('PUBLIC_BASE_URL 必须是一个 HTTP(S) origin。');
    }
    baseUrl = url.origin;
  }
  const bots = new Map();
  const tokens = new Set();
  let definitions;
  try {
    definitions = JSON.parse(process.env.BOT_TOKENS || '[]');
  } catch {
    throw new Error('BOT_TOKENS 必须是 JSON 数组。');
  }
  if (!Array.isArray(definitions)) throw new Error('BOT_TOKENS 必须是 JSON 数组。');
  for (const bot of definitions) {
    if (!bot || typeof bot.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(bot.id)
      || typeof bot.token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(bot.token)
      || !Array.isArray(bot.scopes) || bot.scopes.some((scope) => !scopes.includes(scope))
      || bots.has(bot.id) || tokens.has(bot.token)) {
      throw new Error('BOT_TOKENS 中的 ID、令牌或权限无效或重复。');
    }
    tokens.add(bot.token);
    bots.set(bot.id, { id: bot.id, hash: sha256(bot.token), scopes: new Set(bot.scopes) });
  }
  const site = JSON.parse(readFileSync(resolve(root, 'site.json'), 'utf8'));
  let chatFile = {};
  if (process.env.CHAT_AI_CONFIG_FILE) {
    try { chatFile = JSON.parse(readFileSync(process.env.CHAT_AI_CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code === 'ENOENT') console.log('未找到私有模型配置；聊天模型待配置，其它功能可继续使用。');
      else throw new Error('聊天模型配置文件无法读取或格式有误。');
    }
  }
  let astrbotFile = {};
  if(process.env.ASTRBOT_CONFIG_FILE){
    try{astrbotFile=JSON.parse(readFileSync(process.env.ASTRBOT_CONFIG_FILE,'utf8').replace(/^\uFEFF/,''));}
    catch(error){if(error.code!=='ENOENT')throw new Error('AstrBot私有连接配置格式有误。');}
  }
  site.socials ??= {};
  for (const [key, value] of Object.entries(site.socials)) {
    try {
      const url = new URL(value);
      site.socials[key] = url.protocol === 'https:' ? url.href : null;
    } catch {
      site.socials[key] = null;
    }
  }
  return {
    site, bots, port, baseUrl,serviceMode:process.env.SERVICE_MODE||'legacy',disableChat:process.env.SERVICE_MODE==='website',websiteUrl:process.env.WEBSITE_BASE_URL||'',websiteEventToken:process.env.WEBSITE_EVENT_TOKEN||'',
    trustedProxies: validateProxies((process.env.TRUSTED_PROXIES || '').split(',').map((part) => part.trim()).filter(Boolean)),
    ipGeoEnabled: process.env.IP_GEO_ENABLED !== 'false',
    ipGeoTimeoutMs: 1800,
    host: process.env.HOST || '127.0.0.1',
    dbPath: resolve(root, process.env.DATABASE_PATH || 'data/moonlit.sqlite'),
    seedDemo: process.env.SEED_DEMO !== 'false',
    logRetentionDays: Math.max(1, Math.min(365, Number(process.env.LOG_RETENTION_DAYS) || 30)),
    logMaxRows: Math.max(100, Math.min(100000, Number(process.env.LOG_MAX_ROWS) || 50000)),
    secureCookie: process.env.COOKIE_SECURE === 'true' || baseUrl.startsWith('https:'),
    astrbot:{baseUrl:process.env.ASTRBOT_BASE_URL||astrbotFile.baseUrl||'',chatToken:process.env.ASTRBOT_CHAT_TOKEN||astrbotFile.chatToken||'',adminToken:process.env.ASTRBOT_ADMIN_TOKEN||astrbotFile.adminToken||''},
    chat: {
      apiBase: process.env.CHAT_AI_BASE_URL || chatFile.apiBase || '',
      apiKey: process.env.CHAT_AI_API_KEY || chatFile.apiKey || '',
      model: process.env.CHAT_AI_MODEL || chatFile.model || '',
      assistantName: process.env.CHAT_ASSISTANT_NAME || '大肥鱼',
      systemPrompt: process.env.CHAT_SYSTEM_PROMPT || '你是一位中文聊天助理。友善、清晰地回应用户。网站操作通过应用的明确按钮与确认完成；不要声称你执行了未执行的操作。',
    },
  };
}

const transactionDepth = new WeakMap();
export function transaction(db, write) {
  const depth = transactionDepth.get(db) || 0;
  const name = 'moonlit_' + depth;
  db.exec(depth ? 'SAVEPOINT ' + name : 'BEGIN IMMEDIATE');
  transactionDepth.set(db, depth + 1);
  try {
    const result = write();
    db.exec(depth ? 'RELEASE ' + name : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(depth ? 'ROLLBACK TO ' + name : 'ROLLBACK');
    if (depth) db.exec('RELEASE ' + name);
    throw error;
  } finally {
    transactionDepth.set(db, depth);
  }
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;`);
    const directory = resolve(root, 'migrations');
    const migrations = readdirSync(directory).filter((name) => /^\d+-[\w-]+\.sql$/.test(name)).sort();
    transaction(db, () => {
      const applied = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map((row) => row.name);
      if (applied.some((name, index) => name !== migrations[index])) {
        throw new Error('数据库迁移记录与当前代码不一致。请使用对应版本的迁移文件。');
      }
      const record = db.prepare('INSERT INTO schema_migrations VALUES (?, ?)');
      for (const name of migrations.slice(applied.length)) {
        db.exec(readFileSync(resolve(directory, name), 'utf8'));
        record.run(name, now());
      }
    });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function consumeQuota(db, bucket, limit, duration) {
  const time = Date.now();
  db.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').run(time);
  const row = db.prepare('SELECT hits, reset_at FROM rate_limits WHERE bucket = ?').get(bucket);
  if (row && row.hits >= limit) {
    throw new Problem(429, 'rate_limited', '提交太频繁，请稍后再试。', {
      'Retry-After': Math.ceil((row.reset_at - time) / 1000),
    });
  }
  db.prepare(`INSERT INTO rate_limits VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET hits = hits + 1`).run(bucket, time + duration);
}

export function requestKey(req, required = true) {
  const key = req.headers['idempotency-key'];
  if (!key && !required) return null;
  check(typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key), '请提供有效的 Idempotency-Key。');
  return key;
}

export function priorResult(db, scope, key, fingerprint) {
  if (!key) return null;
  const saved = db.prepare('SELECT fingerprint, result FROM idempotency WHERE scope = ? AND key = ?').get(scope, key);
  if (!saved) return null;
  check(saved.fingerprint === fingerprint, '此重试标识已用于不同的内容。', 409, 'idempotency_conflict');
  return JSON.parse(saved.result);
}

export function saveResult(db, scope, key, fingerprint, result) {
  if (key) db.prepare('INSERT INTO idempotency VALUES (?, ?, ?, ?)').run(scope, key, fingerprint, JSON.stringify(result));
  return result;
}

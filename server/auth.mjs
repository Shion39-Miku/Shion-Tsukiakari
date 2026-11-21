import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { check, consumeQuota, newId, now, Problem, sha256, transaction } from './core.mjs';

const derive = promisify(scrypt);
const passwordOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const sessionAge = 8 * 60 * 60;
const chatRenewal = {
  member: { age: 30 * 86400, max: 90 * 86400 },
  admin: { age: 86400, max: 7 * 86400 },
};
const cookieName = 'moonlit_session';
const chatCookieName = 'moonlit_chat_session';
const usernamePattern = /^[a-zA-Z0-9_.-]{2,40}$/;

const secret = () => randomBytes(32).toString('base64url');

function equals(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sessionCookie(token, maxAge, secure, name = cookieName) {
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict${maxAge === null ? '' : '; Max-Age=' + maxAge}${secure ? '; Secure' : ''}`;
}

function chatSessionTimes(remember, role) {
  const time = Date.now();
  const policy = chatRenewal[role];
  return { expires: time + (remember ? policy.age : sessionAge) * 1000,
    until: remember ? time + policy.max * 1000 : null,
    cookieAge: remember ? policy.age : null };
}

export async function setAdmin(db, username, password) {
  check(usernamePattern.test(username), '账号须为 2 至 40 位字母、数字、点、下划线或横线。');
  check(typeof password === 'string' && [...password].length >= 8 && [...password].length <= 128,
    '密码须为 8 至 128 个字符。');
  check(!db.prepare('SELECT 1 FROM chat_accounts WHERE username=?').get(username), '此账号名已由普通成员使用。', 409, 'account_exists');
  const salt = randomBytes(24).toString('hex');
  const hash = (await derive(password, Buffer.from(salt, 'hex'), 64, passwordOptions)).toString('hex');
  transaction(db, () => {
    db.prepare(`INSERT INTO admins VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash`).run(newId(), username, salt, hash);
    db.prepare('DELETE FROM sessions WHERE admin_id = (SELECT id FROM admins WHERE username = ?)').run(username);
  });
}

export async function login(db, { username, password }, ip, secure, chatRemember) {
  const bucket = `login:${sha256(ip)}`;
  transaction(db, () => consumeQuota(db, bucket, 8, 15 * 60 * 1000));
  const failed = () => new Problem(401, 'invalid_credentials', '账号或密码不正确。');
  if (typeof username !== 'string' || !usernamePattern.test(username)
    || typeof password !== 'string' || [...password].length > 128) throw failed();
  const user = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const hash = await derive(password, Buffer.from(user?.salt || '00'.repeat(24), 'hex'), 64, passwordOptions);
  if (!user || !timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) throw failed();
  const token = secret();
  const csrf = secret();
  const times = chatRemember === undefined ? { expires: Date.now() + sessionAge * 1000, until: null, cookieAge: sessionAge }
    : chatSessionTimes(chatRemember, 'admin');
  transaction(db, () => {
    // If the password changed during scrypt, the old credential must not get a new session.
    check(db.prepare('SELECT hash FROM admins WHERE id = ?').get(user.id)?.hash === user.hash,
      '账号凭据已更新，请重新登录。', 401, 'invalid_credentials');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions(token_hash,admin_id,csrf,expires_at,renew_until) VALUES (?,?,?,?,?)').run(sha256(token), user.id, csrf, times.expires, times.until);
    db.prepare('DELETE FROM rate_limits WHERE bucket = ?').run(bucket);
  });
  return { data: { username: user.username, csrf }, cookie: sessionCookie(token, times.cookieAge, secure) };
}

function sessionCredential(req, member) {
  const name = member ? chatCookieName : req.chatAdminCookieName || cookieName;
  const entries=(req.headers.cookie || '').split(';').map(value=>value.trim());
  const cookie = entries.find((value) => value.startsWith(`${name}=`)) || (!member&&req.chatAdminCookieName?entries.find(value=>value.startsWith(cookieName+'=')):null);
  return { token: cookie?.slice(cookie.indexOf('=') + 1), name: cookie?.slice(0, cookie.indexOf('=')) || name };
}

function findSession(db, req, member = false) {
  const { token } = sessionCredential(req, member);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) && db.prepare(member
    ? `SELECT a.id, a.username, s.csrf, s.token_hash, s.expires_at, s.renew_until FROM chat_sessions s JOIN chat_accounts a ON a.id=s.account_id
       WHERE s.token_hash=? AND s.expires_at>? AND a.disabled=0`
    : `SELECT a.id, a.username, s.csrf, s.token_hash, s.expires_at, s.renew_until FROM sessions s JOIN admins a ON a.id=s.admin_id
       WHERE s.token_hash=? AND s.expires_at>?`)
    .get(sha256(token), Date.now());
}

function checkCsrf(req, session) {
  if (req.method !== 'GET' && req.method !== 'HEAD') check(equals(req.headers['x-csrf-token'] || '', session.csrf),
    '会话校验失败，请刷新后再试。', 403, 'csrf_failed');
}

export function requireAdmin(db, req) {
  const session = findSession(db, req);
  check(session, '请先登录管理后台。', 401, 'login_required');
  checkCsrf(req, session);
  return session;
}

export function requireAccount(db, req) {
  const administrator = findSession(db, req);
  const session = administrator || findSession(db, req, true);
  check(session, '请先登录聊天应用。', 401, 'login_required');
  checkCsrf(req, session);
  const role = administrator ? 'admin' : 'member';
  return { ...session, role, key: role + ':' + session.id };
}

export async function loginAccount(db, credentials, ip, secure, adminCookieName = cookieName) {
  const { username, password, remember } = credentials;
  check(remember === undefined || typeof remember === 'boolean', '登录选项无效。');
  if (typeof username === 'string' && db.prepare('SELECT id FROM admins WHERE username=?').get(username)) {
    const result = await login(db, credentials, ip, secure, remember);
    return { data: { ...result.data, role: 'admin' }, cookies: [result.cookie.replace(cookieName+'=',adminCookieName+'='), sessionCookie('', 0, secure, chatCookieName)] };
  }
  const bucket = `login:${sha256(ip)}`;
  transaction(db, () => consumeQuota(db, bucket, 8, 15 * 60 * 1000));
  const failed = () => new Problem(401, 'invalid_credentials', '账号或密码不正确。');
  if (typeof username !== 'string' || !usernamePattern.test(username) || typeof password !== 'string' || [...password].length > 128) throw failed();
  const user = db.prepare('SELECT * FROM chat_accounts WHERE username=?').get(username);
  const hash = await derive(password, Buffer.from(user?.salt || '00'.repeat(24), 'hex'), 64, passwordOptions);
  if (!user || user.disabled || !timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) throw failed();
  const token = secret(), csrf = secret();
  const times = chatSessionTimes(remember, 'member');
  transaction(db, () => {
    const current = db.prepare('SELECT hash, disabled FROM chat_accounts WHERE id=?').get(user.id);
    check(current?.hash === user.hash && !current.disabled, '账号凭据已更新，请重新登录。', 401, 'invalid_credentials');
    db.prepare('DELETE FROM chat_sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO chat_sessions(token_hash,account_id,csrf,expires_at,renew_until) VALUES (?,?,?,?,?)').run(sha256(token), user.id, csrf, times.expires, times.until);
    db.prepare('DELETE FROM rate_limits WHERE bucket=?').run(bucket);
  });
  return { data: { username: user.username, role: 'member', csrf },
    cookies: [sessionCookie(token, remember === undefined ? sessionAge : times.cookieAge, secure, chatCookieName), sessionCookie('', 0, secure,adminCookieName),...(adminCookieName!==cookieName?[sessionCookie('',0,secure)]:[])] };
}

export function refreshAccount(db, req, session, secure) {
  if (!session.renew_until) return {};
  const time = Date.now();
  const target = Math.min(time + chatRenewal[session.role].age * 1000, session.renew_until);
  // Amortize refresh writes while preserving the same credential for open SSE connections.
  if (target - session.expires_at < 60 * 60 * 1000) return {};
  const member = session.role === 'member';
  const { token, name } = sessionCredential(req, member);
  const table = member ? 'chat_sessions' : 'sessions';
  const updated = db.prepare(`UPDATE ${table} SET expires_at=? WHERE token_hash=? AND expires_at>?`).run(target, session.token_hash, time);
  check(updated.changes, '请先登录聊天应用。', 401, 'login_required');
  return { 'Set-Cookie': sessionCookie(token, Math.floor((target - time) / 1000), secure, name) };
}

export function logoutAccount(db, req, secure) {
  for (const member of [false, true]) {
    const session = findSession(db, req, member);
    if (session) db.prepare('DELETE FROM ' + (member ? 'chat_sessions' : 'sessions') + ' WHERE token_hash=?').run(session.token_hash);
  }
  return [sessionCookie('', 0, secure,req.chatAdminCookieName||cookieName), sessionCookie('', 0, secure, chatCookieName),...(req.chatAdminCookieName?[sessionCookie('',0,secure)]:[])];
}

export async function setChatAccount(db, { username, password }, id = null) {
  check(typeof username === 'string' && usernamePattern.test(username), '账号须为 2 至 40 位字母、数字、点、下划线或横线。');
  check(typeof password === 'string' && [...password].length >= 8 && [...password].length <= 128, '密码须为 8 至 128 个字符。');
  check(!db.prepare('SELECT 1 FROM admins WHERE username=?').get(username), '此账号名已由管理员使用。', 409, 'account_exists');
  const exists = db.prepare('SELECT id FROM chat_accounts WHERE username=?').get(username);
  check(!exists || exists.id === id, '此账号名已被使用。', 409, 'account_exists');
  if (id) check(db.prepare('SELECT 1 FROM chat_accounts WHERE id=?').get(id), '没有找到此账号。', 404, 'not_found');
  const salt = randomBytes(24).toString('hex');
  const hash = (await derive(password, Buffer.from(salt, 'hex'), 64, passwordOptions)).toString('hex');
  return transaction(db, () => {
    check(!db.prepare('SELECT 1 FROM admins WHERE username=?').get(username), '此账号名已由管理员使用。', 409, 'account_exists');
    const collision = db.prepare('SELECT id FROM chat_accounts WHERE username=?').get(username);
    check(!collision || collision.id === id, '此账号名已被使用。', 409, 'account_exists');
    const accountId = id || newId();
    if (id) db.prepare('UPDATE chat_accounts SET username=?,salt=?,hash=? WHERE id=?').run(username, salt, hash, id);
    else db.prepare('INSERT INTO chat_accounts (id,username,salt,hash,created_at) VALUES (?,?,?,?,?)').run(accountId, username, salt, hash, now());
    db.prepare('DELETE FROM chat_sessions WHERE account_id=?').run(accountId);
    return { id: accountId, username, role: 'member' };
  });
}

export function logout(db, session, secure) {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
  return sessionCookie('', 0, secure);
}

export function requireBot(bots, req) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(req.headers.authorization || '');
  const hash = match && sha256(match[1]);
  const bot = hash && [...bots.values()].find((item) => equals(hash, item.hash));
  check(bot, 'Bot 令牌缺失或无效。', 401, 'invalid_token');
  return bot;
}

export function requireScope(bot, scope) {
  check(bot.scopes.has(scope), `此令牌缺少 ${scope} 权限。`, 403, 'missing_scope');
}

import { check, cleanText, consumeQuota, idPattern, newId, now, transaction } from './core.mjs';
import { readJson } from './media.mjs';

export function createSocial(db, { emit, own, invalidate = () => {} }) {
  const serviceDefaults=()=>JSON.parse(db.prepare("SELECT value FROM app_flags WHERE key='tsukiakari-service'").get()?.value||'{}');
  const live = new Map();
  let closed = false;
  db.prepare('DELETE FROM chat_presence_connections').run();
  const rawUsers = () => [...db.prepare("SELECT 'admin:'||id AS key,id,username,'admin' AS role FROM admins").all(),
    ...db.prepare("SELECT 'member:'||id AS key,id,username,'member' AS role FROM chat_accounts WHERE disabled=0").all()];
  function ensureProfiles() {
    const insert = db.prepare('INSERT INTO chat_profiles(account_key,public_id,display_name,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_key) DO NOTHING');
    for (const user of rawUsers()) insert.run(user.key, (user.role === 'admin' ? 'A-' : 'U-') + user.id, user.username, now());
  }
  function profile(key, viewer = null) {
    const account = rawUsers().find((u) => u.key === key);
    const value = db.prepare('SELECT * FROM chat_profiles WHERE account_key=?').get(key);
    if (!value) return null;
    const connected = Boolean(db.prepare('SELECT 1 FROM chat_presence_connections WHERE account_key=? AND heartbeat_at>? LIMIT 1').get(key, Date.now() - 75000));
    const status = value.preferred_status === 'invisible' && viewer !== key ? 'offline'
      : value.preferred_status === 'offline' || !connected ? 'offline' : value.preferred_status;
    return { key, id: value.public_id, username: account?.username || '已停用账号', displayName: value.display_name,
      avatar: value.avatar_id ? '/chat-media/' + value.avatar_id + '/thumb' : null, avatarId: value.avatar_id,
      status, ...(viewer === key ? { preferredStatus: value.preferred_status } : {}), role: account?.role || 'disabled', version: value.version, updatedAt: value.updated_at };
  }
  const users = (viewer) => { ensureProfiles(); return rawUsers().map((u) => profile(u.key, viewer)); };
  const resolveUser = (value) => users().find((u) => u.key === value || u.id === value || u.username === value);
  const pair = (a, b) => [a, b].sort().join('|');
  const isFriend = (a, b) => Boolean(db.prepare('SELECT 1 FROM chat_friendships WHERE pair_key=?').get(pair(a, b)));
  function relationship(a, b) {
    if (a === b) return 'self'; if (isFriend(a, b)) return 'friends';
    const request = db.prepare('SELECT * FROM chat_friend_requests WHERE pair_key=?').get(pair(a, b));
    return request?.state === 'pending' ? request.requester === a ? 'outgoing' : 'incoming' : 'none';
  }
  function friends(key) { return db.prepare('SELECT a_key,b_key FROM chat_friendships WHERE a_key=? OR b_key=? ORDER BY created_at DESC').all(key, key).map((r) => profile(r.a_key === key ? r.b_key : r.a_key, key)).filter((p) => p && p.role !== 'disabled'); }
  function tell(key, topic = 'social', value = {}) { emit(key, null, topic, value); }
  function broadcastProfile(key) { for (const u of rawUsers()) tell(u.key, 'profiles', { key }); }
  function members(id, viewer = null) {
    return [...db.prepare('SELECT account_key,joined_at FROM chat_members WHERE thread_id=? ORDER BY joined_at,account_key').all(id).map((m) => ({ ...profile(m.account_key, viewer), joinedAt: m.joined_at, kind: 'human' })),
      ...db.prepare('SELECT a.*,m.joined_at FROM chat_ai_members m JOIN chat_ai_agents a ON a.id=m.ai_id WHERE m.thread_id=? AND m.active=1 ORDER BY m.joined_at').all(id)
        .map((a) => ({ key: 'ai:' + a.id, id: a.id, aiId: a.id, username: a.name, displayName: a.name, kind: 'ai', role: 'ai', status: a.enabled ? 'online' : 'offline', enabled: Boolean(a.enabled), avatar: a.avatar_url ? '/api/chat/ai/' + a.id + '/avatar' : null, personaId: a.remote_id,greeting:JSON.parse(a.document).firstMessage||'', version: a.version, joinedAt: a.joined_at }))];
  }
  const epoch = (thread, key) => db.prepare('SELECT epoch FROM chat_membership_epochs WHERE thread_id=? AND account_key=?').get(thread, key)?.epoch || 0;
  function invalidateRoster(thread) {
    db.prepare('UPDATE chat_ai_sessions SET roster_version=roster_version+1,summary=?,summary_through=0,updated_at=? WHERE thread_id=?').run('', now(), thread);
    invalidate(thread); emit(null, thread, 'threads', {});
  }
  function removeMember(thread, key) {
    transaction(db, () => {
      db.prepare('DELETE FROM chat_members WHERE thread_id=? AND account_key=?').run(thread, key);
      db.prepare('INSERT INTO chat_membership_epochs VALUES(?,?,1) ON CONFLICT(thread_id,account_key) DO UPDATE SET epoch=epoch+1').run(thread, key);
      db.prepare("UPDATE chat_group_invitations SET state='revoked',updated_at=? WHERE thread_id=? AND (target=? OR inviter=?) AND state='pending'").run(now(), thread, key, key);
      invalidateRoster(thread);
    }); tell(key, 'deleted', { id: thread });
  }
  function invite(session, thread, targetKey) {
    const group = own(session, thread); check(group.kind === 'group', '只能邀请加入群聊。');
    const target = resolveUser(targetKey); check(target && target.role !== 'disabled' && target.key !== session.key, '请选择有效的其他账号。');
    if (db.prepare('SELECT 1 FROM chat_members WHERE thread_id=? AND account_key=?').get(thread, target.key)) return { joined: true, target: profile(target.key, session.key) };
    return transaction(db, () => {
      const existing = db.prepare("SELECT * FROM chat_group_invitations WHERE thread_id=? AND target=? AND state='pending'").get(thread, target.key);
      if (existing && existing.expires_at > Date.now() && existing.target_epoch === epoch(thread, target.key)
        && db.prepare('SELECT 1 FROM chat_members WHERE thread_id=? AND account_key=?').get(thread, existing.inviter)) return invitation(existing, session.key);
      if (existing) db.prepare("UPDATE chat_group_invitations SET state='expired',updated_at=? WHERE id=?").run(now(), existing.id);
      consumeQuota(db, 'group-invite:' + session.key, 50, 3600000);
      const id = newId(), at = now(); db.prepare('INSERT INTO chat_group_invitations VALUES(?,?,?,?,?,?,?,?,?)').run(id, thread, session.key, target.key, epoch(thread, target.key), 'pending', Date.now() + 7 * 86400000, at, at);
      tell(target.key); emit(null, thread, 'threads', {}); return invitation(db.prepare('SELECT * FROM chat_group_invitations WHERE id=?').get(id), session.key);
    });
  }
  function invitation(row, viewer) {
    return { id: row.id, threadId: row.thread_id, title: db.prepare('SELECT title FROM chat_threads WHERE id=?').get(row.thread_id)?.title || '已解散的群聊', inviter: profile(row.inviter, viewer), target: profile(row.target, viewer), state: row.state, expiresAt: row.expires_at, createdAt: row.created_at };
  }
  function openConnection(key, id) { db.prepare('INSERT INTO chat_presence_connections VALUES(?,?,?)').run(id, key, Date.now()); live.set(id, key); broadcastProfile(key); }
  function closeConnection(id) { if(closed)return;const key = live.get(id); live.delete(id); db.prepare('DELETE FROM chat_presence_connections WHERE id=?').run(id); if (key) broadcastProfile(key); }
  const expiredPresence = setInterval(() => {
    const stale = db.prepare('SELECT DISTINCT account_key FROM chat_presence_connections WHERE heartbeat_at<?').all(Date.now() - 75000);
    db.prepare('DELETE FROM chat_presence_connections WHERE heartbeat_at<?').run(Date.now() - 75000); for (const { account_key } of stale) broadcastProfile(account_key);
  }, 15000); expiredPresence.unref();
  ensureProfiles();

  async function handle(session, req, res, url, json) {
    const path = url.pathname, method = req.method;
    if (path === '/api/chat/profile' && method === 'GET') { json(res, { item: profile(session.key, session.key) }); return true; }
    if (path === '/api/chat/profile' && method === 'PATCH') {
      const data = await readJson(req); const old = profile(session.key, session.key);
      check(data.version === old.version, '资料已在其他窗口修改，请重新读取后保存。', 409, 'version_conflict');
      const display = cleanText(data.displayName ?? old.displayName, '显示名称', 40, true);
      const status = data.status ?? old.preferredStatus; check(['online','away','busy','invisible','offline'].includes(status), '在线状态无效。');
      const avatar = data.avatarId === undefined ? old.avatarId : data.avatarId;
      if (avatar) check(db.prepare("SELECT 1 FROM staged_files s JOIN media m ON m.id=s.media_id WHERE s.media_id=? AND s.actor=? AND m.mime LIKE 'image/%'").get(avatar, 'chat:' + session.key) || avatar === old.avatarId, '头像须为本人上传的图片。', 403, 'avatar_forbidden');
      const result = db.prepare('UPDATE chat_profiles SET display_name=?,avatar_id=?,preferred_status=?,version=version+1,updated_at=? WHERE account_key=? AND version=?').run(display, avatar || null, status, now(), session.key, data.version);
      check(result.changes, '资料已变更，请刷新后保存。', 409, 'version_conflict'); broadcastProfile(session.key); json(res, { item: profile(session.key, session.key) }); return true;
    }
    if (path === '/api/chat/presence/heartbeat' && method === 'POST') {
      const was=profile(session.key,session.key)?.status;for(const [id,key]of live)if(key===session.key)db.prepare('INSERT INTO chat_presence_connections VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at').run(id,key,Date.now());if(profile(session.key,session.key)?.status!==was)broadcastProfile(session.key);json(res, { item: profile(session.key, session.key) }); return true;
    }
    if (path === '/api/chat/users' && method === 'GET') {
      consumeQuota(db, 'user-search:' + session.key, 90, 60000); const query = cleanText(url.searchParams.get('q'), '用户ID或名称', 80, true);
      check(query.length >= 2, '请至少输入两个字符。');
      json(res, { items: users(session.key).filter((p) => [p.key,p.id,p.username,p.displayName].some((text) => text.toLowerCase().includes(query.toLowerCase()))).slice(0, 30).map((p) => ({ ...p, relationship: relationship(session.key, p.key) })) }); return true;
    }
    if (path === '/api/chat/friends' && method === 'GET') { json(res, { items: friends(session.key) }); return true; }
    if (path === '/api/chat/friend-requests' && method === 'GET') {
      const rows = db.prepare('SELECT * FROM chat_friend_requests WHERE requester=? OR target=? ORDER BY updated_at DESC LIMIT 100').all(session.key, session.key);
      json(res, { items: rows.map((r) => ({ id:r.id,from:profile(r.requester,session.key),to:profile(r.target,session.key),state:r.state,version:r.version,createdAt:r.created_at })) }); return true;
    }
    if (path === '/api/chat/friend-requests' && method === 'POST') {
      const data = await readJson(req); const target = resolveUser(data.target); check(target && target.key !== session.key, '请选择有效的其他账号。');
      let value;
      transaction(db, () => {
        const key = pair(session.key, target.key); const prior = db.prepare('SELECT * FROM chat_friend_requests WHERE pair_key=?').get(key);
        if (isFriend(session.key, target.key)) { value = { state:'accepted', alreadyFriends:true }; return; }
        if (prior?.state === 'pending' && prior.requester === session.key) { value = { id:prior.id,state:'pending' }; return; }
        consumeQuota(db, 'friend-request:' + session.key, 30, 3600000);
        const at=now();
        if (prior?.state === 'pending' && prior.target === session.key) {
          const [a,b] = [session.key,target.key].sort(); db.prepare('INSERT INTO chat_friendships VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(key,a,b,at);
          db.prepare("UPDATE chat_friend_requests SET state='accepted',version=version+1,updated_at=? WHERE id=?").run(at,prior.id); value={id:prior.id,state:'accepted'};
        } else {
          const id = prior?.id || newId();
          db.prepare("INSERT INTO chat_friend_requests VALUES(?,?,?,?,'pending',1,?,?) ON CONFLICT(pair_key) DO UPDATE SET requester=excluded.requester,target=excluded.target,state='pending',version=version+1,updated_at=excluded.updated_at").run(id,key,session.key,target.key,at,at);
          value={id,state:'pending'};
        }
      }); tell(session.key); tell(target.key); json(res, { item:value }); return true;
    }
    const friendAction = /^\/api\/chat\/friend-requests\/([0-9a-f-]{36})\/(accept|reject|cancel)$/.exec(path);
    if (friendAction && method === 'POST') {
      const [,id,action]=friendAction; let state;
      transaction(db,()=>{
        const row=db.prepare('SELECT * FROM chat_friend_requests WHERE id=?').get(id); check(row,'申请不存在。',404);
        check(action==='cancel'?row.requester===session.key:row.target===session.key,'不能处理别人的申请。',403);
        state=action==='accept'?'accepted':action==='reject'?'rejected':'canceled';
        if(row.state===state)return; check(row.state==='pending','申请已处理，请重新读取。',409);
        if(state==='accepted'){const[a,b]=[row.requester,row.target].sort();db.prepare('INSERT INTO chat_friendships VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(row.pair_key,a,b,now());}
        db.prepare('UPDATE chat_friend_requests SET state=?,version=version+1,updated_at=? WHERE id=?').run(state,now(),id);tell(row.requester);tell(row.target);
      });json(res,{state});return true;
    }
    if (path === '/api/chat/invitations' && method === 'GET') {
      db.prepare("UPDATE chat_group_invitations SET state='expired',updated_at=? WHERE state='pending' AND expires_at<=?").run(now(),Date.now());
      json(res,{items:db.prepare('SELECT * FROM chat_group_invitations WHERE target=? OR inviter=? ORDER BY created_at DESC LIMIT 100').all(session.key,session.key).map((r)=>invitation(r,session.key))});return true;
    }
    const inviteRoute=/^\/api\/chat\/threads\/([0-9a-f-]{36})\/invitations$/.exec(path);
    if(inviteRoute && method==='POST'){const data=await readJson(req);json(res,{item:invite(session,inviteRoute[1],data.target)},201);return true;}
    const inviteAction=/^\/api\/chat\/invitations\/([0-9a-f-]{36})\/(accept|reject|revoke)$/.exec(path);
    if(inviteAction && method==='POST'){
      const[,id,action]=inviteAction;let result;
      transaction(db,()=>{
        const row=db.prepare('SELECT * FROM chat_group_invitations WHERE id=?').get(id);check(row,'邀请不存在。',404);
        if(action==='revoke')check(row.inviter===session.key || db.prepare('SELECT owner FROM chat_threads WHERE id=?').get(row.thread_id)?.owner===session.key,'不能撤销此邀请。',403);
        else check(row.target===session.key,'邀请不属于当前账号。',403);
        const desired=action==='accept'?'accepted':action==='reject'?'rejected':'revoked';
        if(row.state===desired && (desired!=='accepted'||db.prepare('SELECT 1 FROM chat_members WHERE thread_id=? AND account_key=?').get(row.thread_id,session.key))){result=invitation(row,session.key);return;}
        check(row.state==='pending' && row.expires_at>Date.now(),'邀请已失效，请让群成员重新邀请。',410,'invitation_expired');
        check(db.prepare('SELECT 1 FROM chat_members WHERE thread_id=? AND account_key=?').get(row.thread_id,row.inviter),'邀请人已退出群聊，邀请失效。',410,'inviter_left');
        check(epoch(row.thread_id,row.target)===row.target_epoch,'退出后须重新接受新的邀请。',410,'invitation_stale');
        if(desired==='accepted'){
          check(db.prepare('SELECT count(*) AS n FROM chat_members WHERE thread_id=?').get(row.thread_id).n<30,'群成员已满。',409);
          db.prepare('INSERT INTO chat_members(thread_id,account_key,joined_at) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(row.thread_id,session.key,now()); invalidateRoster(row.thread_id);
        }
        db.prepare('UPDATE chat_group_invitations SET state=?,updated_at=? WHERE id=?').run(desired,now(),id);tell(row.target);tell(row.inviter);result=invitation({...row,state:desired},session.key);
      });json(res,{item:result});return true;
    }
    if(path==='/api/chat/preferences'){
      if(method==='PATCH') {const d=await readJson(req);check(['sound','taskbar','desktop'].every(k=>typeof d[k]==='boolean'),'提醒设置无效。');db.prepare('INSERT INTO chat_client_preferences VALUES(?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET sound=excluded.sound,taskbar=excluded.taskbar,desktop=excluded.desktop,updated_at=excluded.updated_at').run(session.key,+d.sound,+d.taskbar,+d.desktop,now());}
      if(['PATCH','GET'].includes(method)){const p=db.prepare('SELECT * FROM chat_client_preferences WHERE account_key=?').get(session.key);json(res,{item:{sound:p?!!p.sound:serviceDefaults().defaultSound!==false,taskbar:p?!!p.taskbar:serviceDefaults().defaultTaskbar!==false,desktop:p?!!p.desktop:serviceDefaults().defaultDesktop!==false}});return true;}
    }
    if(path==='/api/chat/notifications/claim' && method==='POST'){
      const data=await readJson(req);const row=db.prepare('SELECT * FROM chat_messages WHERE id=?').get(Number(data.messageId));check(row,'消息不存在。',404);own(session,row.thread_id);
      const read=db.prepare('SELECT 1 FROM chat_message_reads WHERE account_key=? AND message_id=?').get(session.key,row.id);
      let claimed=false;if(row.sender_key!==session.key && row.status==='complete' && !read)claimed=!!db.prepare('INSERT INTO chat_notification_claims VALUES(?,?,?) ON CONFLICT DO NOTHING').run(session.key,row.id,now()).changes;
      const p=db.prepare('SELECT sound,taskbar,desktop FROM chat_client_preferences WHERE account_key=?').get(session.key);json(res,{notify:claimed,preferences:{sound:p?!!p.sound:serviceDefaults().defaultSound!==false,taskbar:p?!!p.taskbar:serviceDefaults().defaultTaskbar!==false,desktop:p?!!p.desktop:serviceDefaults().defaultDesktop!==false},item:claimed?{messageId:row.id,threadId:row.thread_id,sender:profile(row.sender_key,session.key)?.displayName || row.sender_name,body:row.body.slice(0,140)}:null});return true;
    }
    return false;
  }
  return {profile,users,resolveUser,friends,isFriend,relationship,members,ensureProfiles,invite,removeMember,invalidateRoster,openConnection,closeConnection,handle,
    message(row,viewer){const p=profile(row.senderKey || row.sender_key,viewer);return {...row,...(p?{senderName:p.displayName,senderId:p.id,senderAvatar:p.avatar}:{} )};},
    close(){closed=true;clearInterval(expiredPresence);db.prepare('DELETE FROM chat_presence_connections').run();live.clear();}};
}

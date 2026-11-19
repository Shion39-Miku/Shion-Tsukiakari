import { check, cleanText, consumeQuota, newId, now, priorResult, saveResult, sha256, transaction } from './core.mjs';
import { recordChange } from './logs.mjs';

const format = (row) => ({
  id: row.id,
  author: row.author || '匿名',
  anonymous: row.author === null,
  question: row.question,
  reply: row.reply,
  state: row.state,
  createdAt: row.created_at,
  publishedAt: row.published_at,
});

export function getQuestions(db, state) {
  const sql = state === 'published'
    ? "SELECT * FROM questions WHERE state = 'published' ORDER BY published_at DESC, id DESC"
    : "SELECT * FROM questions WHERE state = 'pending' ORDER BY created_at DESC, id DESC";
  return db.prepare(sql).all().map(format);
}

function activeQuestion(db, id) {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  check(row, '没有找到这封来信。', 404, 'not_found');
  check(row.state !== 'deleted', '这封来信已删除。', 410, 'question_deleted');
  return row;
}

export function submitQuestion(db, data, actor, key, quota) {
  check(data.anonymous == null || typeof data.anonymous === 'boolean', '匿名选项格式有误。');
  const signature = cleanText(data.author, '署名', 40);
  const author = data.anonymous ? null : signature || null;
  const question = cleanText(data.question, '问题', 1200, true);
  const fingerprint = sha256(JSON.stringify([author, question]));
  return transaction(db, () => {
    const scope = `${actor}:question`;
    const prior = priorResult(db, scope, key, fingerprint);
    if (prior) {
      activeQuestion(db, prior.id);
      return prior;
    }
    if (quota) consumeQuota(db, actor, 5, 10 * 60 * 1000);
    const id = newId();
    const createdAt = now();
    db.prepare("INSERT INTO questions VALUES (?, ?, ?, NULL, 'pending', ?, NULL)").run(id, author, question, createdAt);
    db.prepare('INSERT INTO events (question_id, created_at) VALUES (?, ?)').run(id, createdAt);
    db.prepare('INSERT INTO bot_events (type, question_id, payload, created_at) VALUES (?, ?, ?, ?)').run('question.created', id, '{}', createdAt);
    db.prepare('INSERT INTO site_changes (topic, created_at) VALUES (?, ?)').run('inbox', createdAt);
    return saveResult(db, scope, key, fingerprint, { id, state: 'pending', message: '已收到，等待回复' });
  });
}

export function deleteQuestion(db, id, actor = 'admin:local') {
  return transaction(db, () => {
    const exists = db.prepare('SELECT state FROM questions WHERE id = ?').get(id);
    check(exists, '没有找到这封来信。', 404, 'not_found');
    if (exists.state !== 'deleted') {
      db.prepare("UPDATE questions SET author = NULL, question = '', reply = NULL, state = 'deleted', published_at = NULL WHERE id = ?")
        .run(id);
      recordChange(db, actor, 'delete', 'questions', id, '删除来信及其答复');
    }
    return { id, state: 'deleted' };
  });
}

function botCursor(db, botId) {
  return db.prepare('SELECT through_event FROM event_cursors WHERE bot_id = ?').get(botId)?.through_event ?? 0;
}

export function listEvents(db, botId, after, limit, contentOnly = false, base = '') {
  const acknowledgedThrough = botCursor(db, botId);
  const cursor = after ?? acknowledgedThrough;
  const rows = db.prepare(`SELECT e.id, e.type, e.payload, e.question_id, e.created_at, q.state, q.author, q.question
    FROM bot_events e LEFT JOIN questions q ON e.question_id = q.id WHERE e.id > ? ${contentOnly ? "AND e.type = 'content.synced'" : ''} ORDER BY e.id LIMIT ?`)
    .all(cursor, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => row.type === 'content.synced' ? {
    id: row.id, type: row.type, createdAt: row.created_at, ...(() => {
      const payload = JSON.parse(row.payload);
      for (const item of [...payload.newItems, ...payload.updatedItems]) if (item.url) item.url = base + item.url;
      return { ...payload, id: row.id, type: row.type, createdAt: row.created_at };
    })(),
  } : ({
    id: row.id,
    type: 'question.created',
    questionId: row.question_id,
    createdAt: row.created_at,
    state: row.state,
    ...(row.state === 'deleted' ? {} : { author: row.author || '匿名', question: row.question }),
  }));
  return { items, nextCursor: items.at(-1)?.id ?? cursor, acknowledgedThrough, hasMore };
}

export function ackEvents(db, botId, through, contentOnly = false) {
  check(Number.isSafeInteger(through) && through > 0, 'through 必须是正整数事件 ID。');
  return transaction(db, () => {
    const event = db.prepare('SELECT type FROM bot_events WHERE id = ?').get(through);
    check(event && (!contentOnly || event.type === 'content.synced'), '未找到获授权的事件。', 404, 'not_found');
    db.prepare(`INSERT INTO event_cursors VALUES (?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET through_event = max(through_event, excluded.through_event)`)
      .run(botId, through);
    return { acknowledgedThrough: botCursor(db, botId) };
  });
}

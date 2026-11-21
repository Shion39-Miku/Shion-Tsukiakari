import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { openDatabase, readConfig, root } from '../server/core.mjs';
import { setAdmin } from '../server/auth.mjs';
import { seedDemo } from '../server/demo.mjs';
import { regeneratePreviews } from '../server/media.mjs';
import { migrateMediaMetadata } from '../server/media-maintenance.mjs';
import { pruneChat } from '../server/chat-retention.mjs';

async function promptPassword() {
  if (!stdin.isTTY) throw new Error('请在交互式终端运行，或设置 ADMIN_PASSWORD 环境变量。');
  stdout.write('请输入管理员密码（至少 8 个字符，输入不回显） ');
  const mute = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const reader = createInterface({ input: stdin, output: mute, terminal: true });
  try {
    return await reader.question('', { signal: AbortSignal.timeout(5 * 60 * 1000) });
  } finally {
    reader.close();
    stdout.write('\n');
  }
}

async function snapshot(db, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  closeSync(openSync(destination, 'wx', 0o600));
  try {
    await backup(db, destination);
  } catch (error) {
    unlinkSync(destination);
    throw error;
  }
}

async function main() {
  const [command, argument] = process.argv.slice(2).filter((arg) => arg !== '--');
  const { dbPath } = readConfig();
  if (command === 'restore') {
    if (!argument) throw new Error('请提供备份文件路径。');
    if ([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].some(existsSync)) {
      throw new Error('恢复目标必须是新路径。请将 DATABASE_PATH 指向新文件。');
    }
    const source = new DatabaseSync(resolve(argument), { readOnly: true });
    try {
      if (source.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
        || source.prepare('PRAGMA foreign_key_check').get()
        || !source.prepare('SELECT name FROM schema_migrations LIMIT 1').get()) {
        throw new Error('备份未通过完整性或迁移检查。');
      }
      mkdirSync(dirname(dbPath), { recursive: true });
      const work = mkdtempSync(join(dirname(dbPath), '.tsukiakari-restore-'));
      const prepared = join(work, 'restored.sqlite');
      try {
        await snapshot(source, prepared);
        const restored = openDatabase(prepared);
        try {
          restored.exec('PRAGMA secure_delete = ON');
          await pruneChat(restored);
          restored.exec('DELETE FROM chat_sessions; DELETE FROM sessions; VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
          if (restored.prepare('PRAGMA foreign_key_check').get()) throw new Error('恢复副本的关联完整性检查失败。');
        } finally { restored.close(); }
        // A hard link publishes the completed file atomically and refuses an existing destination.
        linkSync(prepared, dbPath);
        console.log(`已清理到期消息并恢复至 ${dbPath}。`);
      } finally {
        for (const file of [prepared, prepared + '-wal', prepared + '-shm']) if (existsSync(file)) unlinkSync(file);
        rmdirSync(work);
      }
    } finally {
      source.close();
    }
    return;
  }
  if (!['migrate', 'seed', 'admin', 'backup', 'previews', 'chat-prune'].includes(command)) throw new Error('可用命令为 migrate、seed、admin、backup、restore、previews、chat-prune。');
  if (command === 'chat-prune' && !existsSync(dbPath)) throw new Error('聊天数据库路径不存在，请核对 DATABASE_PATH。');
  const db = openDatabase(dbPath);
  try {
    if (command === 'chat-prune') {
      db.exec('PRAGMA secure_delete = ON');
      console.log(JSON.stringify(await pruneChat(db)));
      return;
    }
    migrateMediaMetadata(db);
    if (command === 'migrate') console.log(`迁移完成 ${dbPath}`);
    if (command === 'previews') console.log('已从原图重新生成 ' + await regeneratePreviews(db, true) + ' 组高清预览，刷新前台即可更新。');
    if (command === 'seed') console.log(await seedDemo(db) ? '演示数据已写入。' : '此数据库已经初始化过演示数据。');
    if (command === 'admin') {
      const username = process.env.ADMIN_USERNAME || 'owner';
      await setAdmin(db, username, process.env.ADMIN_PASSWORD || await promptPassword());
      console.log(`管理员 ${username} 已就绪。`);
    }
    if (command === 'backup') {
      const file = argument ? resolve(argument) : resolve(root, 'backups', `moonlit-${new Date().toISOString().replaceAll(':', '-')}.sqlite`);
      await snapshot(db, file);
      console.log(`已备份至 ${file}`);
    }
  } finally {
    db.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

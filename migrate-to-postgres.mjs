import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './db.mjs';

function usernameFor(user) {
  if (user.username) return user.username;
  const local = String(user.email || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  return local.length >= 3 ? local.slice(0, 20) : `user${user.id}`;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('请在 .env 中设置 DATABASE_URL（Neon PostgreSQL 连接字符串）后再运行。');
  process.exit(1);
}

const source = new DatabaseSync(path.join(process.cwd(), 'data', 'shunshun.db'));
const target = await createDatabase({ dataDir: path.join(process.cwd(), 'data'), databaseUrl });
await target.init();

const { rows: countRows } = await target.query(
  'SELECT (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM records)::int AS records',
);
const counts = countRows[0];
if (counts.users > 0 || counts.records > 0) {
  console.error('目标 PostgreSQL 数据库里已经有数据，为避免重复或覆盖，迁移已停止。');
  console.error('请换一个空的 Neon 数据库，或先备份并清空目标库后再运行。');
  process.exit(1);
}

const client = await target.pool.connect();
try {
  await client.query('BEGIN');

  const users = source.prepare('SELECT * FROM users ORDER BY id').all();
  let adminAssigned = false;
  for (const user of users) {
    const username = usernameFor(user);
    const isAdmin = Boolean(user.is_admin) || (!adminAssigned && user.email !== 'demo@shunshun.app');
    if (isAdmin) adminAssigned = true;
    await client.query(
      `INSERT INTO users (id, email, username, nickname, password_hash, created_at, consent_at, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        user.id,
        user.email,
        username,
        user.nickname,
        user.password_hash,
        user.created_at,
        user.consent_at,
        isAdmin,
      ],
    );
  }

  const records = source.prepare('SELECT * FROM records ORDER BY id').all();
  for (const record of records) {
    await client.query(
      `INSERT INTO records (id, user_id, occurred_at, local_date, bristol, color, amount, ease, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.id,
        record.user_id,
        record.occurred_at,
        record.local_date,
        record.bristol,
        record.color,
        record.amount,
        record.ease,
        record.notes,
        record.created_at,
        record.updated_at,
      ],
    );
  }

  const messages = source.prepare('SELECT * FROM messages ORDER BY id').all();
  for (const message of messages) {
    await client.query(
      'INSERT INTO messages (id, user_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)',
      [message.id, message.user_id, message.role, message.content, message.created_at],
    );
  }

  for (const table of ['users', 'records', 'messages']) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`,
    );
  }

  await client.query('COMMIT');
  console.log(`迁移完成：${users.length} 个用户，${records.length} 条记录，${messages.length} 条对话。`);
  console.log('历史登录会话没有迁移，用户需要在 Render 地址重新登录。');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('迁移失败，已回滚：', error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await target.close();
  source.close();
}

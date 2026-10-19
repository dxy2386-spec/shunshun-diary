import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SQLITE_SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    username TEXT,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    consent_at TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    bristol INTEGER NOT NULL,
    color TEXT NOT NULL,
    amount TEXT NOT NULL,
    ease TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_records_user_date ON records(user_id, local_date);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);

  CREATE TABLE IF NOT EXISTS admin_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    target_user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(id);
`;

const POSTGRES_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    username TEXT,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    consent_at TIMESTAMPTZ,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL,
    local_date TEXT NOT NULL,
    bristol INTEGER NOT NULL,
    color TEXT NOT NULL,
    amount TEXT NOT NULL,
    ease TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_records_user_date ON records(user_id, local_date);

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
  ALTER TABLE users ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE TABLE IF NOT EXISTS admin_actions (
    id SERIAL PRIMARY KEY,
    admin_id INTEGER NOT NULL,
    target_user_id INTEGER,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(id);
`;

function usernameBase(email, id) {
  const local = String(email || '')
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '');
  const base = local.length >= 3 ? local : `user${id}`;
  return base.slice(0, 20);
}

function uniqueUsername(base, used) {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 21)}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

class SqliteDatabase {
  constructor(filename) {
    this.filename = filename;
    this.db = new DatabaseSync(filename);
  }

  async init() {
    this.db.exec(SQLITE_SCHEMA);
    const columns = this.db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
    if (!columns.includes('username')) this.db.exec('ALTER TABLE users ADD COLUMN username TEXT');
    if (!columns.includes('is_admin')) this.db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
    const users = this.db.prepare('SELECT id, email, username FROM users ORDER BY id').all();
    const used = new Set(users.map((user) => user.username).filter(Boolean));
    for (const user of users) {
      if (user.username) continue;
      const username = uniqueUsername(usernameBase(user.email, user.id), used);
      this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, user.id);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    await this.ensureAdmin();
    return this;
  }

  async ensureAdmin() {
    const admin = this.db.prepare('SELECT id FROM users WHERE is_admin = 1 LIMIT 1').get();
    if (!admin) {
      const fallback = this.db
        .prepare("SELECT id FROM users WHERE username <> 'demo' ORDER BY id LIMIT 1")
        .get();
      if (fallback) this.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(fallback.id);
    }
    const adminName = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
    if (adminName) {
      this.db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(adminName);
    }
  }

  async ping() {
    this.db.prepare('SELECT 1').get();
    return true;
  }

  async findUserByEmail(email) {
    return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  async findUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  async findUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }

  async createUser({ email, username, nickname, passwordHash, createdAt, consentAt, isAdmin = false }) {
    const result = this.db
      .prepare(
        'INSERT INTO users (email, username, nickname, password_hash, created_at, consent_at, is_admin) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(email, username, nickname, passwordHash, createdAt, consentAt || null, isAdmin ? 1 : 0);
    return this.findUserById(Number(result.lastInsertRowid));
  }

  async createSession({ userId, tokenHash, expiresAt, createdAt }) {
    this.db
      .prepare('INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, tokenHash, expiresAt, createdAt);
  }

  async deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async deleteExpiredSessions(userId, now) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(userId, now);
  }

  async findAuthSession(tokenHash) {
    return this.db
      .prepare(
        `SELECT u.id, u.username, u.nickname, u.created_at, u.is_admin, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash);
  }

  async getUserStats(userId) {
    return this.db
      .prepare('SELECT COUNT(*) AS total, MIN(local_date) AS firstDate FROM records WHERE user_id = ?')
      .get(userId);
  }

  async listRecords(userId, limit = 400) {
    return this.db
      .prepare('SELECT * FROM records WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?')
      .all(userId, limit);
  }

  async getRecord(id, userId) {
    return this.db.prepare('SELECT * FROM records WHERE id = ? AND user_id = ?').get(id, userId);
  }

  async createRecord(data) {
    const result = this.db
      .prepare(
        `INSERT INTO records (user_id, occurred_at, local_date, bristol, color, amount, ease, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.userId,
        data.occurredAt,
        data.localDate,
        data.bristol,
        data.color,
        data.amount,
        data.ease,
        data.notes,
        data.createdAt,
        data.updatedAt,
      );
    return this.getRecord(Number(result.lastInsertRowid), data.userId);
  }

  async updateRecord(id, userId, data) {
    this.db
      .prepare(
        `UPDATE records SET occurred_at = ?, local_date = ?, bristol = ?, color = ?, amount = ?, ease = ?, notes = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`,
      )
      .run(
        data.occurredAt,
        data.localDate,
        data.bristol,
        data.color,
        data.amount,
        data.ease,
        data.notes,
        data.updatedAt,
        id,
        userId,
      );
    return this.getRecord(id, userId);
  }

  async deleteRecord(id, userId) {
    this.db.prepare('DELETE FROM records WHERE id = ? AND user_id = ?').run(id, userId);
  }

  async listMessages(userId, limit = 60) {
    return this.db
      .prepare('SELECT id, role, content, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?')
      .all(userId, limit);
  }

  async createMessage({ userId, role, content, createdAt }) {
    const result = this.db
      .prepare('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, role, content, createdAt);
    return { id: Number(result.lastInsertRowid), role, content, created_at: createdAt };
  }

  async clearMessages(userId) {
    this.db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
  }

  async deleteUser(userId) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  async countAdmins() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n);
  }

  async setAdmin(userId, isAdmin) {
    this.db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, userId);
    return this.findUserById(userId);
  }

  async getRecordById(id) {
    return this.db.prepare('SELECT * FROM records WHERE id = ?').get(id);
  }

  async deleteRecordById(id) {
    this.db.prepare('DELETE FROM records WHERE id = ?').run(id);
  }

  async addAdminAction({ adminId, targetUserId = null, action, details = '', createdAt }) {
    const result = this.db
      .prepare(
        'INSERT INTO admin_actions (admin_id, target_user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(adminId, targetUserId, action, details, createdAt);
    return Number(result.lastInsertRowid);
  }

  async adminOverview() {
    const users = this.db
      .prepare(
        `SELECT u.id, u.username, u.nickname, u.created_at, u.is_admin,
         (SELECT COUNT(*) FROM records r WHERE r.user_id = u.id) AS record_count
         FROM users u ORDER BY u.id`,
      )
      .all()
      .map((user) => ({ ...user, is_admin: Boolean(user.is_admin), record_count: Number(user.record_count) }));
    const actions = this.db
      .prepare(
        `SELECT a.id, a.action, a.details, a.created_at, a.target_user_id,
         u.username AS admin_username
         FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
         ORDER BY a.id DESC LIMIT 20`,
      )
      .all();
    const totals = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM records) AS records,
         (SELECT COUNT(*) FROM users WHERE is_admin = 1) AS admins`,
      )
      .get();
    return { users, actions, totals };
  }

  async close() {
    this.db.close();
  }
}

class PostgresDatabase {
  constructor(connectionString, pgModule = null) {
    this.connectionString = connectionString;
    this.pgModule = pgModule;
    this.pool = null;
  }

  async init() {
    const pg = this.pgModule || (await import('pg')).default;
    const isLocal = /localhost|127\.0\.0\.1/.test(this.connectionString);
    this.pool = new pg.Pool({
      connectionString: this.connectionString,
      max: 5,
      ssl: isLocal || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    });
    await this.pool.query(POSTGRES_SCHEMA);
    const { rows: users } = await this.pool.query('SELECT id, email, username FROM users ORDER BY id');
    const used = new Set(users.map((user) => user.username).filter(Boolean));
    for (const user of users) {
      if (user.username) continue;
      const username = uniqueUsername(usernameBase(user.email, user.id), used);
      await this.pool.query('UPDATE users SET username = $1 WHERE id = $2', [username, user.id]);
    }
    await this.pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)');
    await this.ensureAdmin();
    return this;
  }

  async ensureAdmin() {
    const { rows: admins } = await this.pool.query('SELECT id FROM users WHERE is_admin = TRUE LIMIT 1');
    if (!admins.length) {
      const { rows: fallback } = await this.pool.query(
        "SELECT id FROM users WHERE username <> 'demo' ORDER BY id LIMIT 1",
      );
      if (fallback[0]) {
        await this.pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [fallback[0].id]);
      }
    }
    const adminName = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
    if (adminName) {
      await this.pool.query('UPDATE users SET is_admin = TRUE WHERE username = $1', [adminName]);
    }
  }

  async query(sql, params = []) {
    return this.pool.query(sql, params);
  }

  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  async findUserByEmail(email) {
    const { rows } = await this.query('SELECT * FROM users WHERE email = $1', [email]);
    return rows[0] || null;
  }

  async findUserByUsername(username) {
    const { rows } = await this.query('SELECT * FROM users WHERE username = $1', [username]);
    return rows[0] || null;
  }

  async findUserById(id) {
    const { rows } = await this.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async createUser({ email, username, nickname, passwordHash, createdAt, consentAt, isAdmin = false }) {
    const { rows } = await this.query(
      `INSERT INTO users (email, username, nickname, password_hash, created_at, consent_at, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [email, username, nickname, passwordHash, createdAt, consentAt || null, Boolean(isAdmin)],
    );
    return rows[0];
  }

  async createSession({ userId, tokenHash, expiresAt, createdAt }) {
    await this.query(
      'INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)',
      [userId, tokenHash, expiresAt, createdAt],
    );
  }

  async deleteSession(tokenHash) {
    await this.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  }

  async deleteExpiredSessions(userId, now) {
    await this.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at < $2', [userId, now]);
  }

  async findAuthSession(tokenHash) {
    const { rows } = await this.query(
      `SELECT u.id, u.username, u.nickname, u.created_at, u.is_admin, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    );
    return rows[0] || null;
  }

  async getUserStats(userId) {
    const { rows } = await this.query(
      'SELECT COUNT(*)::int AS total, MIN(local_date) AS "firstDate" FROM records WHERE user_id = $1',
      [userId],
    );
    return rows[0];
  }

  async listRecords(userId, limit = 400) {
    const { rows } = await this.query(
      'SELECT * FROM records WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT $2',
      [userId, limit],
    );
    return rows;
  }

  async getRecord(id, userId) {
    const { rows } = await this.query('SELECT * FROM records WHERE id = $1 AND user_id = $2', [id, userId]);
    return rows[0] || null;
  }

  async createRecord(data) {
    const { rows } = await this.query(
      `INSERT INTO records (user_id, occurred_at, local_date, bristol, color, amount, ease, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        data.userId,
        data.occurredAt,
        data.localDate,
        data.bristol,
        data.color,
        data.amount,
        data.ease,
        data.notes,
        data.createdAt,
        data.updatedAt,
      ],
    );
    return rows[0];
  }

  async updateRecord(id, userId, data) {
    const { rows } = await this.query(
      `UPDATE records SET occurred_at = $1, local_date = $2, bristol = $3, color = $4, amount = $5,
       ease = $6, notes = $7, updated_at = $8 WHERE id = $9 AND user_id = $10 RETURNING *`,
      [
        data.occurredAt,
        data.localDate,
        data.bristol,
        data.color,
        data.amount,
        data.ease,
        data.notes,
        data.updatedAt,
        id,
        userId,
      ],
    );
    return rows[0] || null;
  }

  async deleteRecord(id, userId) {
    await this.query('DELETE FROM records WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  async listMessages(userId, limit = 60) {
    const { rows } = await this.query(
      'SELECT id, role, content, created_at FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
      [userId, limit],
    );
    return rows;
  }

  async createMessage({ userId, role, content, createdAt }) {
    const { rows } = await this.query(
      'INSERT INTO messages (user_id, role, content, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, role, content, createdAt],
    );
    return rows[0];
  }

  async clearMessages(userId) {
    await this.query('DELETE FROM messages WHERE user_id = $1', [userId]);
  }

  async deleteUser(userId) {
    await this.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  async countAdmins() {
    const { rows } = await this.query('SELECT COUNT(*)::int AS n FROM users WHERE is_admin = TRUE');
    return Number(rows[0].n);
  }

  async setAdmin(userId, isAdmin) {
    const { rows } = await this.query('UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING *', [
      Boolean(isAdmin),
      userId,
    ]);
    return rows[0] || null;
  }

  async getRecordById(id) {
    const { rows } = await this.query('SELECT * FROM records WHERE id = $1', [id]);
    return rows[0] || null;
  }

  async deleteRecordById(id) {
    await this.query('DELETE FROM records WHERE id = $1', [id]);
  }

  async addAdminAction({ adminId, targetUserId = null, action, details = '', createdAt }) {
    const { rows } = await this.query(
      `INSERT INTO admin_actions (admin_id, target_user_id, action, details, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [adminId, targetUserId, action, details, createdAt],
    );
    return rows[0].id;
  }

  async adminOverview() {
    const { rows: users } = await this.query(
      'SELECT id, username, nickname, created_at, is_admin FROM users ORDER BY id',
    );
    const { rows: counts } = await this.query(
      'SELECT user_id, COUNT(*)::int AS n FROM records GROUP BY user_id',
    );
    const countMap = new Map(counts.map((row) => [row.user_id, Number(row.n)]));
    const { rows: actions } = await this.query(
      `SELECT a.id, a.action, a.details, a.created_at, a.target_user_id,
       u.username AS admin_username
       FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
       ORDER BY a.id DESC LIMIT 20`,
    );
    const { rows: totals } = await this.query(
      `SELECT (SELECT COUNT(*)::int FROM users) AS users,
       (SELECT COUNT(*)::int FROM records) AS records,
       (SELECT COUNT(*)::int FROM users WHERE is_admin = TRUE) AS admins`,
    );
    return {
      users: users.map((user) => ({ ...user, record_count: countMap.get(user.id) || 0 })),
      actions,
      totals: totals[0],
    };
  }

  async close() {
    await this.pool?.end();
  }
}

export async function createDatabase({ dataDir, databaseUrl, pgModule = null }) {
  if (databaseUrl) {
    if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) {
      throw new Error('DATABASE_URL 必须是 PostgreSQL 连接字符串');
    }
    return new PostgresDatabase(databaseUrl, pgModule);
  }
  return new SqliteDatabase(path.join(dataDir, 'shunshun.db'));
}

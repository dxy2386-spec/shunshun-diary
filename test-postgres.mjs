import assert from 'node:assert/strict';
import { newDb } from 'pg-mem';
import { createDatabase } from './db.mjs';

const mem = newDb();
const pg = mem.adapters.createPg();
const db = await createDatabase({
  dataDir: './data',
  databaseUrl: 'postgres://localhost/test',
  pgModule: pg,
});
await db.init();
assert.equal(await db.ping(), true);

const user = await db.createUser({
  email: 'pg-test@example.com',
  nickname: 'PG 测试',
  passwordHash: 'hash',
  createdAt: new Date().toISOString(),
  consentAt: new Date().toISOString(),
});
assert.ok(user.id);

await db.createSession({
  userId: user.id,
  tokenHash: 'token-hash',
  expiresAt: new Date(Date.now() + 864e5).toISOString(),
  createdAt: new Date().toISOString(),
});
const auth = await db.findAuthSession('token-hash');
assert.equal(auth.email, 'pg-test@example.com');

const now = new Date().toISOString();
const record = await db.createRecord({
  userId: user.id,
  occurredAt: now,
  localDate: '2026-10-19',
  bristol: 4,
  color: 'brown',
  amount: 'medium',
  ease: 'easy',
  notes: '测试',
  createdAt: now,
  updatedAt: now,
});
assert.ok(record.id);

const records = await db.listRecords(user.id);
assert.equal(records.length, 1);
assert.equal(records[0].notes, '测试');

const updated = await db.updateRecord(record.id, user.id, {
  occurredAt: now,
  localDate: '2026-10-19',
  bristol: 3,
  color: 'brown',
  amount: 'medium',
  ease: 'easy',
  notes: '已修改',
  updatedAt: new Date().toISOString(),
});
assert.equal(updated.bristol, 3);
assert.equal(updated.notes, '已修改');

const stats = await db.getUserStats(user.id);
assert.equal(Number(stats.total), 1);
assert.equal(stats.firstDate, '2026-10-19');

const message = await db.createMessage({
  userId: user.id,
  role: 'user',
  content: '你好',
  createdAt: new Date().toISOString(),
});
assert.ok(message.id);
assert.equal((await db.listMessages(user.id)).length, 1);
await db.clearMessages(user.id);
assert.equal((await db.listMessages(user.id)).length, 0);

await db.deleteRecord(record.id, user.id);
assert.equal((await db.listRecords(user.id)).length, 0);
await db.deleteUser(user.id);
assert.equal(await db.findUserByEmail('pg-test@example.com'), null);

await db.close();
console.log('PostgreSQL adapter test passed');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStorage } = require('../storage');

test('file storage persists encrypted records and serializes concurrent inserts', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slated-storage-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const storage = createStorage({ dataDir, databaseUrl: '', persistenceMode: 'file' });
  const results = await Promise.all([
    storage.setIfAbsent('users', 'acct:one', 'encrypted-record'),
    storage.setIfAbsent('users', 'acct:one', 'other-record'),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.ok(['encrypted-record', 'other-record'].includes(await storage.get('users', 'acct:one')));

  await storage.set('vault', 'acct:one', 'encrypted-credentials');
  const reloaded = createStorage({ dataDir });
  assert.equal(await reloaded.get('vault', 'acct:one'), 'encrypted-credentials');

  await reloaded.remove('vault', 'acct:one');
  assert.equal(await storage.get('vault', 'acct:one'), null);
});

test('PostgreSQL storage uses parameterized values and session expiry', async () => {
  const rows = new Map();
  const queries = [];
  const pool = {
    on() {},
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT 1 FROM slated_key_value')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('INSERT INTO slated_key_value')) {
        const [namespace, itemKey, serializedValue, expiresAt] = params;
        const key = `${namespace}:${itemKey}`;
        if (sql.includes('DO NOTHING') && rows.has(key)) return { rows: [], rowCount: 0 };
        rows.set(key, {
          value: JSON.parse(serializedValue),
          expiresAt,
        });
        return { rows: [{ item_key: itemKey }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT value FROM slated_key_value')) {
        const row = rows.get(`${params[0]}:${params[1]}`);
        return { rows: row ? [{ value: row.value }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.startsWith('DELETE FROM slated_key_value')) {
        rows.delete(`${params[0]}:${params[1]}`);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async end() {},
  };
  const storage = createStorage({ pool, persistenceMode: 'postgres' });
  const expiry = new Date(Date.now() + 60_000);

  await storage.set('sessions', 'session-id', { userId: 'acct:one' }, { expiresAt: expiry });
  assert.deepEqual(await storage.get('sessions', 'session-id'), { userId: 'acct:one' });
  assert.equal(rows.get('sessions:session-id').expiresAt, expiry);
  assert.ok(queries.every(({ params }) => !params.some((value) => String(value).includes('slated_key_value'))));

  await storage.remove('sessions', 'session-id');
  assert.equal(await storage.get('sessions', 'session-id'), null);
});

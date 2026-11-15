const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILES = Object.freeze({
  users: 'users.enc.json',
  vault: 'vault.enc.json',
  sessions: 'sessions.enc.json',
});

function createStorage({
  databaseUrl = process.env.DATABASE_URL,
  dataDir = process.env.DATA_DIR || path.join(__dirname, '.data'),
  pool: suppliedPool,
  persistenceMode: requestedPersistenceMode = process.env.PERSISTENCE,
} = {}) {
  const persistenceMode =
    requestedPersistenceMode || (databaseUrl || process.env.VERCEL ? 'postgres' : 'file');
  if (!['file', 'postgres'].includes(persistenceMode)) {
    throw new Error('PERSISTENCE must be either "file" or "postgres".');
  }
  if (process.env.VERCEL && persistenceMode !== 'postgres') {
    throw new Error('Vercel deployments require PERSISTENCE=postgres.');
  }
  if (persistenceMode === 'postgres' && !databaseUrl && !suppliedPool) {
    throw new Error('DATABASE_URL is required when PERSISTENCE=postgres.');
  }
  let pool = suppliedPool || null;
  const ownsPool = !suppliedPool && Boolean(databaseUrl);

  if (!pool && databaseUrl) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      allowExitOnIdle: true,
    });
    pool.on('error', (error) => {
      console.error('Unexpected PostgreSQL pool error:', error.message);
    });
  }

  let schemaPromise = null;
  const writeQueues = new Map();
  let lastPruneAt = 0;

  function getFile(namespace) {
    const filename = FILES[namespace];
    if (!filename) throw new Error(`Unknown storage namespace: ${namespace}`);
    return path.join(dataDir, filename);
  }

  async function runFileWrite(namespace, operation) {
    const previous = writeQueues.get(namespace) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    writeQueues.set(namespace, next);
    return next;
  }

  async function waitForFileWrites(namespace) {
    const pending = writeQueues.get(namespace);
    if (pending) await pending;
  }

  function readFileStore(namespace) {
    const filePath = getFile(namespace);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error(`Could not read local ${namespace} storage.`, { cause: error });
    }

    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected a JSON object.');
      }
      return value;
    } catch (error) {
      throw new Error(`Local ${namespace} storage is invalid JSON.`, { cause: error });
    }
  }

  function writeFileStore(namespace, value) {
    const filePath = getFile(namespace);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;

    try {
      fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      fs.renameSync(tempPath, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(tempPath);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') {
          console.error('Could not remove temporary storage file:', cleanupError.message);
        }
      }
      throw new Error(`Could not write local ${namespace} storage.`, { cause: error });
    }
  }

  async function ensureSchema() {
    if (!pool) return;
    if (!schemaPromise) {
      schemaPromise = pool
        .query('SELECT 1 FROM slated_key_value LIMIT 0')
        .catch((error) => {
          schemaPromise = null;
          const schemaError = new Error(
            'PostgreSQL storage schema is unavailable. Run npm run db:migrate before serving traffic.',
            { cause: error }
          );
          schemaError.status = 503;
          throw schemaError;
        });
    }
    await schemaPromise;

    if (Date.now() - lastPruneAt > 60 * 60 * 1000) {
      lastPruneAt = Date.now();
      try {
        await pool.query('DELETE FROM slated_key_value WHERE expires_at <= NOW()');
      } catch (error) {
        lastPruneAt = 0;
        console.error('Could not prune expired PostgreSQL sessions:', error.message);
      }
    }
  }

  async function queryDatabase(sql, params) {
    try {
      return await pool.query(sql, params);
    } catch (cause) {
      console.error('PostgreSQL storage query failed:', cause.message);
      const error = new Error('Persistent storage is unavailable.', { cause });
      error.status = 503;
      throw error;
    }
  }

  function normalizeExpiry(expiresAt) {
    if (expiresAt == null) return null;
    const value = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(value.getTime())) throw new Error('Invalid storage expiry.');
    return value;
  }

  async function get(namespace, key) {
    if (!FILES[namespace]) throw new Error(`Unknown storage namespace: ${namespace}`);
    if (pool) {
      await ensureSchema();
      const result = await queryDatabase(
        `SELECT value FROM slated_key_value
         WHERE namespace = $1 AND item_key = $2
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [namespace, String(key)]
      );
      return result.rows[0] ? result.rows[0].value : null;
    }

    await waitForFileWrites(namespace);
    const store = readFileStore(namespace);
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
  }

  async function set(namespace, key, value, { expiresAt = null } = {}) {
    if (!FILES[namespace]) throw new Error(`Unknown storage namespace: ${namespace}`);
    const expiry = normalizeExpiry(expiresAt);
    if (pool) {
      await ensureSchema();
      await queryDatabase(
        `INSERT INTO slated_key_value (namespace, item_key, value, expires_at)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (namespace, item_key)
         DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
        [namespace, String(key), JSON.stringify(value), expiry]
      );
      return;
    }

    await runFileWrite(namespace, () => {
      const store = readFileStore(namespace);
      store[key] = value;
      writeFileStore(namespace, store);
    });
  }

  async function setIfAbsent(namespace, key, value) {
    if (!FILES[namespace]) throw new Error(`Unknown storage namespace: ${namespace}`);
    if (pool) {
      await ensureSchema();
      const result = await queryDatabase(
        `INSERT INTO slated_key_value (namespace, item_key, value)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (namespace, item_key) DO NOTHING
         RETURNING item_key`,
        [namespace, String(key), JSON.stringify(value)]
      );
      return result.rowCount === 1;
    }

    return runFileWrite(namespace, () => {
      const store = readFileStore(namespace);
      if (Object.prototype.hasOwnProperty.call(store, key)) return false;
      store[key] = value;
      writeFileStore(namespace, store);
      return true;
    });
  }

  async function remove(namespace, key) {
    if (!FILES[namespace]) throw new Error(`Unknown storage namespace: ${namespace}`);
    if (pool) {
      await ensureSchema();
      await queryDatabase('DELETE FROM slated_key_value WHERE namespace = $1 AND item_key = $2', [
        namespace,
        String(key),
      ]);
      return;
    }

    await runFileWrite(namespace, () => {
      const store = readFileStore(namespace);
      if (!Object.prototype.hasOwnProperty.call(store, key)) return;
      delete store[key];
      writeFileStore(namespace, store);
    });
  }

  async function check() {
    if (pool) await ensureSchema();
    return true;
  }

  async function close() {
    if (pool && ownsPool) await pool.end();
  }

  return { mode: pool ? 'postgres' : 'file', get, set, setIfAbsent, remove, check, close };
}

module.exports = { createStorage };

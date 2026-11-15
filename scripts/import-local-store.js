const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const stores = [
  ['users', 'users.enc.json'],
  ['vault', 'vault.enc.json'],
  ['sessions', 'sessions.enc.json'],
];

function readStore(filePath) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed = JSON.parse(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Local store must be a JSON object: ${path.basename(filePath)}`);
  }
  return parsed;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set before importing local storage.');
  }

  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', '.data'));
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    max: 1,
  });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let imported = 0;
      for (const [namespace, filename] of stores) {
        const values = readStore(path.join(dataDir, filename));
        for (const [itemKey, value] of Object.entries(values)) {
          const expiresAt =
            namespace === 'sessions' && value && value.expiresAt
              ? new Date(value.expiresAt)
              : null;
          if (expiresAt && Number.isNaN(expiresAt.getTime())) {
            throw new Error(`Invalid session expiry in ${filename}.`);
          }
          const result = await client.query(
            `INSERT INTO slated_key_value (namespace, item_key, value, expires_at)
             VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (namespace, item_key) DO NOTHING
             RETURNING item_key`,
            [namespace, itemKey, JSON.stringify(value), expiresAt]
          );
          imported += result.rowCount;
        }
      }
      await client.query('COMMIT');
      console.log(`Imported ${imported} encrypted local records into PostgreSQL.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Local storage import failed: ${error.message}`);
  process.exitCode = 1;
});

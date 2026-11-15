const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL must be set before running database migrations.');
  }

  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '001_create_storage.sql'),
    'utf8'
  );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    max: 1,
  });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      console.log('PostgreSQL storage schema is up to date.');
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
  console.error(`Database migration failed: ${error.message}`);
  process.exitCode = 1;
});

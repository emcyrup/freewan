// マイグレーション適用スクリプト。
// src/db/migrations/NNN_*.sql をファイル名順に、未適用のものだけトランザクション内で適用する。
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/db/migrations'
);

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[migrate] skip: ${file}（適用済み）`);
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`マイグレーション失敗: ${file}: ${err.message}`);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('[migrate] 完了');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

import pg from 'pg';
import { loadConfig } from '../config.js';

const config = loadConfig();

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

// 接続エラーでプロセスが黙って死なないように必ず捕捉する
pool.on('error', (err) => {
  console.error('[db] pool error:', err.message);
});

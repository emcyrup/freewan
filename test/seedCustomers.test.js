import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedCustomers, removeCustomers, DEMO_FAMILIES } from '../scripts/seed-customers.js';

function makePool({ existingPhones = [] } = {}) {
  const queries = [];
  let nextId = 1;
  const pool = {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id FROM customers WHERE phone_norm/.test(sql)) {
        return { rows: existingPhones.includes(params[0]) ? [{ id: 999 }] : [] };
      }
      if (/INSERT INTO customers/.test(sql)) return { rows: [{ id: nextId++ }] };
      if (/DELETE FROM customers/.test(sql)) {
        return { rows: [{ name: 'デモ顧客' }] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

test('デモ顧客とペットを投入する（10世帯・14頭）', async () => {
  const pool = makePool();
  const result = await seedCustomers(pool);

  assert.equal(result.added.length, 10);
  assert.equal(result.skipped.length, 0);

  const petInserts = pool.queries.filter((q) => /INSERT INTO pets/.test(q.sql));
  assert.equal(petInserts.length, 14);
  // ペットは投入した顧客の id に紐づく
  assert.equal(petInserts[0].params[1], 'マロン');
  assert.equal(petInserts[0].params[2], 'トイプードル');
  assert.match(petInserts[0].params[4], /テディベアカット/);
});

test('同じ電話番号の顧客が既にいれば世帯ごとスキップする', async () => {
  const pool = makePool({ existingPhones: ['09012345678'] });
  const result = await seedCustomers(pool);

  assert.deepEqual(result.skipped, ['田中 里奈']);
  assert.equal(result.added.length, 9);
  const petInserts = pool.queries.filter((q) => /INSERT INTO pets/.test(q.sql));
  assert.equal(petInserts.length, 12, 'スキップした世帯のペット（2頭）は入れない');
});

test('削除は LINE 連携済みの顧客を残す条件になっている', async () => {
  const pool = makePool();
  await removeCustomers(pool);
  const del = pool.queries.find((q) => /DELETE FROM customers/.test(q.sql));
  assert.match(del.sql, /line_user_id IS NULL/);
  assert.equal(del.params[0].length, DEMO_FAMILIES.length);
});

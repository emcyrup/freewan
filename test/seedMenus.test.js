import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedMenus, DEMO_MENUS } from '../scripts/seed-menus.js';

function makePool({ existingNames = [], nextSortOrder = 0 } = {}) {
  const queries = [];
  let nextId = 1;
  const pool = {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/max\(sort_order\)/.test(sql)) return { rows: [{ next: nextSortOrder }] };
      // WHERE NOT EXISTS 相当。既存の名前なら行を返さない
      if (existingNames.includes(params[0])) return { rows: [] };
      return { rows: [{ id: nextId++ }] };
    },
  };
  return pool;
}

test('デモメニューを投入し、表示順を連番で振る', async () => {
  const pool = makePool();
  const result = await seedMenus(pool);

  assert.equal(result.added.length, DEMO_MENUS.length);
  assert.equal(result.skipped.length, 0);

  const inserts = pool.queries.filter((q) => /INSERT INTO menus/.test(q.sql));
  assert.equal(inserts[0].params[0], 'シャンプーコース');
  assert.equal(inserts[0].params[1], 60);
  assert.deepEqual(
    inserts.map((q) => q.params[2]),
    DEMO_MENUS.map((_, i) => i),
    'sort_order は 0 から連番'
  );
});

test('同名メニューが既にあれば追加せずスキップする', async () => {
  const pool = makePool({ existingNames: ['シャンプーコース', '一時預かり'] });
  const result = await seedMenus(pool);

  assert.deepEqual(result.skipped, ['シャンプーコース', '一時預かり']);
  assert.equal(result.added.length, DEMO_MENUS.length - 2);
  assert.ok(!result.added.includes('シャンプーコース'));
});

test('既存メニューがある場合は表示順をその後ろから振る', async () => {
  const pool = makePool({ nextSortOrder: 5 });
  await seedMenus(pool, [{ name: 'テスト', durationMinutes: 30 }]);

  const insert = pool.queries.find((q) => /INSERT INTO menus/.test(q.sql));
  assert.equal(insert.params[2], 5);
});

test('重複挿入を SQL 側でも防いでいる', async () => {
  const pool = makePool();
  await seedMenus(pool, [{ name: 'シャンプーコース', durationMinutes: 60 }]);
  const insert = pool.queries.find((q) => /INSERT INTO menus/.test(q.sql));
  assert.match(insert.sql, /WHERE NOT EXISTS \(SELECT 1 FROM menus WHERE name = \$1\)/);
});

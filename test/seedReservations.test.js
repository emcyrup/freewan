import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  seedReservations,
  removeReservations,
  DEMO_RESERVATIONS,
  DEMO_PREFIX,
} from '../scripts/seed-reservations.js';

function makePool({ petNames = null, menus = [], staffNames = [], existingRefs = [] } = {}) {
  const names = petNames ?? [...new Set(DEMO_RESERVATIONS.map((r) => r.pet))];
  const queries = [];
  let nextId = 1000;
  const pool = {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM pets p/.test(sql)) {
        return {
          rows: params[0]
            .filter((n) => names.includes(n))
            .map((n, i) => ({ pet_id: 10 + i, name: n, customer_id: 100 + i })),
        };
      }
      if (/FROM menus/.test(sql)) return { rows: menus };
      if (/SELECT id FROM staff/.test(sql)) {
        return { rows: staffNames.includes(params[0]) ? [{ id: 7 }] : [] };
      }
      if (/INSERT INTO staff/.test(sql)) return { rows: [{ id: nextId++ }] };
      if (/INSERT INTO reservations/.test(sql)) {
        const externalId = params[params.length - 1];
        return { rows: existingRefs.includes(externalId) ? [] : [{ id: nextId++ }] };
      }
      if (/DELETE FROM reservations/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }] };
      return { rows: [] };
    },
  };
  return pool;
}

test('デモ予約を投入する', async () => {
  const pool = makePool();
  const result = await seedReservations(pool);

  assert.equal(result.added.length, DEMO_RESERVATIONS.length);
  assert.deepEqual(result.missing, []);
  const inserts = pool.queries.filter((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(inserts.length, DEMO_RESERVATIONS.length);
});

test('予約サービスを通さず、通知を伴わない直接の INSERT で入れる', async () => {
  const pool = makePool();
  await seedReservations(pool);
  const inserts = pool.queries.filter((q) => /INSERT INTO reservations/.test(q.sql));
  for (const q of inserts) {
    // 文字列連結でクエリを組み立てていないこと（値は必ずパラメータ）
    assert.doesNotMatch(q.sql, /VALUES\s*\([^$)]*'/);
    assert.ok(q.params.length > 0);
  }
});

test('LINE 連携済みの顧客にはぶら下げない（配信対象になり得るため）', async () => {
  const pool = makePool();
  await seedReservations(pool);
  const lookup = pool.queries.find((q) => /FROM pets p/.test(q.sql));
  assert.match(lookup.sql, /c\.line_user_id IS NULL/);
});

test('デモ顧客が未投入なら、その子ぶんは飛ばして知らせる', async () => {
  const pool = makePool({ petNames: ['マロン'] });
  const result = await seedReservations(pool);

  assert.ok(result.missing.length > 0);
  assert.ok(!result.missing.includes('マロン'));
  const inserts = pool.queries.filter((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(inserts.length, DEMO_RESERVATIONS.filter((r) => r.pet === 'マロン').length);
});

test('二重投入されない（external_id で判定し、既にあれば skipped）', async () => {
  const pool = makePool({ existingRefs: [DEMO_PREFIX + 'r01'] });
  const result = await seedReservations(pool);

  assert.deepEqual(result.skipped, ['r01']);
  assert.equal(result.added.length, DEMO_RESERVATIONS.length - 1);
  const insert = pool.queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.match(insert.sql, /ON CONFLICT \(external_id\) DO NOTHING/);
});

test('区分と所要時間はメニュー表を正とし、無ければ組み込みの表で補う', async () => {
  const pool = makePool({
    menus: [{ name: 'シャンプーコース', category: 'trimming', duration_minutes: 45 }],
  });
  await seedReservations(pool);
  const inserts = pool.queries.filter((q) => /INSERT INTO reservations/.test(q.sql));
  const shampoo = inserts.find((q) => q.params[2] === 'シャンプーコース');
  assert.equal(shampoo.params[5], 'trimming');
  assert.equal(shampoo.params[6], 45, 'menus テーブルの値が優先される');

  const school = inserts.find((q) => q.params[2] === 'ペットスクール');
  assert.equal(school.params[5], 'school');
  assert.equal(school.params[6], 480, 'menus に無ければ組み込みの表から');
});

test('日時は実行日からの相対で、JST の日付として組み立てる', async () => {
  const pool = makePool();
  await seedReservations(pool);
  const insert = pool.queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.match(insert.sql, /AT TIME ZONE 'Asia\/Tokyo'/);
  assert.equal(typeof insert.params[8], 'number', '日数はパラメータで渡す');
  assert.match(insert.params[9], /^\d{1,2}:\d{2}$/);
});

test('時間が重なる予約を1組だけ含む（赤い重複表示を確かめるため）', () => {
  const trimming = DEMO_RESERVATIONS.filter(
    (r) => r.staff && ['requested', 'confirmed'].includes(r.status)
      && ['シャンプーコース', 'カットコース', 'シャンプー＆カットコース', '部分カット（顔・足まわり）']
        .includes(r.menu)
  );
  const mins = { 'シャンプーコース': 60, 'カットコース': 90,
    'シャンプー＆カットコース': 120, '部分カット（顔・足まわり）': 30 };
  const at = (r) => {
    const [h, m] = r.time.split(':').map(Number);
    return r.day * 1440 + h * 60 + m;
  };
  const pairs = [];
  for (let i = 0; i < trimming.length; i++) {
    for (let j = i + 1; j < trimming.length; j++) {
      const a = trimming[i], b = trimming[j];
      if (a.staff !== b.staff) continue;
      if (at(a) < at(b) + mins[b.menu] && at(b) < at(a) + mins[a.menu]) pairs.push([a.ref, b.ref]);
    }
  }
  assert.deepEqual(pairs, [['r01', 'r02']]);
});

test('スクール以外に段階は入れない', () => {
  for (const r of DEMO_RESERVATIONS) {
    if (!r.stage) continue;
    assert.ok(['ペットスクール', '体験入園'].includes(r.menu), `${r.ref} は school 区分であること`);
    assert.ok(['counseling', 'trial', 'enrolled'].includes(r.stage));
  }
});

test('削除はデモぶんだけを消す', async () => {
  const pool = makePool();
  const { removed } = await removeReservations(pool);
  assert.equal(removed, 2);
  const del = pool.queries.find((q) => /DELETE FROM reservations/.test(q.sql));
  assert.equal(del.params[0], 'demo:%', '手入力した本物の予約は消さない');
});

test('カウンセリング同時実施の回を1件含む（段階とは別に持つ）', async () => {
  const pool = makePool();
  await seedReservations(pool);
  const inserts = pool.queries.filter((q) => /INSERT INTO reservations/.test(q.sql));
  const withCons = inserts.filter((q) => q.params[12] === true);
  assert.equal(withCons.length, 1);
  assert.equal(withCons[0].params[7], 'trial', '段階は体験のまま。カウンセリングで上書きしない');
  assert.match(inserts[0].sql, /with_counseling/);
});

test('デモ予約には来店経路が入っている（集計の確認に使うため）', async () => {
  const pool = makePool();
  await seedReservations(pool);
  const inserts = pool.queries.filter((q) => /INSERT INTO reservations/.test(q.sql));
  assert.match(inserts[0].sql, /source/);
  const sources = inserts.map((q) => q.params[13]);
  assert.equal(sources.filter(Boolean).length, DEMO_RESERVATIONS.length, '全件に経路がある');
  assert.ok(new Set(sources).size >= 4, '経路が偏らず、棒グラフの見え方を確かめられる');
});

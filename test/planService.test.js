import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanService, monthRange, carryDeadline } from '../src/plans/service.js';

test('月初・月末は JST の暦どおり（年またぎ・うるう年も）', () => {
  assert.deepEqual(monthRange({ year: 2026, month: 7 }), { first: '2026-07-01', last: '2026-07-31' });
  assert.deepEqual(monthRange({ year: 2026, month: 2 }), { first: '2026-02-01', last: '2026-02-28' });
  assert.deepEqual(monthRange({ year: 2028, month: 2 }), { first: '2028-02-01', last: '2028-02-29' });
  assert.deepEqual(monthRange({ year: 2026, month: 12 }), { first: '2026-12-01', last: '2026-12-31' });
});

test('繰越の期限は「n ヶ月後の月末」', () => {
  // 繰越なし＝当月末で切れる
  assert.equal(carryDeadline({ year: 2026, month: 7 }, 0), '2026-07-31');
  assert.equal(carryDeadline({ year: 2026, month: 7 }, 1), '2026-08-31');
  assert.equal(carryDeadline({ year: 2026, month: 7 }, 2), '2026-09-30');
  // 年をまたぐとき
  assert.equal(carryDeadline({ year: 2026, month: 12 }, 1), '2027-01-31');
});

// SQL は実 DB で確認しているため、ここは入力の検証と呼び出し方だけを見る
function makePool(rows = []) {
  const queries = [];
  return {
    queries,
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/FROM plans WHERE id/.test(sql)) return { rows: [{ '?column?': 1 }] };
        return { rows, rowCount: rows.length };
      },
    },
  };
}

test('プランの入力を検証する', async () => {
  const { pool } = makePool([{ id: 1 }]);
  const svc = createPlanService({ pool });
  await assert.rejects(() => svc.createPlan({ name: ' ', monthlyQuota: 4 }), /invalid_name/);
  await assert.rejects(() => svc.createPlan({ name: 'A', monthlyQuota: 0 }), /invalid_quota/);
  await assert.rejects(() => svc.createPlan({ name: 'A', monthlyQuota: 4.5 }), /invalid_quota/);
  await assert.rejects(
    () => svc.createPlan({ name: 'A', monthlyQuota: 4, carryOverMonths: -1 }),
    /invalid_carry_over/
  );
});

test('付与・消化の入力を検証する（符号や種別の取り違えを弾く）', async () => {
  const { pool } = makePool([{ id: 1 }]);
  const svc = createPlanService({ pool });
  await assert.rejects(() => svc.grant({ petId: 1, source: 'points', count: 1, effectiveOn: '2026-07-01' }), /invalid_source/);
  await assert.rejects(() => svc.grant({ petId: 1, source: 'ticket', count: 0, effectiveOn: '2026-07-01' }), /invalid_count/);
  await assert.rejects(() => svc.grant({ petId: 1, source: 'ticket', count: -3, effectiveOn: '2026-07-01' }), /invalid_count/);
  await assert.rejects(() => svc.consume({ petId: 1, source: 'points' }), /invalid_source/);
  await assert.rejects(() => svc.consume({ petId: 1, source: 'ticket', count: 0 }), /invalid_count/);
});

test('加入は存在するプランだけ受け付ける', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push(sql);
      if (/FROM plans WHERE id/.test(sql)) return { rows: [] };   // 見つからない
      return { rows: [{ id: 1 }] };
    },
  };
  const svc = createPlanService({ pool });
  await assert.rejects(() => svc.enroll({ petId: 1, planId: 999 }), /plan_not_found/);
});

test('加入中の子をもう一度加入させようとしたら分かるエラーになる', async () => {
  const pool = {
    query: async (sql) => {
      if (/FROM plans WHERE id/.test(sql)) return { rows: [{ id: 1 }] };
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      throw err;
    },
  };
  const svc = createPlanService({ pool });
  await assert.rejects(() => svc.enroll({ petId: 1, planId: 1 }), /already_enrolled/);
});

test('消化は期限切れの付与を対象にしない', async () => {
  const captured = [];
  const client = {
    query: async (sql, params) => {
      captured.push({ sql, params });
      if (/FROM plan_credits g/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
    release() {},
  };
  const svc = createPlanService({ pool: { connect: async () => client } });
  const result = await svc.consume({ petId: 1, source: 'ticket', count: 2, on: '2026-07-15' });

  const select = captured.find((q) => /FROM plan_credits g/.test(q.sql));
  assert.match(select.sql, /g\.expires_on IS NULL OR g\.expires_on >= \$3::date/);
  assert.match(select.sql, /FOR UPDATE OF g/, '同時実行での二重消化を防ぐ');
  // 残りが無ければ消化0・不足2を返す（例外にしない）
  assert.deepEqual(result, { consumed: 0, shortfall: 2, used: [] });
});

test('保育コースは当月分から、回数券は期限の近いものから消化する', async () => {
  const orders = [];
  const client = {
    query: async (sql) => {
      if (/FROM plan_credits g/.test(sql)) orders.push(sql);
      return { rows: [] };
    },
    release() {},
  };
  const svc = createPlanService({ pool: { connect: async () => client } });
  await svc.consume({ petId: 1, source: 'plan', on: '2026-07-15' });
  await svc.consume({ petId: 1, source: 'ticket', on: '2026-07-15' });

  assert.match(orders[0], /ORDER BY g\.effective_on DESC/, '当月分（新しい付与）を先に消化');
  assert.match(orders[1], /ORDER BY g\.expires_on ASC NULLS LAST/, '期限の近いものから消化');
});

test('加入したその場で当月分を付与する（月途中でも日割りしない）', async () => {
  const inserts = [];
  const pool = {
    query: async (sql, params) => {
      if (/FROM plans WHERE id/.test(sql)) return { rows: [{ monthly_quota: 4, carry_over_months: 1 }] };
      if (/INSERT INTO pet_plans/.test(sql)) return { rows: [{ id: 7 }] };
      if (/INSERT INTO plan_credits/.test(sql)) inserts.push(params);
      return { rows: [] };
    },
  };
  const svc = createPlanService({ pool });
  const id = await svc.enroll({
    petId: 1, planId: 1, today: { year: 2026, month: 7, day: 20, iso: '2026-07-20' },
  });

  assert.equal(id, 7);
  assert.equal(inserts.length, 1);
  const [petId, count, effectiveOn, expiresOn] = inserts[0];
  assert.equal(petId, 1);
  assert.equal(count, 4, '月の途中でも満額');
  assert.equal(effectiveOn, '2026-07-01', '月初付けにして月次付与と重複させない');
  assert.equal(expiresOn, '2026-08-31', '繰越1ヶ月ぶんの期限');
});

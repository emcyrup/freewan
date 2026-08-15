import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReservationService } from '../src/reservations/service.js';

// 予約1件・メニュー・重なりの有無だけを持つ最小の pool。
// 「どんな UPDATE を投げたか」を見たいので、クエリは全部残しておく
function makeFakes({ current, menu = null, conflictRow = null, pet = null } = {}) {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM reservations WHERE id/.test(sql)) return { rows: current ? [current] : [] };
    if (/SELECT category, duration_minutes FROM menus WHERE name/.test(sql)) {
      return { rows: menu ? [menu] : [] };
    }
    if (/SELECT id, name FROM pets WHERE id/.test(sql)) return { rows: pet ? [pet] : [] };
    if (/FROM reservations r\s+JOIN customers c/.test(sql)) {
      return { rows: conflictRow ? [conflictRow] : [] };
    }
    return { rows: [], rowCount: 1 };
  };
  return { fakes: { pool: { query }, slack: { notify: async () => {} } }, queries };
}

const CURRENT = {
  id: 5, customer_id: 1, staff_id: 3, pet_id: 9,
  menu: 'カットコース', note: '爪も', reserved_at: '2026-08-20T01:00:00.000Z', status: 'confirmed',
};
const upd = (queries) => queries.find((q) => /UPDATE reservations/.test(q.sql));

test('日時・コース・担当・ご要望を直せる', async () => {
  const { fakes, queries } = makeFakes({
    current: CURRENT, menu: { category: 'trimming', duration_minutes: 60 },
  });
  const service = createReservationService(fakes);

  const result = await service.updateDetails(5, {
    reservedAt: '2026-08-21T02:00:00.000Z', menu: 'シャンプーコース', staffId: 4, note: '耳掃除も',
  });
  assert.deepEqual(result, { ok: true, reservationId: 5 });

  const q = upd(queries);
  assert.equal(q.params[1], '2026-08-21T02:00:00.000Z');
  assert.equal(q.params[2], 'シャンプーコース');
  assert.equal(q.params[3], 4);
  assert.equal(q.params[5], '耳掃除も');
  // 区分と所要時間はコースから引き直す（コースが変われば重なり方も変わるため）
  assert.equal(q.params[6], 'trimming');
  assert.equal(q.params[7], 60);
});

test('渡さなかった項目は今の値のまま残る', async () => {
  const { fakes, queries } = makeFakes({
    current: CURRENT, menu: { category: 'trimming', duration_minutes: 90 },
  });
  const service = createReservationService(fakes);

  await service.updateDetails(5, { reservedAt: '2026-08-22T02:00:00.000Z' });

  const q = upd(queries);
  assert.equal(q.params[2], 'カットコース', 'コースは変えていない');
  assert.equal(q.params[3], 3, '担当は変えていない');
  assert.equal(q.params[4], 9, 'わんちゃんは変えていない');
  assert.equal(q.params[5], '爪も', 'ご要望は変えていない');
});

test('担当やご要望は明示的に空にできる（未指定とは区別する）', async () => {
  const { fakes, queries } = makeFakes({ current: CURRENT });
  const service = createReservationService(fakes);

  await service.updateDetails(5, { staffId: null, note: null });

  const q = upd(queries);
  assert.equal(q.params[3], null, '指名なしに戻せる');
  assert.equal(q.params[5], null, 'ご要望を消せる');
});

test('同じ担当の時間が重なる先には動かせない', async () => {
  const { fakes, queries } = makeFakes({
    current: CURRENT,
    menu: { category: 'trimming', duration_minutes: 90 },
    conflictRow: { id: 12, reserved_at: '2026-08-21T02:00:00.000Z', customer_name: '山田' },
  });
  const service = createReservationService(fakes);

  const result = await service.updateDetails(5, { reservedAt: '2026-08-21T02:00:00.000Z' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'time_conflict');
  assert.equal(result.conflict.customerName, '山田', 'ぶつかった相手を返す');
  assert.equal(upd(queries), undefined, 'ぶつかったときは書き換えない');
});

test('重なりの判定で自分自身は相手に数えない', async () => {
  const { fakes, queries } = makeFakes({
    current: CURRENT, menu: { category: 'trimming', duration_minutes: 90 },
  });
  const service = createReservationService(fakes);

  await service.updateDetails(5, { note: 'ひとこと' });

  const check = queries.find((q) => /FROM reservations r\s+JOIN customers c/.test(q.sql));
  assert.equal(check.params[3], 5, '自分の id を除外して重なりを探す');
});

test('来店済・無断キャンセルは履歴なので直せない', async () => {
  for (const status of ['visited', 'no_show']) {
    const { fakes, queries } = makeFakes({ current: { ...CURRENT, status } });
    const service = createReservationService(fakes);
    const result = await service.updateDetails(5, { note: 'あとから追記' });
    assert.deepEqual(result, { ok: false, error: 'already_done' }, status);
    assert.equal(upd(queries), undefined, status + ' は書き換えない');
  }
});

test('他の飼い主様のわんちゃんには付け替えられない', async () => {
  const { fakes, queries } = makeFakes({ current: CURRENT, pet: null });
  const service = createReservationService(fakes);

  const result = await service.updateDetails(5, { petId: 99 });
  assert.deepEqual(result, { ok: false, error: 'invalid_pet' });
  assert.equal(upd(queries), undefined);
});

test('無い予約・おかしな日時・おかしな id は弾く', async () => {
  const { fakes } = makeFakes({ current: null });
  const noRow = createReservationService(fakes);
  assert.deepEqual(await noRow.updateDetails(5, {}), { ok: false, error: 'not_found' });

  const { fakes: f2 } = makeFakes({ current: CURRENT });
  const service = createReservationService(f2);
  assert.deepEqual(
    await service.updateDetails(5, { reservedAt: 'あした' }),
    { ok: false, error: 'invalid_reserved_at' }
  );
  assert.deepEqual(await service.updateDetails('5', {}), { ok: false, error: 'invalid_id' });
});

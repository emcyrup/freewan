import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReservationService } from '../src/reservations/service.js';

function makeFakes({ existingCustomer = null, insertedFlag = true } = {}) {
  const queries = [];
  let nextId = 100;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id, name FROM customers WHERE phone_norm/.test(sql)) {
        return { rows: existingCustomer ? [existingCustomer] : [] };
      }
      if (/SELECT id FROM staff WHERE name/.test(sql)) return { rows: [] };
      if (/INSERT INTO staff/.test(sql)) return { rows: [{ id: 9 }] };
      if (/INSERT INTO customers/.test(sql)) return { rows: [{ id: nextId++ }] };
      if (/INSERT INTO reservations/.test(sql)) {
        return { rows: [{ id: 55, inserted: insertedFlag }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client, query: client.query };
  const notifications = [];
  const slack = { notify: async (text) => notifications.push(text) };
  return { pool, slack, queries, notifications };
}

const baseInput = {
  externalId: 'hotpepper-123',
  customerName: '山田 花子',
  phone: '090-1234-5678',
  menu: 'カット',
  staffName: '佐藤',
  reservedAt: '2026-08-01T14:00:00+09:00',
};

test('upsertExternal: 新規予約は顧客・スタッフを作成して Slack 通知する', async () => {
  const { pool, slack, queries, notifications } = makeFakes();
  const service = createReservationService({ pool, slack });

  const result = await service.upsertExternal({ ...baseInput });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);

  const upsert = queries.find((q) => /ON CONFLICT \(external_id\) DO UPDATE/.test(q.sql));
  assert.ok(upsert, 'external_id で冪等に upsert する');
  assert.equal(upsert.params[6], 'hotpepper-123');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /新規予約/);
  assert.match(notifications[0], /山田 花子/);
  assert.match(notifications[0], /8月1日\(土\) 14:00/, '日時は JST の読みやすい形式で通知する');
});

test('upsertExternal: 既存予約の更新（2回目以降）は通知しない', async () => {
  const { pool, slack, notifications } = makeFakes({ insertedFlag: false });
  const service = createReservationService({ pool, slack });

  const result = await service.upsertExternal({ ...baseInput });
  assert.equal(result.created, false);
  assert.equal(notifications.length, 0, '更新のたびに Slack を鳴らさない');
});

test('upsertExternal: 既存顧客は電話番号で突合して再利用する', async () => {
  const { pool, slack, queries } = makeFakes({ existingCustomer: { id: 7, name: '山田' } });
  const service = createReservationService({ pool, slack });

  await service.upsertExternal({ ...baseInput });
  const customerInsert = queries.find((q) => /INSERT INTO customers/.test(q.sql));
  assert.equal(customerInsert, undefined, '既存顧客がいれば新規作成しない');
});

test('upsertExternal: visited 取り込みで last_visit_at が更新される', async () => {
  const { pool, slack, queries } = makeFakes();
  const service = createReservationService({ pool, slack });

  await service.upsertExternal({ ...baseInput, status: 'visited' });
  const touch = queries.find((q) => /SET last_visit_at = GREATEST/.test(q.sql));
  assert.ok(touch, 'visited は customers.last_visit_at に反映する');
});

test('upsertExternal: 不正入力は DB に触れず弾く', async () => {
  const { pool, slack, queries } = makeFakes();
  const service = createReservationService({ pool, slack });

  assert.deepEqual(await service.upsertExternal({ ...baseInput, externalId: null }), {
    ok: false,
    error: 'external_id_required',
  });
  assert.deepEqual(await service.upsertExternal({ ...baseInput, phone: 'abc' }), {
    ok: false,
    error: 'invalid_phone',
  });
  assert.deepEqual(await service.upsertExternal({ ...baseInput, reservedAt: 'not-a-date' }), {
    ok: false,
    error: 'invalid_reserved_at',
  });
  assert.equal(queries.length, 0);
});

test('setStatus: visited で last_visit_at が更新される', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      // 顧客通知の要否を判断するため、更新前の予約を読んでから UPDATE する
      if (/SELECT r\.id, r\.status/.test(sql)) {
        return {
          rows: [
            {
              id: 55, status: 'confirmed', customer_id: 7,
              reserved_at: new Date('2026-07-20T05:00:00Z'),
              customer_name: '山田', line_user_id: 'U1', menu: null, staff_name: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client };
  const service = createReservationService({ pool, slack: { notify: async () => {} } });

  const result = await service.setStatus(55, 'visited');
  assert.equal(result.ok, true);
  const touch = queries.find((q) => /SET last_visit_at = GREATEST/.test(q.sql));
  assert.ok(touch);
  assert.equal(touch.params[0], 7);
});

test('setStatus: 不正なステータスは拒否する', async () => {
  const service = createReservationService({ pool: {}, slack: {} });
  assert.deepEqual(await service.setStatus(1, 'deleted'), { ok: false, error: 'invalid_status' });
});

// ---- 来店登録と回数消化の連動 ----

function makeStatusFakes({ before, menuConsumes = null, consumeResult, summaryResult } = {}) {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT r\.id, r\.status/.test(sql)) return { rows: [before] };
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT consumes FROM menus/.test(sql)) {
        return { rows: menuConsumes ? [{ consumes: menuConsumes }] : [] };
      }
      return { rows: [] };
    },
  };
  const notifications = [];
  const slack = { notify: async (t) => notifications.push(t), notifyError: async () => {} };
  const calls = { consume: [], revoke: [], summary: [] };
  const planService = {
    consume: async (args) => {
      calls.consume.push(args);
      return consumeResult ?? { consumed: 1, shortfall: 0, used: [] };
    },
    revokeByReservation: async (id) => {
      calls.revoke.push(id);
      return { revoked: 1 };
    },
    summary: async (petId) => {
      calls.summary.push(petId);
      return summaryResult ?? { ticket: { remaining: 0 }, plan: null };
    },
  };
  return { pool, slack, planService, notifications, calls };
}

const visitBase = {
  id: 55, status: 'confirmed', customer_id: 7, pet_id: 3,
  reserved_at: new Date('2026-08-20T01:00:00Z'),
  customer_name: '田中', line_user_id: null, menu: '幼稚園（スクール）', staff_name: null,
};

test('setStatus: visited で消化対象メニューの回数を1回消化する', async () => {
  const fakes = makeStatusFakes({ before: { ...visitBase }, menuConsumes: 'plan' });
  const service = createReservationService({ ...fakes });

  const result = await service.setStatus(55, 'visited');
  assert.equal(result.ok, true);
  assert.equal(fakes.calls.consume.length, 1);
  const call = fakes.calls.consume[0];
  assert.equal(call.petId, 3);
  assert.equal(call.source, 'plan');
  assert.equal(call.count, 1);
  assert.equal(call.reservationId, 55, '消化は予約に紐付けて取り消せるようにする');
});

test('setStatus: コース加入中で残0なら消化せずスタッフへ通知する', async () => {
  const fakes = makeStatusFakes({
    before: { ...visitBase },
    menuConsumes: 'plan',
    consumeResult: { consumed: 0, shortfall: 1, used: [] },
    summaryResult: { ticket: { remaining: 0 }, plan: { remaining: 0, name: 'スクール 月4会員' } },
  });
  const service = createReservationService({ ...fakes });

  await service.setStatus(55, 'visited');
  assert.equal(fakes.notifications.length, 1);
  assert.match(fakes.notifications[0], /残回数がありません/);
});

test('setStatus: 未加入（残0・コースなし）は消化も通知もしない', async () => {
  const fakes = makeStatusFakes({
    before: { ...visitBase, menu: 'シャンプーコース' },
    menuConsumes: 'ticket',
    consumeResult: { consumed: 0, shortfall: 1, used: [] },
  });
  const service = createReservationService({ ...fakes });

  await service.setStatus(55, 'visited');
  assert.equal(fakes.notifications.length, 0, '回数券0は都度払いとみなして黙る');
});

test('setStatus: 消化対象外メニューやペット未設定では消化しない', async () => {
  const noConsume = makeStatusFakes({ before: { ...visitBase, menu: 'カットコース' } });
  await createReservationService({ ...noConsume }).setStatus(55, 'visited');
  assert.equal(noConsume.calls.consume.length, 0);

  const noPet = makeStatusFakes({ before: { ...visitBase, pet_id: null }, menuConsumes: 'plan' });
  await createReservationService({ ...noPet }).setStatus(55, 'visited');
  assert.equal(noPet.calls.consume.length, 0);
});

test('setStatus: 来店の取り消しで消化を予約ごと戻す', async () => {
  const fakes = makeStatusFakes({ before: { ...visitBase, status: 'visited' } });
  const service = createReservationService({ ...fakes });

  await service.setStatus(55, 'cancelled');
  assert.deepEqual(fakes.calls.revoke, [55]);
  assert.equal(fakes.calls.consume.length, 0);
});

// ---- 手入力予約のペット紐付け ----

function makeManualFakes({ petFound = true } = {}) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT name FROM customers WHERE id/.test(sql)) return { rows: [{ name: '田中' }] };
      if (/SELECT id, name FROM pets WHERE id = \$1 AND customer_id = \$2/.test(sql)) {
        return { rows: petFound ? [{ id: params[0], name: 'マロン' }] : [] };
      }
      if (/INSERT INTO reservations/.test(sql)) return { rows: [{ id: 77 }] };
      if (/SELECT name FROM staff/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
  const slack = { notify: async () => {}, notifyError: async () => {} };
  return { pool, slack, queries };
}

test('createManual: 他の顧客のペットは紐付けを拒否する', async () => {
  const { pool, slack } = makeManualFakes({ petFound: false });
  const service = createReservationService({ pool, slack });
  const result = await service.createManual({
    customerId: 7, reservedAt: '2026-08-20T10:00:00+09:00', menu: 'カット', petId: 3,
  });
  assert.deepEqual(result, { ok: false, error: 'invalid_pet' });
});

test('createManual: 正しいペットは pet_id 付きで登録される', async () => {
  const { pool, slack, queries } = makeManualFakes();
  const service = createReservationService({ pool, slack });
  const result = await service.createManual({
    customerId: 7, reservedAt: '2026-08-20T10:00:00+09:00', menu: 'カット', petId: 3,
  });
  assert.equal(result.ok, true);
  const insert = queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(insert.params[2], 3, 'pet_id を保存する');
});

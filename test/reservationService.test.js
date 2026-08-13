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
  assert.equal(upsert.params[5], 'hotpepper-123');
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

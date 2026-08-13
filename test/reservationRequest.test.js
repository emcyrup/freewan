import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReservationService } from '../src/reservations/service.js';
import {
  buildRequestReceivedMessage,
  buildConfirmedMessage,
  buildDeclinedMessage,
} from '../src/line/messages/reservationStatus.js';

const TOMORROW = new Date(Date.now() + 86400000).toISOString();

function makeFakes({ customer = { id: 7, name: '山田 花子' }, pending = 0, menu = { name: 'カット' }, staff = { name: '佐藤' } } = {}) {
  const queries = [];
  const notifications = [];
  const delivered = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM customers WHERE line_user_id/.test(sql)) return { rows: customer ? [customer] : [] };
      if (/count\(\*\)::int AS n/.test(sql)) return { rows: [{ n: pending }] };
      if (/FROM menus WHERE id/.test(sql)) return { rows: menu ? [menu] : [] };
      if (/FROM staff WHERE id/.test(sql)) return { rows: staff ? [staff] : [] };
      if (/INSERT INTO reservations/.test(sql)) return { rows: [{ id: 55 }] };
      return { rows: [] };
    },
  };
  const slack = { notify: async (t) => notifications.push(t) };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'sent' };
    },
  };
  return { pool, slack, lineClient, queries, notifications, delivered };
}

const baseRequest = { lineUserId: 'U1', menuId: 3, staffId: 2, reservedAt: TOMORROW, note: '短めで' };

// ---- リクエスト作成 ----

test('承認待ち（requested）で作成され、スタッフへ要対応通知が飛ぶ', async () => {
  const f = makeFakes();
  const service = createReservationService(f);

  const result = await service.createRequest({ ...baseRequest });
  assert.equal(result.ok, true);

  const insert = f.queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.match(insert.sql, /'requested'/, '確定ではなく承認待ちで入る');
  assert.equal(insert.params[2], 'カット', 'メニュー名は予約側にコピーする');
  assert.equal(insert.params[4], '短めで');
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /要対応/);
  assert.match(f.notifications[0], /山田 花子/);
});

test('未登録ユーザーからのリクエストは受け付けない', async () => {
  const f = makeFakes({ customer: null });
  const service = createReservationService(f);

  const result = await service.createRequest({ ...baseRequest });
  assert.deepEqual(result, { ok: false, error: 'not_registered' });
  assert.equal(f.notifications.length, 0);
});

test('過去日時・遠すぎる日時は弾く', async () => {
  const f = makeFakes();
  const service = createReservationService(f);

  const past = await service.createRequest({ ...baseRequest, reservedAt: '2020-01-01T10:00:00+09:00' });
  assert.equal(past.error, 'past_datetime');

  const far = new Date(Date.now() + 200 * 86400000).toISOString();
  assert.equal((await service.createRequest({ ...baseRequest, reservedAt: far })).error, 'too_far_ahead');

  assert.equal(f.queries.length, 0, 'DB に触れずに弾く');
});

test('承認待ちが溜まっている顧客は追加リクエストできない', async () => {
  const f = makeFakes({ pending: 3 });
  const service = createReservationService(f);

  const result = await service.createRequest({ ...baseRequest });
  assert.deepEqual(result, { ok: false, error: 'too_many_pending' });
});

test('無効なメニュー・担当は弾く', async () => {
  const noMenu = makeFakes({ menu: null });
  assert.equal(
    (await createReservationService(noMenu).createRequest({ ...baseRequest })).error,
    'invalid_menu'
  );
  const noStaff = makeFakes({ staff: null });
  assert.equal(
    (await createReservationService(noStaff).createRequest({ ...baseRequest })).error,
    'invalid_staff'
  );
});

// ---- 承認・見送り ----

function makeStatusFakes(currentStatus) {
  const reservation = {
    id: 55, status: currentStatus, customer_id: 7,
    reserved_at: new Date('2026-08-03T05:00:00Z'), menu: 'カット',
    customer_name: '山田 花子', line_user_id: 'U1', staff_name: '佐藤',
  };
  const delivered = [];
  const client = {
    query: async (sql) => {
      if (/SELECT r\.id, r\.status/.test(sql)) return { rows: [reservation] };
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'sent' };
    },
  };
  return { pool, slack: { notify: async () => {} }, lineClient, delivered };
}

test('承認すると顧客へ確定通知が Push される', async () => {
  const f = makeStatusFakes('requested');
  const result = await createReservationService(f).setStatus(55, 'confirmed');

  assert.equal(result.ok, true);
  assert.equal(result.notifiedCustomer, true);
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0].dedupeKey, 'reservation_confirmed:res:55');
  assert.match(f.delivered[0].messages[0].text, /確定いたしました/);
});

test('見送りでも顧客へ連絡が届く', async () => {
  const f = makeStatusFakes('requested');
  await createReservationService(f).setStatus(55, 'cancelled');

  assert.equal(f.delivered.length, 1);
  assert.match(f.delivered[0].messages[0].text, /ご案内が難しい/);
});

test('もともと確定済みの予約の状態変更では顧客に通知しない', async () => {
  const f = makeStatusFakes('confirmed');
  const result = await createReservationService(f).setStatus(55, 'visited');

  assert.equal(result.notifiedCustomer, false);
  assert.equal(f.delivered.length, 0);
});

test('顧客への通知失敗はステータス更新を巻き戻さない', async () => {
  const f = makeStatusFakes('requested');
  f.lineClient.deliver = async () => {
    throw new Error('LINE API down');
  };
  const result = await createReservationService(f).setStatus(55, 'confirmed');
  assert.equal(result.ok, true);
});

// ---- 文面 ----

test('受付メッセージは「まだ確定ではない」と明示する', () => {
  const msg = buildRequestReceivedMessage({
    customerName: '山田', reservedAt: '2026-08-03T05:00:00Z', menu: 'カット', staffName: '佐藤',
  });
  assert.match(msg.text, /まだ確定ではありません/);
  assert.match(msg.text, /8月3日\(月\) 14:00/);
});

test('確定・見送りメッセージに日時が入る', () => {
  const payload = { customerName: '山田', reservedAt: '2026-08-03T05:00:00Z', menu: 'カット' };
  assert.match(buildConfirmedMessage(payload).text, /8月3日\(月\) 14:00/);
  assert.match(buildDeclinedMessage(payload).text, /8月3日\(月\) 14:00/);
});

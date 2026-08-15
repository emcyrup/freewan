import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReservationService } from '../src/reservations/service.js';

// メニューの区分・所要時間と、既存予約の有無だけを持つ最小の pool
function makeFakes({ menu = null, conflictRow = null } = {}) {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT name FROM customers WHERE id/.test(sql)) return { rows: [{ name: '田中' }] };
    if (/SELECT category, duration_minutes FROM menus WHERE name/.test(sql)) {
      return { rows: menu ? [menu] : [] };
    }
    if (/FROM reservations r\s+JOIN customers c/.test(sql)) {
      return { rows: conflictRow ? [conflictRow] : [] };
    }
    if (/INSERT INTO reservations/.test(sql)) return { rows: [{ id: 77 }] };
    if (/SELECT name FROM staff WHERE id/.test(sql)) return { rows: [{ name: '佐藤' }] };
    return { rows: [] };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) };
  const slack = { notify: async () => {} };
  return { pool, slack, queries };
}

const input = {
  customerId: 1,
  reservedAt: '2026-08-20T02:00:00.000Z',
  menu: 'カットコース',
  staffId: 3,
};

test('同じ担当のトリミングが重なる時間には予約できない', async () => {
  const f = makeFakes({
    menu: { category: 'trimming', duration_minutes: 90 },
    conflictRow: { id: 12, reserved_at: new Date(), customer_name: '山田' },
  });
  const service = createReservationService(f);

  const result = await service.createManual({ ...input });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'time_conflict');
  assert.equal(result.conflict.reservationId, 12, 'どの予約とぶつかったかを返す');
  assert.equal(result.conflict.customerName, '山田');

  assert.ok(
    !f.queries.some((q) => /INSERT INTO reservations/.test(q.sql)),
    'ぶつかったときは予約を作らない'
  );
});

test('重なりが無ければ、区分と所要時間を予約にコピーして登録する', async () => {
  const f = makeFakes({ menu: { category: 'trimming', duration_minutes: 90 } });
  const service = createReservationService(f);

  const result = await service.createManual({ ...input });
  assert.equal(result.ok, true);

  const insert = f.queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(insert.params[5], 'trimming', '区分を予約に持たせる');
  assert.equal(insert.params[6], 90, '所要時間を予約に持たせる（メニュー変更の影響を受けない）');
});

test('スクールは複数頭を同時に受けるので、重なっていても予約できる', async () => {
  const f = makeFakes({
    menu: { category: 'school', duration_minutes: 480 },
    conflictRow: { id: 12, reserved_at: new Date(), customer_name: '山田' },
  });
  const service = createReservationService(f);

  const result = await service.createManual({ ...input, menu: 'ペットスクール' });
  assert.equal(result.ok, true, 'スクールは重複判定の対象外');
});

test('ホテルも同時に複数頭を受けるため重複判定しない', async () => {
  const f = makeFakes({
    menu: { category: 'hotel', duration_minutes: 1440 },
    conflictRow: { id: 12, reserved_at: new Date(), customer_name: '山田' },
  });
  const service = createReservationService(f);
  assert.equal((await service.createManual({ ...input, menu: 'ペットホテル' })).ok, true);
});

test('担当未定の予約は重複判定しない（空いている人が受けられるため）', async () => {
  const f = makeFakes({
    menu: { category: 'trimming', duration_minutes: 90 },
    conflictRow: { id: 12, reserved_at: new Date(), customer_name: '山田' },
  });
  const service = createReservationService(f);

  const result = await service.createManual({ ...input, staffId: null });
  assert.equal(result.ok, true);
  assert.ok(
    !f.queries.some((q) => /FROM reservations r\s+JOIN customers c/.test(q.sql)),
    '担当が無いときは重複を調べにいかない'
  );
});

test('重複判定は確定・承認待ちだけを見る（キャンセル済みとは重ならない）', async () => {
  const f = makeFakes({ menu: { category: 'trimming', duration_minutes: 90 } });
  const service = createReservationService(f);
  await service.createManual({ ...input });

  const check = f.queries.find((q) => /FROM reservations r\s+JOIN customers c/.test(q.sql));
  assert.match(check.sql, /status IN \('requested', 'confirmed'\)/);
  assert.match(check.sql, /r\.reserved_at </, '開始が相手の終了より前');
  assert.match(check.sql, /> \$2::timestamptz/, '終了が相手の開始より後');
});

// ---- スクールの段階 ----
function makeStagePool(category) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT category FROM reservations/.test(sql)) {
        return { rows: category === undefined ? [] : [{ category }] };
      }
      return { rows: [] };
    },
  };
  return { pool, queries };
}

test('スクールの予約には段階を設定できる', async () => {
  const { pool, queries } = makeStagePool('school');
  const service = createReservationService({ pool, slack: { notify: async () => {} } });

  assert.deepEqual(await service.setSchoolStage(5, 'trial'), { ok: true });
  const update = queries.find((q) => /UPDATE reservations SET school_stage/.test(q.sql));
  assert.deepEqual(update.params, [5, 'trial']);
});

test('スクール以外には段階を付けない。未知の段階も受け付けない', async () => {
  const school = createReservationService({
    pool: makeStagePool('trimming').pool, slack: { notify: async () => {} },
  });
  assert.deepEqual(await school.setSchoolStage(5, 'trial'), { ok: false, error: 'not_school' });

  const svc = createReservationService({
    pool: makeStagePool('school').pool, slack: { notify: async () => {} },
  });
  assert.deepEqual(await svc.setSchoolStage(5, 'graduated'), { ok: false, error: 'invalid_stage' });

  const missing = createReservationService({
    pool: makeStagePool(undefined).pool, slack: { notify: async () => {} },
  });
  assert.deepEqual(await missing.setSchoolStage(5, 'trial'), { ok: false, error: 'not_found' });
});

test('区分が未設定の古い予約には段階を付けられる（あとから直せるように）', async () => {
  const { pool } = makeStagePool(null);
  const service = createReservationService({ pool, slack: { notify: async () => {} } });
  assert.deepEqual(await service.setSchoolStage(5, 'counseling'), { ok: true });
});

// ---- カウンセリングの同時実施 ----
// 「スクール初回時にカウンセリング未実施 → その回でカウンセリングをしてからスクール」を
// 表せるよう、段階（school_stage）とは別に持つ

test('スクールの予約に、その回のカウンセリング実施を記録できる', async () => {
  const { pool, queries } = makeStagePool('school');
  const service = createReservationService({ pool, slack: { notify: async () => {} } });

  assert.deepEqual(await service.setCounseling(5, true), { ok: true });
  const update = queries.find((q) => /UPDATE reservations SET with_counseling/.test(q.sql));
  assert.deepEqual(update.params, [5, true]);
});

test('カウンセリング同時実施は段階を書き換えない（別々に持つ）', async () => {
  const { pool, queries } = makeStagePool('school');
  const service = createReservationService({ pool, slack: { notify: async () => {} } });

  await service.setCounseling(5, true);
  assert.equal(
    queries.filter((q) => /school_stage/.test(q.sql)).length, 0,
    '体験や入園の段階はそのままで、カウンセリングだけを足せること'
  );
});

test('カウンセリング同時実施は外せる', async () => {
  const { pool, queries } = makeStagePool('school');
  const service = createReservationService({ pool, slack: { notify: async () => {} } });

  assert.deepEqual(await service.setCounseling(5, false), { ok: true });
  const update = queries.find((q) => /UPDATE reservations SET with_counseling/.test(q.sql));
  assert.deepEqual(update.params, [5, false]);
});

test('スクール以外・存在しない予約にはカウンセリングを付けない', async () => {
  const trimming = createReservationService({
    pool: makeStagePool('trimming').pool, slack: { notify: async () => {} },
  });
  assert.deepEqual(await trimming.setCounseling(5, true), { ok: false, error: 'not_school' });

  const missing = createReservationService({
    pool: makeStagePool(undefined).pool, slack: { notify: async () => {} },
  });
  assert.deepEqual(await missing.setCounseling(5, true), { ok: false, error: 'not_found' });
});

// ---- 来店経路 ----
// 集計（要件書 2.1 / 2.4）に使うため、入口ごとに既定が付く

test('手入力の予約は既定で電話。指定があればそれを使う', async () => {
  const { pool, queries } = makeStagePool('trimming');
  pool.query = async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT name FROM customers/.test(sql)) return { rows: [{ name: '山田' }] };
    if (/FROM menus/.test(sql)) return { rows: [{ category: 'trimming', duration_minutes: 60 }] };
    if (/INSERT INTO reservations/.test(sql)) return { rows: [{ id: 1 }] };
    return { rows: [] };
  };
  const service = createReservationService({ pool, slack: { notify: async () => {} } });

  await service.createManual({ customerId: 1, reservedAt: '2026-09-01T10:00:00+09:00', menu: 'カット' });
  let insert = queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(insert.params.at(-1), 'tel', 'スタッフ入力は電話が既定');

  queries.length = 0;
  await service.createManual({
    customerId: 1, reservedAt: '2026-09-01T10:00:00+09:00', menu: 'カット', source: 'walkin',
  });
  insert = queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(insert.params.at(-1), 'walkin');

  // 知らない値は既定へ倒す（画面の作りが変わっても不正値を入れない）
  queries.length = 0;
  await service.createManual({
    customerId: 1, reservedAt: '2026-09-01T10:00:00+09:00', menu: 'カット', source: 'sms',
  });
  insert = queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(insert.params.at(-1), 'tel');
});

test('来店経路は後から直せる。知らない値は受け付けない', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  const service = createReservationService({ pool, slack: { notify: async () => {} } });

  assert.deepEqual(await service.setSource(5, 'epark_tel'), { ok: true });
  assert.deepEqual(queries[0].params, [5, 'epark_tel']);

  assert.deepEqual(await service.setSource(5, 'fax'), { ok: false, error: 'invalid_source' });
  assert.deepEqual(await service.setSource(5, null), { ok: true }, '未設定へ戻せる');
});

test('存在しない予約の経路は直せない', async () => {
  const pool = { query: async () => ({ rowCount: 0 }) };
  const service = createReservationService({ pool, slack: { notify: async () => {} } });
  assert.deepEqual(await service.setSource(5, 'epark'), { ok: false, error: 'not_found' });
});

test('新規登録でも終了時刻ぶんの長さが入り、重なり判定にも使われる', async () => {
  const f = makeFakes({ menu: { category: 'trimming', duration_minutes: 60 } });
  const service = createReservationService(f);

  const result = await service.createManual({ ...input, durationMinutes: 210 });
  assert.equal(result.ok, true);

  const insert = f.queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(insert.params[6], 210, 'コースの60分ではなく指定した長さで入る');
  const check = f.queries.find((q) => /FROM reservations r\s+JOIN customers c/.test(q.sql));
  assert.equal(check.params[2], 210, '重なりも210分の幅で見る');
});

test('終了時刻を決めなければ、これまでどおりコースの所要時間が入る', async () => {
  const f = makeFakes({ menu: { category: 'trimming', duration_minutes: 90 } });
  const service = createReservationService(f);

  await service.createManual({ ...input });
  const insert = f.queries.find((q) => /INSERT INTO reservations/.test(q.sql));
  assert.equal(insert.params[6], 90);
});

test('おかしな長さでは登録しない', async () => {
  const f = makeFakes({ menu: { category: 'trimming', duration_minutes: 60 } });
  const service = createReservationService(f);

  const result = await service.createManual({ ...input, durationMinutes: 0 });
  assert.deepEqual(result, { ok: false, error: 'invalid_duration' });
  assert.ok(!f.queries.some((q) => /INSERT INTO reservations/.test(q.sql)));
});

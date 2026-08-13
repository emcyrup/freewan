import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLinkService } from '../src/customers/linkService.js';

// pool.connect() で返るクライアントを模し、シナリオごとの検索結果と
// 実行されたクエリを記録するフェイク
function makeFakes({ byPhone = [], byLine = [] } = {}) {
  const queries = [];
  let nextId = 100;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id, line_user_id FROM customers WHERE phone_norm/.test(sql)) {
        return { rows: byPhone };
      }
      if (/SELECT id FROM customers WHERE line_user_id/.test(sql)) {
        return { rows: byLine };
      }
      if (/INSERT INTO customers/.test(sql)) {
        return { rows: [{ id: nextId++ }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client };
  const notifications = [];
  const slack = {
    notify: async (text) => notifications.push(text),
    notifyError: async (ctx) => notifications.push(ctx),
  };
  return { pool, slack, queries, notifications };
}

const baseInput = {
  lineUserId: 'U-new',
  name: '山田 花子',
  phone: '090-1234-5678',
  birthday: '1990-04-01',
  consent: true,
};

test('不正な電話番号は登録前に弾く', async () => {
  const { pool, slack, queries } = makeFakes();
  const service = createLinkService({ pool, slack });
  const result = await service.registerFromLiff({ ...baseInput, phone: 'abc' });
  assert.deepEqual(result, { ok: false, error: 'invalid_phone' });
  assert.equal(queries.length, 0, 'DB に触れない');
});

test('本人が既に紐付いているレコードなら、氏名の訂正も反映する', async () => {
  const { pool, slack, queries } = makeFakes({
    byPhone: [{ id: 7, line_user_id: 'U-new' }], // 本人の既存レコード
    byLine: [{ id: 7 }],
  });
  const service = createLinkService({ pool, slack });

  await service.registerFromLiff({ ...baseInput, name: '山田 花子（訂正）' });

  const update = queries.find((q) => /SET line_user_id = \$2/.test(q.sql));
  assert.match(update.sql, /name = CASE WHEN \$5::boolean THEN \$6 ELSE name END/);
  assert.equal(update.params[4], true, '本人のレコードなので氏名を更新する');
  assert.equal(update.params[5], '山田 花子（訂正）');
});

test('初回の紐付けでは氏名を上書きしない（店舗の台帳を正とする）', async () => {
  const { pool, slack, queries } = makeFakes({
    byPhone: [{ id: 7, line_user_id: null }], // まだ誰とも紐付いていない台帳の行
    byLine: [],
  });
  const service = createLinkService({ pool, slack });

  await service.registerFromLiff({ ...baseInput });

  const update = queries.find((q) => /SET line_user_id = \$2/.test(q.sql));
  assert.equal(update.params[4], false, '氏名は上書きしない');
});

test('電話番号が既存顧客に一致したら新規作成せず既存レコードを更新する', async () => {
  const { pool, slack, queries } = makeFakes({
    byPhone: [{ id: 7, line_user_id: null }],
    byLine: [],
  });
  const service = createLinkService({ pool, slack });

  const result = await service.registerFromLiff({ ...baseInput });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'linked_existing');
  assert.equal(result.customerId, 7);

  const insert = queries.find((q) => /INSERT INTO customers/.test(q.sql));
  assert.equal(insert, undefined, '新規 INSERT してはならない');
  const update = queries.find((q) => /SET line_user_id = \$2/.test(q.sql));
  assert.ok(update, '既存レコードへの UPDATE が実行される');
  assert.equal(update.params[0], 7);
  assert.equal(update.params[1], 'U-new');
  assert.equal(update.params[2], '1990-04-01', 'birthday が入る');
});

test('follow 時の仮レコードがある場合は line_user_id を既存顧客へ付け替え、履歴のない仮レコードを掃除する', async () => {
  const { pool, slack, queries } = makeFakes({
    byPhone: [{ id: 7, line_user_id: null }],
    byLine: [{ id: 30 }],
  });
  const service = createLinkService({ pool, slack });

  const result = await service.registerFromLiff({ ...baseInput });
  assert.equal(result.outcome, 'linked_existing');

  const unlink = queries.find((q) => /SET line_user_id = NULL/.test(q.sql));
  assert.ok(unlink, '仮レコードから line_user_id を外す');
  assert.equal(unlink.params[0], 30);
  const del = queries.find((q) => /DELETE FROM customers/.test(q.sql));
  assert.ok(del, '履歴のない仮レコードは削除を試みる');
  assert.match(del.sql, /NOT EXISTS/, '履歴がある場合は削除しない条件付き');
});

test('台帳に該当がなければ仮レコードを本登録に昇格する', async () => {
  const { pool, slack, queries, notifications } = makeFakes({
    byPhone: [],
    byLine: [{ id: 30 }],
  });
  const service = createLinkService({ pool, slack });

  const result = await service.registerFromLiff({ ...baseInput });
  assert.equal(result.outcome, 'created_new');
  assert.equal(result.customerId, 30);

  const update = queries.find((q) => /SET name = \$2, phone_norm = \$3/.test(q.sql));
  assert.ok(update);
  assert.equal(update.params[2], '09012345678', '正規化済みの電話番号が入る');
  assert.equal(notifications.length, 1, '新規登録はスタッフへ通知される');
});

test('配信同意なしは opt_out = true で登録される', async () => {
  const { pool, slack, queries } = makeFakes({ byPhone: [], byLine: [{ id: 30 }] });
  const service = createLinkService({ pool, slack });

  await service.registerFromLiff({ ...baseInput, consent: false });
  const update = queries.find((q) => /SET name = \$2, phone_norm = \$3/.test(q.sql));
  assert.equal(update.params[4], true, 'opt_out が立つ');
});

test('電話番号が別の LINE アカウントに紐付いている場合は付け替えず Slack へ通知する', async () => {
  const { pool, slack, queries, notifications } = makeFakes({
    byPhone: [{ id: 7, line_user_id: 'U-other' }],
    byLine: [{ id: 30 }],
  });
  const service = createLinkService({ pool, slack });

  const result = await service.registerFromLiff({ ...baseInput });
  assert.equal(result.outcome, 'conflict');

  const steal = queries.find(
    (q) => /SET line_user_id = \$2/.test(q.sql) && q.params?.[0] === 7
  );
  assert.equal(steal, undefined, '既存の紐付けを奪ってはならない');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /衝突/);
});

test('ロールバック: クエリ失敗時に ROLLBACK される', async () => {
  const { slack } = makeFakes();
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (/SELECT id, line_user_id/.test(sql)) throw new Error('db error');
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client };
  const service = createLinkService({ pool, slack });

  await assert.rejects(() => service.registerFromLiff({ ...baseInput }), /db error/);
  assert.ok(queries.includes('ROLLBACK'));
});

// ---- 補助経路（テキストで電話番号を受信） ----

test('linkByPhoneText: 一致すれば紐付けて customers を更新する', async () => {
  const { pool, slack, queries, notifications } = makeFakes({
    byPhone: [{ id: 7, line_user_id: null }],
    byLine: [],
  });
  const service = createLinkService({ pool, slack });

  const result = await service.linkByPhoneText({
    lineUserId: 'U-new',
    displayName: '花子',
    text: '090-1234-5678',
  });
  assert.equal(result.outcome, 'linked');
  assert.equal(result.customerId, 7);
  assert.equal(notifications.length, 0, '成功時は通知しない');
});

test('linkByPhoneText: 突合失敗は Slack へ通知し新規顧客は作らない', async () => {
  const { pool, slack, queries, notifications } = makeFakes({ byPhone: [], byLine: [] });
  const service = createLinkService({ pool, slack });

  const result = await service.linkByPhoneText({
    lineUserId: 'U-new',
    displayName: '花子',
    text: '090-9999-9999',
  });
  assert.equal(result.outcome, 'not_found');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /突合失敗/);
  assert.match(notifications[0], /09099999999/, 'Slack 通知には電話番号を含める');
  assert.match(notifications[0], /花子/, 'Slack 通知には表示名を含める');
  const insert = queries.find((q) => /INSERT INTO customers/.test(q.sql));
  assert.equal(insert, undefined);
});

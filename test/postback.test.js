import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPostbackHandler } from '../src/webhook/events/postback.js';

function makeFakes({ reservation } = {}) {
  const queries = [];
  const replies = [];
  const notifications = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT r\.id/.test(sql)) {
        return { rows: reservation ? [reservation] : [] };
      }
      return { rows: [] };
    },
  };
  const lineClient = {
    reply: async (token, messages) => replies.push(messages[0].text),
  };
  const slack = { notify: async (text) => notifications.push(text) };
  return { pool, lineClient, slack, queries, replies, notifications };
}

const baseReservation = {
  id: 42,
  reserved_at: new Date('2026-08-03T05:00:00Z'),
  customer_id: 7,
  customer_name: '山田',
  staff_name: '佐藤',
};

function makeEvent(data) {
  return { type: 'postback', replyToken: 'r1', source: { userId: 'U1' }, postback: { data } };
}

test('ok: confirmed_by_customer を立てて応答する', async () => {
  const { pool, lineClient, slack, queries, replies, notifications } = makeFakes({
    reservation: baseReservation,
  });
  const handler = createPostbackHandler({ pool, lineClient, slack });

  await handler(makeEvent('action=confirm&res=42&v=ok'));

  const update = queries.find((q) => /SET confirmed_by_customer = true/.test(q.sql));
  assert.ok(update);
  assert.equal(update.params[0], 42);
  const response = queries.find((q) => /INSERT INTO customer_responses/.test(q.sql));
  assert.equal(response.params[1], 'confirm_ok');
  assert.match(replies[0], /お待ちしております/);
  assert.equal(notifications.length, 0, 'ok は Slack 通知しない');
});

test('change: 応答して Slack へ要対応通知を送る', async () => {
  const { pool, lineClient, slack, queries, replies, notifications } = makeFakes({
    reservation: baseReservation,
  });
  const handler = createPostbackHandler({ pool, lineClient, slack });

  await handler(makeEvent('action=confirm&res=42&v=change'));

  const update = queries.find((q) => /SET confirmed_by_customer/.test(q.sql));
  assert.equal(update, undefined, 'change では confirmed を立てない');
  const response = queries.find((q) => /INSERT INTO customer_responses/.test(q.sql));
  assert.equal(response.params[1], 'confirm_change');
  assert.match(replies[0], /担当者より/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /要対応/);
  assert.match(notifications[0], /山田/);
  assert.match(notifications[0], /8月3日\(月\) 14:00/, '現予約の日時は JST の読みやすい形式');
});

test('他人の予約 ID への postback は無視する', async () => {
  // 検索条件に line_user_id が含まれるため、他人の予約は SELECT がヒットしない
  const { pool, lineClient, slack, queries, replies } = makeFakes({ reservation: null });
  const handler = createPostbackHandler({ pool, lineClient, slack });

  await handler(makeEvent('action=confirm&res=42&v=ok'));

  const select = queries.find((q) => /SELECT r\.id/.test(q.sql));
  assert.equal(select.params[1], 'U1', '本人確認付きで検索する');
  const update = queries.find((q) => /UPDATE/.test(q.sql));
  assert.equal(update, undefined);
  assert.equal(replies.length, 0);
});

test('followup good: 応答を記録して感謝を返信、Slack 通知しない', async () => {
  const { pool, lineClient, slack, queries, replies, notifications } = makeFakes({
    reservation: baseReservation,
  });
  const handler = createPostbackHandler({ pool, lineClient, slack });

  await handler(makeEvent('action=followup&res=42&v=good'));

  const response = queries.find((q) => /INSERT INTO customer_responses/.test(q.sql));
  assert.equal(response.params[1], 'good');
  assert.match(replies[0], /ありがとうございます/);
  assert.equal(notifications.length, 0);
});

test('followup concern: Slack へ通知して詳細の返信を促す', async () => {
  const { pool, lineClient, slack, queries, replies, notifications } = makeFakes({
    reservation: baseReservation,
  });
  const handler = createPostbackHandler({ pool, lineClient, slack });

  await handler(makeEvent('action=followup&res=42&v=concern'));

  const response = queries.find((q) => /INSERT INTO customer_responses/.test(q.sql));
  assert.equal(response.params[1], 'concern');
  assert.match(replies[0], /このままメッセージ/);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /山田/);
});

test('opt_out: opt_out を立てて記録し、停止完了を返信する', async () => {
  const queries = [];
  const replies = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/UPDATE customers SET opt_out = true/.test(sql)) return { rows: [{ id: 7 }] };
      return { rows: [] };
    },
  };
  const lineClient = { reply: async (token, messages) => replies.push(messages[0].text) };
  const slack = { notify: async () => {} };
  const handler = createPostbackHandler({ pool, lineClient, slack });

  await handler(makeEvent('action=opt_out'));

  const update = queries.find((q) => /SET opt_out = true/.test(q.sql));
  assert.equal(update.params[0], 'U1');
  const response = queries.find((q) => /INSERT INTO customer_responses/.test(q.sql));
  assert.equal(response.params[1], 'opt_out');
  assert.match(replies[0], /配信を停止しました/);
});

test('未知の action は何もしない', async () => {
  const { pool, lineClient, slack, queries } = makeFakes();
  const handler = createPostbackHandler({ pool, lineClient, slack });
  await handler(makeEvent('action=unknown&x=1'));
  assert.equal(queries.length, 0);
});

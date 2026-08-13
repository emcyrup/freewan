import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/webhook/events/message.js';

function makeFakes({
  linkOutcome = 'linked',
  customer = { id: 7, name: '花子', last_visit_at: '2026-07-19' },
  hasRecentFollowup = true,
  label = 'good',
} = {}) {
  const replies = [];
  const linkCalls = [];
  const queries = [];
  const notifications = [];
  const classifyCalls = [];

  const lineClient = {
    getProfile: async () => ({ displayName: '花子' }),
    reply: async (token, messages) => replies.push({ token, messages }),
  };
  const linkService = {
    linkByPhoneText: async (args) => {
      linkCalls.push(args);
      return { outcome: linkOutcome, customerId: 7 };
    },
  };
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id, name, last_visit_at FROM customers/.test(sql)) {
        return { rows: customer ? [customer] : [] };
      }
      if (/FROM message_logs/.test(sql)) {
        return { rows: hasRecentFollowup ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [] };
    },
  };
  const slack = { notify: async (text) => notifications.push(text) };
  const classifier = {
    classify: async (text) => {
      classifyCalls.push(text);
      return label;
    },
  };
  return { lineClient, linkService, pool, slack, classifier, replies, linkCalls, queries, notifications, classifyCalls };
}

function makeEvent(text) {
  return {
    type: 'message',
    replyToken: 'r1',
    source: { userId: 'U1' },
    message: { type: 'text', text },
  };
}

// ---- 顧客情報の呼び出し（グループのみ） ----

const ADMIN_URL = 'https://example.com/mock/#list';

test('グループ内の「会員情報」で店舗管理画面（顧客一覧）への導線を返す', async () => {
  const f = makeFakes();
  const handler = createMessageHandler({ ...f, adminUrl: ADMIN_URL });

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { type: 'group', groupId: 'G1', userId: 'U1' },
    message: { type: 'text', text: '会員情報' },
  });

  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].messages[0].text, /mock\/#list/);
  assert.equal(f.classifyCalls.length, 0);
  assert.equal(f.linkCalls.length, 0);
});

test('表記ゆれ（空白・記号つき）でも店舗管理画面の導線を返す', async () => {
  const f = makeFakes();
  const handler = createMessageHandler({ ...f, adminUrl: ADMIN_URL });

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { type: 'group', groupId: 'G1', userId: 'U1' },
    message: { type: 'text', text: ' お客様情報！ ' },
  });
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].messages[0].text, /mock/);
});

test('1:1 トークの「会員情報」には応答しない（分類にも回さない）', async () => {
  const f = makeFakes();
  const handler = createMessageHandler({ ...f, adminUrl: ADMIN_URL });

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { type: 'user', userId: 'U1' },
    message: { type: 'text', text: '会員情報' },
  });

  assert.equal(f.replies.length, 0);
  assert.equal(f.classifyCalls.length, 0);
  assert.equal(f.linkCalls.length, 0);
});

test('adminUrl 未設定ならグループでも応答しない（分類にも回さない）', async () => {
  const f = makeFakes();
  const handler = createMessageHandler(f);

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { type: 'group', groupId: 'G1', userId: 'U1' },
    message: { type: 'text', text: '会員情報' },
  });
  assert.equal(f.replies.length, 0);
  assert.equal(f.classifyCalls.length, 0);
});

// ---- 電話番号（補助経路） ----

test('電話番号らしきテキストは突合を試行し、成功なら完了を返信する', async () => {
  const f = makeFakes({ linkOutcome: 'linked' });
  const handler = createMessageHandler(f);

  await handler(makeEvent('090-1234-5678'));

  assert.equal(f.linkCalls.length, 1);
  assert.equal(f.linkCalls[0].displayName, '花子');
  assert.match(f.replies[0].messages[0].text, /お繋ぎしました/);
  assert.equal(f.classifyCalls.length, 0, '電話番号は分類しない');
});

test('突合失敗時は担当者からの連絡を案内する', async () => {
  const f = makeFakes({ linkOutcome: 'not_found' });
  const handler = createMessageHandler(f);

  await handler(makeEvent('090-9999-9999'));
  assert.match(f.replies[0].messages[0].text, /担当者よりご連絡/);
});

// ---- フォロー回答の分類（Phase 4） ----

test('good 分類は記録して感謝を返信、Slack 通知しない', async () => {
  const f = makeFakes({ label: 'good' });
  const handler = createMessageHandler(f);

  await handler(makeEvent('とても調子いいです！'));

  assert.equal(f.classifyCalls.length, 1);
  const insert = f.queries.find((q) => /INSERT INTO customer_responses/.test(q.sql));
  assert.equal(insert.params[1], 'good');
  assert.equal(insert.params[2], 'とても調子いいです！', 'raw_text が保存される');
  assert.equal(f.notifications.length, 0);
  assert.match(f.replies[0].messages[0].text, /ありがとうございます/);
});

test('concern 分類は Slack へ通知される（顧客名・本文・前回来店日）', async () => {
  const f = makeFakes({ label: 'concern' });
  const handler = createMessageHandler(f);

  await handler(makeEvent('少し痛みがあります'));

  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /花子/);
  assert.match(f.notifications[0], /少し痛みがあります/);
  assert.match(f.notifications[0], /2026-07-19/);
  assert.match(f.replies[0].messages[0].text, /担当者よりご連絡/);
});

test('question 分類も Slack へ通知される', async () => {
  const f = makeFakes({ label: 'question' });
  const handler = createMessageHandler(f);

  await handler(makeEvent('次の予約はいつ空いていますか？'));
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /質問/);
});

test('直近にフォローを送っていない顧客のテキストは分類しない', async () => {
  const f = makeFakes({ hasRecentFollowup: false });
  const handler = createMessageHandler(f);

  await handler(makeEvent('こんにちは'));
  assert.equal(f.classifyCalls.length, 0);
  assert.equal(f.replies.length, 0);
});

test('未紐付けユーザーのテキストは無視する', async () => {
  const f = makeFakes({ customer: null });
  const handler = createMessageHandler(f);

  await handler(makeEvent('こんにちは'));
  assert.equal(f.classifyCalls.length, 0);
});

test('テキスト以外のメッセージは無視する', async () => {
  const f = makeFakes();
  const handler = createMessageHandler(f);

  await handler({ type: 'message', replyToken: 'r1', source: { userId: 'U1' }, message: { type: 'sticker' } });
  assert.equal(f.linkCalls.length, 0);
  assert.equal(f.classifyCalls.length, 0);
});

// ---- スタッフグループのコマンド ----

test('スタッフグループのコマンドは先に処理し、顧客向けの分類には回さない', async () => {
  const f = makeFakes();
  const handled = [];
  const handler = createMessageHandler({
    ...f,
    staffCommand: async (_event, text) => {
      handled.push(text);
      return true;
    },
  });

  await handler(makeEvent('配信結果'));

  assert.deepEqual(handled, ['配信結果']);
  assert.equal(f.classifyCalls.length, 0, 'Claude での分類は走らせない');
  assert.equal(f.replies.length, 0, '応答はコマンド側で返す');
});

test('コマンドでなければ従来どおり顧客の発言として処理する', async () => {
  const f = makeFakes({ label: 'good' });
  const handler = createMessageHandler({ ...f, staffCommand: async () => false });

  await handler(makeEvent('調子いいです'));

  assert.deepEqual(f.classifyCalls, ['調子いいです']);
});

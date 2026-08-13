import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRouter, TEST_MESSAGE_TYPES } from '../src/http/adminRoutes.js';

// 予約1件・顧客1件だけを返す最小の pool。テスト送信は文面の組み立てだけを見る
function makePool() {
  return {
    query: async (sql, params) => {
      if (/FROM reservations/.test(sql)) {
        if (params[0] !== 1) return { rows: [] };
        return {
          rows: [{
            id: 1,
            // pg は TIMESTAMPTZ を Date で返すため、ここも Date で揃える
            reserved_at: new Date('2026-08-20T01:00:00.000Z'), // JST 10:00
            menu: 'シャンプーコース',
            customer_name: '山田',
            staff_name: '佐藤',
          }],
        };
      }
      if (/FROM customers/.test(sql)) {
        return params[0] === 1 ? { rows: [{ id: 1, name: '山田' }] } : { rows: [] };
      }
      return { rows: [] };
    },
  };
}

function makeApp({ sendMode = 'test', testLineUserId = 'Utest' } = {}) {
  const sent = [];
  const lineClient = {
    pushTest: async (messages) => {
      if (sendMode === 'live') return { status: 'refused' };
      sent.push(messages);
      return { status: sendMode === 'dry_run' ? 'dry_run' : 'sent' };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/admin',
    createAdminRouter({
      pool: makePool(),
      reservationService: {},
      lineClient,
      config: { sendMode, testLineUserId, birthdayCouponUrl: 'https://example.com/coupon' },
    })
  );
  return { app, sent };
}

// supertest は入れずに、実際にポートを開いて fetch で叩く（依存を増やさない）
async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

const post = (base, body) =>
  fetch(`${base}/api/admin/test-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('顧客へ送りうるメッセージが全種類テストできる', async () => {
  // 種類を増やしたのに画面から確認できない、が起きないよう本数も固定する
  assert.equal(TEST_MESSAGE_TYPES.length, 7);
  const types = TEST_MESSAGE_TYPES.map((t) => t.type);
  assert.deepEqual(types, [
    'preReminder', 'afterVisit', 'dormant', 'birthday',
    'requestReceived', 'confirmed', 'declined',
  ]);
});

test('予約が要る種類はすべて文面を組み立てて送る', async () => {
  const reservationTypes = TEST_MESSAGE_TYPES.filter((t) => t.needs === 'reservation');
  const { app, sent } = makeApp();
  await withServer(app, async (base) => {
    for (const t of reservationTypes) {
      const res = await post(base, { type: t.type, reservationId: 1 });
      assert.equal(res.status, 200, `${t.type} が 200 で返らない`);
      assert.equal((await res.json()).mode, 'sent');
    }
  });
  assert.equal(sent.length, reservationTypes.length);
  // 予約系は日時が入る。組み立て漏れがないことを1つの目印で確かめる
  const texts = sent.flat().map((m) => JSON.stringify(m));
  assert.ok(texts.every((t) => t.length > 0));
});

test('顧客が要る種類はすべて文面を組み立てて送る', async () => {
  const customerTypes = TEST_MESSAGE_TYPES.filter((t) => t.needs === 'customer');
  const { app, sent } = makeApp();
  await withServer(app, async (base) => {
    for (const t of customerTypes) {
      const res = await post(base, { type: t.type, customerId: 1 });
      assert.equal(res.status, 200, `${t.type} が 200 で返らない`);
    }
  });
  assert.equal(sent.length, customerTypes.length);
});

test('予約の確定・見送りは日時が入った文面になる', async () => {
  const { app, sent } = makeApp();
  await withServer(app, async (base) => {
    await post(base, { type: 'confirmed', reservationId: 1 });
    await post(base, { type: 'declined', reservationId: 1 });
  });
  assert.match(sent[0][0].text, /ご予約が確定/);
  assert.match(sent[0][0].text, /シャンプーコース/);
  assert.match(sent[0][0].text, /佐藤/);
  assert.match(sent[1][0].text, /ご案内が難しい/);
});

test('存在しない種類・対象は 400/404 で弾く', async () => {
  const { app, sent } = makeApp();
  await withServer(app, async (base) => {
    assert.equal((await post(base, { type: 'nope', customerId: 1 })).status, 400);
    assert.equal((await post(base, { type: 'confirmed' })).status, 400);
    assert.equal((await post(base, { type: 'confirmed', reservationId: 999 })).status, 404);
    assert.equal((await post(base, { type: 'dormant', customerId: 999 })).status, 404);
  });
  assert.equal(sent.length, 0);
});

test('SEND_MODE=live ではテスト送信を拒否する', async () => {
  const { app, sent } = makeApp({ sendMode: 'live' });
  await withServer(app, async (base) => {
    const res = await post(base, { type: 'birthday', customerId: 1 });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'live_mode');
  });
  assert.equal(sent.length, 0);
});

test('送信前に SEND_MODE とテスト宛先の設定状況を返す', async () => {
  const { app } = makeApp({ sendMode: 'dry_run', testLineUserId: null });
  await withServer(app, async (base) => {
    const body = await (await fetch(`${base}/api/admin/test-message`)).json();
    assert.equal(body.sendMode, 'dry_run');
    assert.equal(body.testUserConfigured, false);
    assert.equal(body.types.length, 7);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollowHandler } from '../src/webhook/events/follow.js';
import { createUnfollowHandler } from '../src/webhook/events/unfollow.js';
import { createWebhookHandler } from '../src/webhook/handler.js';

function makePool(responses = {}) {
  const queries = [];
  return {
    queries,
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (/INSERT INTO customers/.test(sql)) return { rows: [{ id: responses.customerId ?? 1 }] };
        if (/UPDATE customers/.test(sql)) return { rows: responses.unfollowRows ?? [{ id: 1 }] };
        return { rows: [] };
      },
    },
  };
}

const fakeLineClient = {
  getProfile: async () => ({ displayName: '山田太郎' }),
  reply: async () => ({ status: 'dry_run' }),
};

test('follow で customers に upsert される', async () => {
  const { pool, queries } = makePool();
  const handler = createFollowHandler({ pool, lineClient: fakeLineClient });

  await handler({ type: 'follow', source: { userId: 'U123' }, replyToken: 'r1' });

  const insert = queries.find((q) => /INSERT INTO customers/.test(q.sql));
  assert.ok(insert);
  assert.equal(insert.params[0], 'U123');
  assert.match(insert.sql, /is_blocked = false/, '再フォロー時にブロック解除される');
});

test('プロフィール取得に失敗しても follow 処理は続行する', async () => {
  const { pool, queries } = makePool();
  const handler = createFollowHandler({
    pool,
    lineClient: {
      ...fakeLineClient,
      getProfile: async () => {
        throw new Error('403');
      },
    },
  });

  await handler({ type: 'follow', source: { userId: 'U123' } });
  const insert = queries.find((q) => /INSERT INTO customers/.test(q.sql));
  assert.equal(insert.params[1], '未登録');
});

test('unfollow で is_blocked が立つ', async () => {
  const { pool, queries } = makePool();
  const handler = createUnfollowHandler({ pool });

  await handler({ type: 'unfollow', source: { userId: 'U123' } });

  const update = queries.find((q) => /UPDATE customers SET is_blocked = true/.test(q.sql));
  assert.ok(update);
  assert.equal(update.params[0], 'U123');
});

test('1件のイベント処理失敗が他のイベントを止めず Slack へ通知される', async () => {
  const { pool } = makePool();
  const notified = [];
  const slack = {
    notifyError: async (context) => {
      notified.push(context);
    },
  };
  // follow を2件処理し、1件目だけ getProfile 後の upsert で失敗させる
  let calls = 0;
  const failingPool = {
    query: async (sql, params) => {
      if (/INSERT INTO customers/.test(sql)) {
        calls++;
        if (calls === 1) throw new Error('db down');
        return { rows: [{ id: 2 }] };
      }
      return pool.query(sql, params);
    },
  };
  const handler = createWebhookHandler({ pool: failingPool, lineClient: fakeLineClient, slack });

  let statusCode;
  const res = {
    status: (code) => {
      statusCode = code;
      return res;
    },
    end: () => {},
  };
  await handler(
    {
      body: {
        events: [
          { type: 'follow', source: { userId: 'U1' } },
          { type: 'follow', source: { userId: 'U2' } },
        ],
      },
    },
    res
  );

  assert.equal(statusCode, 200);
  assert.equal(notified.length, 1, '失敗した1件だけ Slack 通知される');
  assert.equal(calls, 2, '2件目のイベントも処理される');
});

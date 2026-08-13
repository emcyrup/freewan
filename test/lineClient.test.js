import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineClient } from '../src/line/client.js';

function makeFakes() {
  const pushed = [];
  const api = {
    pushMessage: async (args) => {
      pushed.push(args);
    },
    replyMessage: async () => {},
    getProfile: async () => ({ displayName: 'テスト' }),
  };
  const queries = [];
  // message_logs の INSERT ... ON CONFLICT DO NOTHING を模したフェイク
  const insertedKeys = new Set();
  let nextId = 1;
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT INTO message_logs/.test(sql)) {
        const key = params[0];
        if (insertedKeys.has(key)) return { rows: [] };
        insertedKeys.add(key);
        return { rows: [{ id: nextId++ }] };
      }
      return { rows: [] };
    },
  };
  return { api, pool, pushed, queries };
}

const basePayload = {
  customerId: 42,
  lineUserId: 'Ucustomer',
  jobType: 'pre_reminder',
  dedupeKey: 'pre_reminder:res:1',
  reservationId: 1,
  messages: [{ type: 'text', text: 'テスト' }],
};

test('dry_run では API を呼ばず DB にも書かない', async () => {
  const { api, pool, pushed, queries } = makeFakes();
  const client = createLineClient({ config: { sendMode: 'dry_run' }, pool, api });

  const result = await client.deliver({ ...basePayload });
  assert.equal(result.status, 'dry_run');
  assert.equal(pushed.length, 0, 'dry_run で pushMessage が呼ばれてはならない');
  assert.equal(queries.length, 0, 'dry_run で DB に書き込んではならない');
});

test('dry_run では reply も API を呼ばない', async () => {
  const { api, pool } = makeFakes();
  let replied = false;
  api.replyMessage = async () => {
    replied = true;
  };
  const client = createLineClient({ config: { sendMode: 'dry_run' }, pool, api });
  const result = await client.reply('token', [{ type: 'text', text: 'x' }]);
  assert.equal(result.status, 'dry_run');
  assert.equal(replied, false);
});

test('test モードでは宛先が TEST_LINE_USER_ID に差し替わる', async () => {
  const { api, pool, pushed } = makeFakes();
  const client = createLineClient({
    config: { sendMode: 'test', testLineUserId: 'Utester' },
    pool,
    api,
  });

  const result = await client.deliver({ ...basePayload });
  assert.equal(result.status, 'sent');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].to, 'Utester', '対象者が誰であっても宛先はテスト用 ID');
});

test('live モードでは対象者本人に送信される', async () => {
  const { api, pool, pushed } = makeFakes();
  const client = createLineClient({ config: { sendMode: 'live' }, pool, api });

  const result = await client.deliver({ ...basePayload });
  assert.equal(result.status, 'sent');
  assert.equal(pushed[0].to, 'Ucustomer');
});

test('同じ dedupe_key での2回目は送信されない', async () => {
  const { api, pool, pushed } = makeFakes();
  const client = createLineClient({ config: { sendMode: 'live' }, pool, api });

  const first = await client.deliver({ ...basePayload });
  const second = await client.deliver({ ...basePayload });
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'skipped');
  assert.equal(pushed.length, 1, '2通目が送られてはならない');
});

test('pushStaff: dry_run は API を呼ばず、test は宛先差し替え、live はグループ宛', async () => {
  const { api, pool, pushed } = makeFakes();

  const dry = createLineClient({ config: { sendMode: 'dry_run' }, pool, api });
  assert.deepEqual(await dry.pushStaff('Cgroup1', '通知'), { status: 'dry_run' });
  assert.equal(pushed.length, 0);

  const testMode = createLineClient(
    { config: { sendMode: 'test', testLineUserId: 'Utester' }, pool, api }
  );
  await testMode.pushStaff('Cgroup1', '通知');
  assert.equal(pushed[0].to, 'Utester');

  const live = createLineClient({ config: { sendMode: 'live' }, pool, api });
  await live.pushStaff('Cgroup1', '通知');
  assert.equal(pushed[1].to, 'Cgroup1');
  assert.equal(pushed[1].messages[0].text, '通知');
});

test('pushTest: 宛先は常にテスト用ID、live では拒否、DB には書かない', async () => {
  const { api, pool, pushed, queries } = makeFakes();

  const dry = createLineClient({ config: { sendMode: 'dry_run' }, pool, api });
  assert.deepEqual(await dry.pushTest([{ type: 'text', text: 'x' }]), { status: 'dry_run' });
  assert.equal(pushed.length, 0);

  const testMode = createLineClient(
    { config: { sendMode: 'test', testLineUserId: 'Utester' }, pool, api }
  );
  const sent = await testMode.pushTest([{ type: 'text', text: 'x' }]);
  assert.equal(sent.status, 'sent');
  assert.equal(pushed[0].to, 'Utester');

  const live = createLineClient({ config: { sendMode: 'live' }, pool, api });
  assert.deepEqual(await live.pushTest([{ type: 'text', text: 'x' }]), { status: 'refused' });
  assert.equal(pushed.length, 1, 'live では送信されない');
  assert.equal(queries.length, 0, 'message_logs に記録しない（本番の dedupe に影響させない）');
});

test('送信失敗時は message_logs を failed に更新する', async () => {
  const { api, pool, queries } = makeFakes();
  api.pushMessage = async () => {
    throw new Error('LINE API error');
  };
  const client = createLineClient({ config: { sendMode: 'live' }, pool, api });

  const result = await client.deliver({ ...basePayload });
  assert.equal(result.status, 'failed');
  const update = queries.find((q) => /UPDATE message_logs/.test(q.sql));
  assert.ok(update, '失敗時に status 更新クエリが実行される');
  assert.match(update.params[1], /LINE API error/);
});

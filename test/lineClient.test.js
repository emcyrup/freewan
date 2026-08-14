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

  // live 運用中こそ文面を確かめたい。宛先は引数で受け取らずテスト用に固定されるので、
  // live でも飼い主様には届かない
  const live = createLineClient(
    { config: { sendMode: 'live', testLineUserId: 'Utester' }, pool, api }
  );
  assert.deepEqual(await live.pushTest([{ type: 'text', text: 'x' }]), { status: 'sent' });
  assert.equal(pushed[1].to, 'Utester', 'live でも宛先はテスト用アカウント');

  // 宛先が無いときは送らない
  const noDest = createLineClient({ config: { sendMode: 'live' }, pool, api });
  assert.deepEqual(await noDest.pushTest([{ type: 'text', text: 'x' }]),
    { status: 'refused', reason: 'no_test_user' });
  assert.equal(pushed.length, 2, '宛先が無いときは送信しない');
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

// ---- スタッフ確認付き送信（承認モード）----
import { createLineClient as createLineClientForApproval } from '../src/line/client.js';

test('承認モードが manual のとき approvable な配信はキューに積み、送信も記録もしない', async () => {
  const queued = [];
  const dbQueries = [];
  const approval = {
    isManual: async () => true,
    queue: async (args) => { queued.push(args); return { status: 'queued', duplicate: false }; },
  };
  const client = createLineClientForApproval({
    config: { sendMode: 'test', testLineUserId: 'Utest', line: {} },
    pool: { query: async (sql, params) => { dbQueries.push({ sql, params }); return { rows: [{ id: 1 }] }; } },
    api: { pushMessage: async () => { throw new Error('送信してはいけない'); } },
    approval,
  });

  const result = await client.deliver({
    customerId: 7, lineUserId: 'U7', jobType: 'dormant', dedupeKey: 'k',
    messages: [{ type: 'text', text: 'x' }], approvable: true,
  });
  assert.equal(result.status, 'queued');
  assert.equal(queued.length, 1);
  assert.equal(dbQueries.length, 0, 'message_logs にはまだ書かない（承認後の送信時に書く）');
});

test('approvable なし（予約確定連絡など）は manual でもそのまま送信される', async () => {
  const pushed = [];
  const client = createLineClientForApproval({
    config: { sendMode: 'test', testLineUserId: 'Utest', line: {} },
    pool: { query: async () => ({ rows: [{ id: 1 }] }) },
    api: { pushMessage: async (args) => pushed.push(args) },
    approval: { isManual: async () => true, queue: async () => { throw new Error('積んではいけない'); } },
  });

  const result = await client.deliver({
    customerId: 7, lineUserId: 'U7', jobType: 'reservation_confirmed', dedupeKey: 'k2',
    messages: [{ type: 'text', text: 'x' }],
  });
  assert.equal(result.status, 'sent');
  assert.equal(pushed.length, 1);
});

test('dry_run は承認モードでもキューに積まず、ログ出力のみ', async () => {
  const client = createLineClientForApproval({
    config: { sendMode: 'dry_run', line: {} },
    pool: { query: async () => { throw new Error('DB に触らない'); } },
    approval: { isManual: async () => true, queue: async () => { throw new Error('積んではいけない'); } },
  });
  const result = await client.deliver({
    customerId: 7, lineUserId: 'U7', jobType: 'dormant', dedupeKey: 'k3',
    messages: [], approvable: true,
  });
  assert.equal(result.status, 'dry_run');
});

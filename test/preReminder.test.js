import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreReminderMessage, formatReservedAt } from '../src/line/messages/preReminder.js';
import { createPreReminderJob } from '../src/jobs/preReminder.js';

// ---- Flex テンプレート ----

test('日時は JST で「M月D日(曜) HH:MM」に整形される', () => {
  // 2026-08-03T05:00:00Z = JST 14:00（月曜）
  const s = formatReservedAt(new Date('2026-08-03T05:00:00Z'));
  assert.equal(s, '8月3日(月) 14:00');
});

test('Flex Message に顧客名・日時・メニュー・担当・postback が含まれる', () => {
  const msg = buildPreReminderMessage({
    customerName: '山田',
    reservedAt: new Date('2026-08-03T05:00:00Z'),
    menu: 'シャンプー＆カットコース',
    staffName: '佐藤',
    reservationId: 42,
  });
  const json = JSON.stringify(msg);
  assert.equal(msg.type, 'flex');
  assert.match(json, /山田様/);
  assert.match(json, /8月3日\(月\) 14:00/);
  assert.match(json, /シャンプー＆カットコース/);
  assert.match(json, /佐藤/);
  assert.match(json, /action=confirm&res=42&v=ok/);
  assert.match(json, /action=confirm&res=42&v=change/);
});

test('メニュー・担当が無い場合は行ごと省略される', () => {
  const msg = buildPreReminderMessage({
    customerName: '山田',
    reservedAt: new Date('2026-08-03T05:00:00Z'),
    menu: null,
    staffName: null,
    reservationId: 1,
  });
  const json = JSON.stringify(msg);
  assert.doesNotMatch(json, /メニュー/);
  assert.doesNotMatch(json, /担当/);
});

// ---- 抽出とサマリ ----

function makeRow(id, overrides = {}) {
  return {
    id,
    reserved_at: new Date('2026-08-03T05:00:00Z'),
    menu: 'シャンプーコース',
    customer_id: id * 10,
    line_user_id: `U${id}`,
    customer_name: `顧客${id}`,
    staff_name: null,
    ...overrides,
  };
}

test('対象者ごとに deliver が呼ばれ、dedupe_key は pre_reminder:res:{id}', async () => {
  const delivered = [];
  const pool = { query: async () => ({ rows: [makeRow(1), makeRow(2)] }) };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'sent' };
    },
  };
  const job = createPreReminderJob({ pool, lineClient });

  const summary = await job();
  assert.equal(summary.total, 2);
  assert.equal(summary.sent, 2);
  assert.equal(delivered[0].dedupeKey, 'pre_reminder:res:1');
  assert.equal(delivered[0].jobType, 'pre_reminder');
  assert.equal(delivered[1].customerId, 20);
});

test('1件の失敗が他の対象者を止めず、サマリに集計される', async () => {
  const pool = { query: async () => ({ rows: [makeRow(1), makeRow(2), makeRow(3)] }) };
  let calls = 0;
  const lineClient = {
    deliver: async () => {
      calls++;
      if (calls === 2) throw new Error('boom');
      return { status: 'sent' };
    },
  };
  const job = createPreReminderJob({ pool, lineClient });

  const summary = await job();
  assert.equal(calls, 3, '失敗後も残りの対象者を処理する');
  assert.equal(summary.sent, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.errors[0].customerId, 20);
});

test('skipped（dedupe 済み）と dry_run が集計される', async () => {
  const statuses = ['dry_run', 'skipped'];
  const pool = { query: async () => ({ rows: [makeRow(1), makeRow(2)] }) };
  const lineClient = { deliver: async () => ({ status: statuses.shift() }) };
  const job = createPreReminderJob({ pool, lineClient });

  const summary = await job();
  assert.equal(summary.dryRun, 1);
  assert.equal(summary.skipped, 1);
});

test('抽出クエリが仕様の条件を含む', async () => {
  let capturedSql = '';
  let capturedParams = [];
  const pool = {
    query: async (sql, params) => {
      capturedSql = sql;
      capturedParams = params ?? [];
      return { rows: [] };
    },
  };
  const job = createPreReminderJob({ pool, lineClient: {} });
  await job();

  assert.match(capturedSql, /status = 'confirmed'/);
  assert.match(capturedSql, /AT TIME ZONE 'Asia\/Tokyo'/, '日付比較は JST に明示変換');
  // 何日前に送るかは店舗ごとに変えられる。SQL には埋め込まずパラメータで渡す
  assert.match(capturedSql, /\$1 \* INTERVAL '1 day'/);
  assert.deepEqual(capturedParams, [2], '既定は2日前');
  assert.match(capturedSql, /line_user_id IS NOT NULL/);
  assert.match(capturedSql, /is_blocked = false/);
  assert.doesNotMatch(capturedSql, /opt_out/, '予約確認は opt_out を除外条件にしない');
});

test('お客様ごとに前々日確認を止めていると対象から外れる（SQL に条件が入っている）', async () => {
  // 実際の除外は SQL の NOT EXISTS で行うため、条件が消えていないことを確かめる
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [] }; } };
  const job = createPreReminderJob({ pool, lineClient: { deliver: async () => ({}) } });
  await job();
  assert.match(sql, /customer_reminder_settings/);
  assert.match(sql, /s\.job = 'preReminder'/);
});

test('前々日確認の日数は設定で変えられる', async () => {
  let params = [];
  const pool = { query: async (_sql, p) => { params = p; return { rows: [] }; } };
  await createPreReminderJob({ pool, lineClient: {}, daysBefore: 3 })();
  assert.deepEqual(params, [3]);
});

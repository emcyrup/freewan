import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDormantJob } from '../src/jobs/dormant.js';
import { buildDormantMessage } from '../src/line/messages/dormant.js';

test('メッセージに配信停止導線（opt_out postback）が必ず入る', () => {
  const msg = buildDormantMessage({ customerName: '山田' });
  const json = JSON.stringify(msg);
  assert.match(json, /山田様/);
  assert.match(json, /action=opt_out/);
  assert.match(json, /不要な方はこちら/);
});

test('抽出クエリが仕様の条件を含み、日次上限がパラメータで渡る', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  const job = createDormantJob({ pool, lineClient: {}, dailyLimit: 25 });
  await job();

  assert.match(captured.sql, /last_visit_at <= \(now\(\) AT TIME ZONE 'Asia\/Tokyo'\)::date - \(\$2 \* INTERVAL '1 day'\)/, '= ではなく <= で取り漏れを防ぐ。基準日は JST 明示');
  // 休眠とみなす日数は店舗ごとに変えられる。SQL には埋め込まずパラメータで渡す
  assert.deepEqual(captured.params, [25, 90], '日次上限と休眠日数がパラメータで渡る');
  assert.match(captured.sql, /opt_out = false/);
  assert.match(captured.sql, /is_blocked = false/);
  assert.match(captured.sql, /NOT EXISTS[\s\S]*status IN \('confirmed', 'requested'\)/, '未来の予約（確定・承認待ち）がある顧客は除外');
  assert.match(captured.sql, /NOT EXISTS[\s\S]*job_type = 'dormant'[\s\S]*sent_at > now\(\) - \(\$2 \* INTERVAL '1 day'\)/, '同じ期間内に送信済みの顧客は除外');
  assert.match(captured.sql, /LIMIT \$1/);
});

test('dedupe_key は dormant:cust:{id}:{YYYY-MM-DD}', async () => {
  const delivered = [];
  const pool = {
    query: async () => ({
      rows: [{ id: 7, line_user_id: 'U7', name: '山田', last_visit_at: '2026-03-01' }],
    }),
  };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'sent' };
    },
  };
  const job = createDormantJob({ pool, lineClient });

  await job();
  assert.match(delivered[0].dedupeKey, /^dormant:cust:7:\d{4}-\d{2}-\d{2}$/);
  assert.equal(delivered[0].jobType, 'dormant');
});

test('お客様ごとに止めていると対象から外れる（SQL に条件が入っている）', async () => {
  // 実際の除外は SQL の NOT EXISTS で行うため、条件が消えていないことを確かめる
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [] }; } };
  await createDormantJob({ pool, lineClient: { deliver: async () => ({}) }, dailyLimit: 5 })();
  assert.match(sql, /customer_reminder_settings/);
  assert.match(sql, /s\.job = 'dormant'/);
});

test('休眠とみなす日数は設定で変えられる', async () => {
  let captured = null;
  const pool = { query: async (sql, params) => { captured = { sql, params }; return { rows: [] }; } };
  await createDormantJob({ pool, lineClient: {}, dailyLimit: 10, dormantDays: 180 })();
  assert.deepEqual(captured.params, [10, 180]);
  // 再送の間隔も同じ日数を使う（90日で送ったのに30日で再送、が起きないように）
  assert.match(captured.sql, /sent_at > now\(\) - \(\$2 \* INTERVAL '1 day'\)/);
});

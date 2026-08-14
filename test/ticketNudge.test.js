import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTicketNudgeJob } from '../src/jobs/ticketNudge.js';
import { buildTicketNudgeMessage } from '../src/line/messages/ticketNudge.js';

test('メッセージに残回数・期限・配信停止導線が入る', () => {
  const msg = buildTicketNudgeMessage({
    customerName: '田中',
    pets: [
      { name: 'マロン', remaining: 3, expiresOn: '2026-08-20' },
      { name: 'ムギ', remaining: 5, expiresOn: null },
    ],
  });
  const json = JSON.stringify(msg);
  assert.match(json, /田中様/);
  assert.match(json, /マロンちゃん：残り3回（8月20日まで）/);
  assert.match(json, /ムギちゃん：残り5回/);
  assert.match(json, /action=opt_out/);
});

test('抽出条件: 期限内の残あり・一定日数の未来店・各種除外がSQLに入っている', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await createTicketNudgeJob({ pool, lineClient: {}, idleDays: 14 })();

  assert.deepEqual(captured.params, [14], '未来店とみなす日数はパラメータで渡す');
  assert.match(captured.sql, /source = 'ticket'/, '回数券だけが対象');
  assert.match(captured.sql, /expires_on IS NULL OR g\.expires_on >= /, '期限切れの残は数えない');
  assert.match(captured.sql, /b\.remaining > 0/, '残があるわんちゃんだけ');
  assert.match(captured.sql, /last_visit_at IS NOT NULL/, '来店実績のない移行直後の顧客へ一斉送信しない');
  assert.match(captured.sql, /opt_out = false/);
  assert.match(captured.sql, /customer_reminder_settings/, 'お客様ごとの停止を尊重する');
  assert.match(captured.sql, /status IN \('confirmed', 'requested'\)/, '次の予約がある顧客は除外');
  assert.match(captured.sql, /job_type = 'ticketNudge'/, '同じ期間内の再送を防ぐ');
  assert.match(captured.sql, /json_agg/, '多頭飼いは1通にまとめる');
});

test('dedupe_key と jobType、多頭ぶんが1通に入る', async () => {
  const delivered = [];
  const pool = {
    query: async () => ({
      rows: [
        {
          id: 9,
          line_user_id: 'U9',
          name: '田中',
          pets: [
            { name: 'マロン', remaining: 3, expiresOn: '2026-08-20' },
            { name: 'ムギ', remaining: 5, expiresOn: '2026-09-12' },
          ],
        },
      ],
    }),
  };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'dry_run' };
    },
  };
  const summary = await createTicketNudgeJob({ pool, lineClient })();

  assert.equal(delivered.length, 1, '2頭でも1通');
  assert.match(delivered[0].dedupeKey, /^ticket_nudge:cust:9:\d{4}-\d{2}-\d{2}$/);
  assert.equal(delivered[0].jobType, 'ticketNudge');
  const json = JSON.stringify(delivered[0].messages);
  assert.match(json, /マロン/);
  assert.match(json, /ムギ/);
  assert.equal(summary.dryRun, 1);
});

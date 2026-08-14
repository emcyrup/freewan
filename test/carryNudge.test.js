import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCarryNudgeJob } from '../src/jobs/carryNudge.js';
import { buildCarryNudgeMessage } from '../src/line/messages/carryNudge.js';

test('メッセージに繰越残数・失効日・配信停止導線が入る', () => {
  const msg = buildCarryNudgeMessage({
    customerName: '田中',
    pets: [
      { name: 'マロン', remaining: 2, expiresOn: '2026-08-31' },
      { name: 'ムギ', remaining: 1, expiresOn: '2026-08-31' },
    ],
  });
  const json = JSON.stringify(msg);
  assert.match(json, /田中様/);
  assert.match(json, /マロンちゃん：繰越分 残り2回（8月31日で失効）/);
  assert.match(json, /ムギちゃん：繰越分 残り1回/);
  assert.match(json, /action=opt_out/);
});

test('抽出条件: 当月より前の付与・当月中の失効・各種除外がSQLに入っている', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await createCarryNudgeJob({ pool, lineClient: {} })();

  assert.equal(captured.params.length, 3, '月初・今日・月末を渡す');
  assert.match(captured.params[0], /^\d{4}-\d{2}-01$/, '$1 は月初');
  assert.match(captured.sql, /source = 'plan'/, 'ペットスクールの繰越だけが対象');
  assert.match(captured.sql, /effective_on < \$1::date/, '当月より前の付与＝繰越分');
  assert.match(captured.sql, /expires_on <= \$3::date/, '当月中に失効するものだけ');
  assert.match(captured.sql, /b\.remaining > 0/, '残があるわんちゃんだけ');
  assert.match(captured.sql, /opt_out = false/);
  assert.match(captured.sql, /customer_reminder_settings/, 'お客様ごとの停止を尊重する');
  assert.match(captured.sql, /job_type = 'carryNudge'/, '同じ月内の再送を防ぐ');
  assert.doesNotMatch(
    captured.sql, /status IN \('confirmed', 'requested'\)/,
    '当月分から先に消化する運用のため、次の予約があっても除外しない'
  );
  assert.match(captured.sql, /json_agg/, '多頭飼いは1通にまとめる');
});

test('dedupe_key は月単位（月1回まで）、approvable が付く', async () => {
  const delivered = [];
  const pool = {
    query: async () => ({
      rows: [
        {
          id: 5,
          line_user_id: 'U5',
          name: '田中',
          pets: [{ name: 'マロン', remaining: 2, expiresOn: '2026-08-31' }],
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
  const summary = await createCarryNudgeJob({ pool, lineClient })();

  assert.equal(delivered.length, 1);
  assert.match(delivered[0].dedupeKey, /^carry_nudge:cust:5:\d{4}-\d{2}$/);
  assert.equal(delivered[0].jobType, 'carryNudge');
  assert.equal(delivered[0].approvable, true);
  assert.equal(summary.dryRun, 1);
});

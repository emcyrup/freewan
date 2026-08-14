import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlanNudgeJob } from '../src/jobs/planNudge.js';
import { buildPlanNudgeMessage } from '../src/line/messages/planNudge.js';

test('メッセージにコース名・残回数・配信停止導線が入る', () => {
  const msg = buildPlanNudgeMessage({
    customerName: '西村',
    pets: [{ name: 'ベル', remaining: 2, planName: 'スクール 月8会員' }],
  });
  const json = JSON.stringify(msg);
  assert.match(json, /西村様/);
  assert.match(json, /ベルちゃん（スクール 月8会員）：残り2回/);
  assert.match(json, /action=opt_out/);
});

test('抽出条件: 加入中のみ・期限内の残あり・各種除外がSQLに入っている', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await createPlanNudgeJob({ pool, lineClient: {}, idleDays: 7 })();

  assert.deepEqual(captured.params, [7]);
  assert.match(captured.sql, /pet_plans pp ON pp\.pet_id = p\.id AND pp\.ended_on IS NULL/, '加入中のわんちゃんだけが対象（解約後は追わない）');
  assert.match(captured.sql, /source = 'plan'/);
  assert.match(captured.sql, /b\.remaining > 0/);
  assert.match(captured.sql, /last_visit_at IS NOT NULL/);
  assert.match(captured.sql, /customer_reminder_settings/);
  assert.match(captured.sql, /status IN \('confirmed', 'requested'\)/);
  assert.match(captured.sql, /job_type = 'planNudge'/);
});

test('dedupe_key と jobType', async () => {
  const delivered = [];
  const pool = {
    query: async () => ({
      rows: [
        {
          id: 12,
          line_user_id: 'U12',
          name: '西村',
          pets: [{ name: 'ベル', remaining: 2, planName: 'スクール 月8会員' }],
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
  await createPlanNudgeJob({ pool, lineClient })();

  assert.match(delivered[0].dedupeKey, /^plan_nudge:cust:12:\d{4}-\d{2}-\d{2}$/);
  assert.equal(delivered[0].jobType, 'planNudge');
});

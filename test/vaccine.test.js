import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVaccineJob } from '../src/jobs/vaccine.js';
import { buildVaccineMessage } from '../src/line/messages/vaccine.js';

test('メッセージにワクチン種別・期限・証明書のお願い・配信停止導線が入る', () => {
  const msg = buildVaccineMessage({
    customerName: '田中',
    pets: [
      { name: 'マロン', vaccine: '混合ワクチン', expiresOn: '2026-09-10' },
      { name: 'マロン', vaccine: '狂犬病予防接種', expiresOn: '2026-09-20' },
    ],
  });
  const json = JSON.stringify(msg);
  assert.match(json, /田中様/);
  assert.match(json, /マロンちゃん：混合ワクチン（9月10日まで）/);
  assert.match(json, /狂犬病予防接種（9月20日まで）/);
  assert.match(json, /接種証明書/);
  assert.match(json, /action=opt_out/);
});

test('抽出条件: 接種日+1年の期限・案内の窓・直近半年以内の利用者のみ', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await createVaccineJob({ pool, lineClient: {}, remindDays: 30, activeDays: 180 })();

  assert.deepEqual(captured.params, [30, 180], '窓と利用実績の日数はパラメータで渡す');
  assert.match(captured.sql, /mixed_vaccinated_on\s+\+ INTERVAL '1 year'/, '期限は接種日+1年で導く');
  assert.match(captured.sql, /rabies_vaccinated_on \+ INTERVAL '1 year'/, '狂犬病も同様');
  assert.match(captured.sql, /last_visit_at >= /, '直近の利用者だけに送る');
  assert.match(captured.sql, /opt_out = false/);
  assert.match(captured.sql, /customer_reminder_settings/, 'お客様ごとの停止を尊重する');
  assert.match(captured.sql, /job_type = 'vaccine'/, '同じ窓のうちの再送を防ぐ');
  assert.match(captured.sql, /json_agg/, '複数のワクチン・多頭飼いは1通にまとめる');
});

test('dedupe_key は一番近い期限を軸にし、スタッフへ一覧が通知される', async () => {
  const delivered = [];
  const notifications = [];
  const pool = {
    query: async () => ({
      rows: [
        {
          id: 7,
          line_user_id: 'U7',
          name: '田中',
          pets: [
            { name: 'マロン', vaccine: '狂犬病予防接種', expiresOn: '2026-09-20' },
            { name: 'マロン', vaccine: '混合ワクチン', expiresOn: '2026-09-10' },
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
  const slack = { notify: async (t) => notifications.push(t) };
  const summary = await createVaccineJob({ pool, lineClient, slack })();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].dedupeKey, 'vaccine:cust:7:2026-09-10', '一番近い期限がキーになる');
  assert.equal(delivered[0].jobType, 'vaccine');
  assert.equal(delivered[0].approvable, true);
  assert.equal(summary.dryRun, 1);

  assert.equal(notifications.length, 1, 'スタッフに一覧を通知する');
  assert.match(notifications[0], /マロンちゃん（田中様）: 混合ワクチン 2026-09-10まで/);
  assert.match(notifications[0], /狂犬病予防接種 2026-09-20まで/);
});

test('対象ゼロならスタッフ通知もしない', async () => {
  const notifications = [];
  const pool = { query: async () => ({ rows: [] }) };
  const slack = { notify: async (t) => notifications.push(t) };
  const summary = await createVaccineJob({ pool, lineClient: {}, slack })();
  assert.equal(summary.total, 0);
  assert.equal(notifications.length, 0);
});

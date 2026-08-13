import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBirthdayJob } from '../src/jobs/birthday.js';
import { buildBirthdayMessage } from '../src/line/messages/birthday.js';
import { isLeapYear, includeLeapDayBirthdays, jstToday } from '../src/util/jst.js';

// ---- 閏年判定 ----

test('閏年判定', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2026), false);
  assert.equal(isLeapYear(2000), true, '400の倍数は閏年');
  assert.equal(isLeapYear(1900), false, '100の倍数（400の倍数以外）は平年');
});

test('平年の2/28のみ 2/29 生まれを対象に含める', () => {
  assert.equal(includeLeapDayBirthdays({ year: 2026, month: 2, day: 28 }), true, '平年の2/28');
  assert.equal(includeLeapDayBirthdays({ year: 2028, month: 2, day: 28 }), false, '閏年の2/28は含めない（翌日に本来の日が来る）');
  assert.equal(includeLeapDayBirthdays({ year: 2026, month: 2, day: 27 }), false);
  assert.equal(includeLeapDayBirthdays({ year: 2026, month: 7, day: 28 }), false);
});

test('jstToday は UTC 日付ではなく JST 日付を返す', () => {
  // UTC 2026-07-25 23:00 = JST 2026-07-26 08:00
  const today = jstToday(new Date('2026-07-25T23:00:00Z'));
  assert.deepEqual({ y: today.year, m: today.month, d: today.day }, { y: 2026, m: 7, d: 26 });
  assert.equal(today.iso, '2026-07-26');
});

// ---- メッセージ ----

test('クーポン URL があればボタンが付き、なければ本文のみ', () => {
  const withCoupon = buildBirthdayMessage({ customerName: '山田', couponUrl: 'https://example.com/c' });
  assert.match(JSON.stringify(withCoupon), /クーポンを見る/);
  assert.match(JSON.stringify(withCoupon), /https:\/\/example.com\/c/);

  const without = buildBirthdayMessage({ customerName: '山田', couponUrl: null });
  assert.doesNotMatch(JSON.stringify(without), /クーポン/);
  assert.equal(without.contents.footer, undefined);
});

// ---- ジョブ ----

test('dedupe_key は birthday:cust:{id}:{YYYY}（年1回）', async () => {
  const delivered = [];
  const pool = {
    query: async () => ({ rows: [{ id: 7, line_user_id: 'U7', name: '山田' }] }),
  };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'sent' };
    },
  };
  const job = createBirthdayJob({ pool, lineClient });

  await job();
  const year = new Date().getFullYear();
  assert.match(delivered[0].dedupeKey, new RegExp(`^birthday:cust:7:\\d{4}$`));
  assert.equal(delivered[0].jobType, 'birthday');
});

test('抽出クエリは月日一致＋閏年フラグをパラメータで渡す', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  const job = createBirthdayJob({ pool, lineClient: {} });
  await job();

  assert.match(captured.sql, /EXTRACT\(MONTH FROM c\.birthday\) = \$1/);
  assert.match(captured.sql, /EXTRACT\(DAY FROM c\.birthday\) = \$2/);
  assert.match(captured.sql, /\$3::boolean AND EXTRACT\(MONTH FROM c\.birthday\) = 2 AND EXTRACT\(DAY FROM c\.birthday\) = 29/);
  assert.match(captured.sql, /opt_out = false/);
  assert.match(captured.sql, /is_blocked = false/);
  assert.equal(typeof captured.params[2], 'boolean');
});

test('お客様ごとに止めていると対象から外れる（SQL に条件が入っている）', async () => {
  // 実際の除外は SQL の NOT EXISTS で行うため、条件が消えていないことを確かめる
  let sql = '';
  const pool = { query: async (q) => { sql = q; return { rows: [] }; } };
  await createBirthdayJob({ pool, lineClient: { deliver: async () => ({}) } })();
  assert.match(sql, /customer_reminder_settings/);
  assert.match(sql, /s\.job = 'birthday'/);
});

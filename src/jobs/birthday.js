// 誕生日祝いジョブ: 誕生日当日の顧客にお祝い＋クーポンを送る。
// 2/29 生まれは平年には 2/28 に送る（jst.js の判定を使用）。
import { buildBirthdayMessage } from '../line/messages/birthday.js';
import { jstToday, includeLeapDayBirthdays } from '../util/jst.js';

export function createBirthdayJob({ pool, lineClient, couponUrl = null }) {
  return async function run() {
    const today = jstToday();
    const withLeapDay = includeLeapDayBirthdays(today);

    const { rows } = await pool.query(
      `SELECT c.id, c.line_user_id, c.name
       FROM customers c
       WHERE c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'birthday' AND s.enabled = false
         )
         AND c.birthday IS NOT NULL
         AND (
           (EXTRACT(MONTH FROM c.birthday) = $1 AND EXTRACT(DAY FROM c.birthday) = $2)
           -- 平年の 2/28 は 2/29 生まれも対象に含める
           OR ($3::boolean AND EXTRACT(MONTH FROM c.birthday) = 2 AND EXTRACT(DAY FROM c.birthday) = 29)
         )`,
      [today.month, today.day, withLeapDay]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      try {
        const message = buildBirthdayMessage({ customerName: row.name, couponUrl });
        const result = await lineClient.deliver({
          customerId: row.id,
          lineUserId: row.line_user_id,
          jobType: 'birthday',
          // 年に1回まで。同年内の再実行は dedupe される
          dedupeKey: `birthday:cust:${row.id}:${today.year}`,
          messages: [message],
        });
        if (result.status === 'sent') summary.sent++;
        else if (result.status === 'dry_run') summary.dryRun++;
        else if (result.status === 'skipped') summary.skipped++;
        else {
          summary.failed++;
          summary.errors.push({ customerId: row.id, message: result.error ?? 'unknown' });
        }
      } catch (err) {
        summary.failed++;
        summary.errors.push({ customerId: row.id, message: err.message });
      }
    }
    return summary;
  };
}

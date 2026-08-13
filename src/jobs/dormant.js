// 休眠フォロージョブ: 最終来店から90日以上経過した顧客へ様子見メッセージを送る。
// 初回リリース時は対象が一斉に溜まっているため、日次上限で分散送信する。
import { buildDormantMessage } from '../line/messages/dormant.js';
import { jstToday } from '../util/jst.js';

export function createDormantJob({ pool, lineClient, dailyLimit = 50, dormantDays = 90 }) {
  return async function run() {
    const today = jstToday();

    // `= N日` ではなく `<= N日` にしている理由:
    // バッチが1日でも失敗すると、ちょうど N 日の顧客が永久に漏れるため（spec 2-3）
    const { rows } = await pool.query(
      `SELECT c.id, c.line_user_id, c.name, c.last_visit_at
       FROM customers c
       WHERE c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'dormant' AND s.enabled = false
         )
         AND c.last_visit_at IS NOT NULL
         AND c.last_visit_at <= (now() AT TIME ZONE 'Asia/Tokyo')::date - ($2 * INTERVAL '1 day')
         -- 未来の予約（確定・承認待ち）がある顧客は除外
         AND NOT EXISTS (
           SELECT 1 FROM reservations r
           WHERE r.customer_id = c.id
             AND r.status IN ('confirmed', 'requested')
             AND r.reserved_at > now()
         )
         -- 同じ間隔のうちに休眠フォローを送っていない（送信はその期間に1回まで）
         AND NOT EXISTS (
           SELECT 1 FROM message_logs m
           WHERE m.customer_id = c.id AND m.job_type = 'dormant'
             AND m.sent_at > now() - ($2 * INTERVAL '1 day')
         )
       ORDER BY c.last_visit_at ASC
       LIMIT $1`,
      [dailyLimit, dormantDays]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      try {
        const message = buildDormantMessage({ customerName: row.name });
        const result = await lineClient.deliver({
          customerId: row.id,
          lineUserId: row.line_user_id,
          jobType: 'dormant',
          dedupeKey: `dormant:cust:${row.id}:${today.iso}`,
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

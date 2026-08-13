// 前々日確認ジョブ: 2日後の確定予約をもつ顧客に確認メッセージを送る。
// opt_out は除外条件にしない（予約確認は営業ではなく取引に必要な連絡のため）。
import { buildPreReminderMessage } from '../line/messages/preReminder.js';

export function createPreReminderJob({ pool, lineClient, daysBefore = 2 }) {
  return async function run() {
    const { rows } = await pool.query(
      `SELECT r.id, r.reserved_at, r.menu,
              c.id AS customer_id, c.line_user_id, c.name AS customer_name,
              s.name AS staff_name
       FROM reservations r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN staff s ON s.id = r.staff_id
       WHERE r.status = 'confirmed'
         AND (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date
             = ((now() AT TIME ZONE 'Asia/Tokyo')::date + ($1 * INTERVAL '1 day'))::date
         AND c.line_user_id IS NOT NULL
         AND c.is_blocked = false
         -- お客様が「前々日確認だけ止めたい」と希望した場合は送らない
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'preReminder' AND s.enabled = false
         )`,
      [daysBefore]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      // 1件のエラーで他の対象者の処理を止めない
      try {
        const message = buildPreReminderMessage({
          customerName: row.customer_name,
          reservedAt: row.reserved_at,
          menu: row.menu,
          staffName: row.staff_name,
          reservationId: row.id,
        });
        const result = await lineClient.deliver({
          customerId: row.customer_id,
          lineUserId: row.line_user_id,
          jobType: 'pre_reminder',
          dedupeKey: `pre_reminder:res:${row.id}`,
          reservationId: row.id,
          messages: [message],
        });
        if (result.status === 'sent') summary.sent++;
        else if (result.status === 'dry_run') summary.dryRun++;
        else if (result.status === 'skipped') summary.skipped++;
        else {
          summary.failed++;
          summary.errors.push({ customerId: row.customer_id, message: result.error ?? 'unknown' });
        }
      } catch (err) {
        summary.failed++;
        summary.errors.push({ customerId: row.customer_id, message: err.message });
      }
    }
    return summary;
  };
}

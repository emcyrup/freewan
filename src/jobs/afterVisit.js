// 来店7日後フォロージョブ: 7日前に来店（visited）した顧客へお礼＋経過確認を送る。
// 販促に近いフォローのため、opt_out の顧客は除外する（preReminder と異なる点）。
import { buildAfterVisitMessage } from '../line/messages/afterVisit.js';

export function createAfterVisitJob({ pool, lineClient, daysAfter = 7 }) {
  return async function run() {
    // 同一顧客が対象日に複数回来店している場合は最新の1件のみ（DISTINCT ON）
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (c.id)
              r.id, c.id AS customer_id, c.line_user_id, c.name AS customer_name
       FROM reservations r
       JOIN customers c ON c.id = r.customer_id
       WHERE r.status = 'visited'
         AND (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date
             = ((now() AT TIME ZONE 'Asia/Tokyo')::date - ($1 * INTERVAL '1 day'))::date
         AND c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'afterVisit' AND s.enabled = false
         )
       ORDER BY c.id, r.reserved_at DESC`,
      [daysAfter]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      try {
        const message = buildAfterVisitMessage({
          customerName: row.customer_name,
          reservationId: row.id,
        });
        const result = await lineClient.deliver({
          customerId: row.customer_id,
          lineUserId: row.line_user_id,
          jobType: 'after_visit',
          dedupeKey: `after_visit:res:${row.id}`,
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

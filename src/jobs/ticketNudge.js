// 回数券の来店促しジョブ（要件 R6）: 期限内の回数券が残っているのに
// しばらく来店がないお客様へ、残回数と期限を知らせる。
// 期限は2ヶ月と短いため、放っておくと失効しやすい。それを防ぐのが目的。
import { buildTicketNudgeMessage } from '../line/messages/ticketNudge.js';
import { jstToday } from '../util/jst.js';

export function createTicketNudgeJob({ pool, lineClient, idleDays = 14 }) {
  return async function run() {
    const today = jstToday();

    // わんちゃん単位で期限内の残回数を出し、お客様単位に1通へまとめる
    // （多頭飼いに同じ日へ複数通を送らないため）
    const { rows } = await pool.query(
      `SELECT c.id, c.line_user_id, c.name,
              json_agg(json_build_object(
                'name', p.name, 'remaining', b.remaining, 'expiresOn', b.next_expiry
              ) ORDER BY p.id) AS pets
       FROM customers c
       JOIN pets p ON p.customer_id = c.id
       JOIN LATERAL (
         SELECT COALESCE(SUM(g.count + COALESCE(u.used, 0)), 0)::int AS remaining,
                (min(g.expires_on) FILTER (
                  WHERE g.count + COALESCE(u.used, 0) > 0
                ))::text AS next_expiry
         FROM plan_credits g
         LEFT JOIN LATERAL (
           SELECT SUM(count) AS used FROM plan_credits WHERE grant_id = g.id
         ) u ON true
         WHERE g.pet_id = p.id AND g.source = 'ticket' AND g.kind = 'grant'
           AND (g.expires_on IS NULL OR g.expires_on >= (now() AT TIME ZONE 'Asia/Tokyo')::date)
       ) b ON b.remaining > 0
       WHERE c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'ticketNudge' AND s.enabled = false
         )
         -- 台帳を移行した直後の来店日不明の顧客に一斉送信しないよう、来店実績を必須にする
         AND c.last_visit_at IS NOT NULL
         AND c.last_visit_at <= (now() AT TIME ZONE 'Asia/Tokyo')::date - ($1 * INTERVAL '1 day')
         -- 既に次の予約があるお客様へ「来てください」は失礼なので除外
         AND NOT EXISTS (
           SELECT 1 FROM reservations r
           WHERE r.customer_id = c.id
             AND r.status IN ('confirmed', 'requested')
             AND r.reserved_at > now()
         )
         -- 同じ間隔のうちに送っていない（その期間に1回まで）
         AND NOT EXISTS (
           SELECT 1 FROM message_logs m
           WHERE m.customer_id = c.id AND m.job_type = 'ticketNudge'
             AND m.sent_at > now() - ($1 * INTERVAL '1 day')
         )
       GROUP BY c.id, c.line_user_id, c.name
       ORDER BY c.last_visit_at ASC`,
      [idleDays]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      try {
        const message = buildTicketNudgeMessage({ customerName: row.name, pets: row.pets });
        const result = await lineClient.deliver({
          customerId: row.id,
          lineUserId: row.line_user_id,
          jobType: 'ticketNudge',
          dedupeKey: `ticket_nudge:cust:${row.id}:${today.iso}`,
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

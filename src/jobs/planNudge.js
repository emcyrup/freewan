// 定額コース会員の残回数案内ジョブ（要件 R7）: 月4回・月8回などの会員が
// 1週間来店していないとき、月内の残り回数を知らせて使い忘れを防ぐ。
// 加入中（pet_plans.ended_on IS NULL）のわんちゃんだけが対象。
// 解約後の残回数は R6（回数券）とは違い追いかけない（会員でなくなった人への営業になるため）。
import { buildPlanNudgeMessage } from '../line/messages/planNudge.js';
import { jstToday } from '../util/jst.js';

export function createPlanNudgeJob({ pool, lineClient, idleDays = 7 }) {
  return async function run() {
    const today = jstToday();

    const { rows } = await pool.query(
      `SELECT c.id, c.line_user_id, c.name,
              json_agg(json_build_object(
                'name', p.name, 'remaining', b.remaining, 'planName', pl.name
              ) ORDER BY p.id) AS pets
       FROM customers c
       JOIN pets p ON p.customer_id = c.id
       JOIN pet_plans pp ON pp.pet_id = p.id AND pp.ended_on IS NULL
       JOIN plans pl ON pl.id = pp.plan_id
       JOIN LATERAL (
         SELECT COALESCE(SUM(g.count + COALESCE(u.used, 0)), 0)::int AS remaining
         FROM plan_credits g
         LEFT JOIN LATERAL (
           SELECT SUM(count) AS used FROM plan_credits WHERE grant_id = g.id
         ) u ON true
         WHERE g.pet_id = p.id AND g.source = 'plan' AND g.kind = 'grant'
           AND (g.expires_on IS NULL OR g.expires_on >= (now() AT TIME ZONE 'Asia/Tokyo')::date)
       ) b ON b.remaining > 0
       WHERE c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'planNudge' AND s.enabled = false
         )
         -- 台帳を移行した直後の来店日不明の顧客に一斉送信しないよう、来店実績を必須にする
         AND c.last_visit_at IS NOT NULL
         AND c.last_visit_at <= (now() AT TIME ZONE 'Asia/Tokyo')::date - ($1 * INTERVAL '1 day')
         -- 既に次の予約があるお客様は除外
         AND NOT EXISTS (
           SELECT 1 FROM reservations r
           WHERE r.customer_id = c.id
             AND r.status IN ('confirmed', 'requested')
             AND r.reserved_at > now()
         )
         -- 同じ間隔のうちに送っていない（その期間に1回まで）
         AND NOT EXISTS (
           SELECT 1 FROM message_logs m
           WHERE m.customer_id = c.id AND m.job_type = 'planNudge'
             AND m.sent_at > now() - ($1 * INTERVAL '1 day')
         )
       GROUP BY c.id, c.line_user_id, c.name
       ORDER BY c.last_visit_at ASC`,
      [idleDays]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      try {
        const message = buildPlanNudgeMessage({ customerName: row.name, pets: row.pets });
        const result = await lineClient.deliver({
          customerId: row.id,
          lineUserId: row.line_user_id,
          jobType: 'planNudge',
          dedupeKey: `plan_nudge:cust:${row.id}:${today.iso}`,
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

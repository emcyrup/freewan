// 繰越分の消化案内ジョブ（要件 R8）: 前月から繰り越した回数が当月中に失効する
// お客様へ、残り回数と失効日を知らせる（同じ月には1回まで）。
// ペットスクールは当月分から先に消化する運用のため（plans/service.js の CONSUME_ORDER）、
// 繰越分は意識して使わないと失効しやすい。それを見える化するのが目的。
import { buildCarryNudgeMessage } from '../line/messages/carryNudge.js';
import { jstToday } from '../util/jst.js';
import { monthRange } from '../plans/service.js';

export function createCarryNudgeJob({ pool, lineClient }) {
  return async function run() {
    const today = jstToday();
    const { first, last } = monthRange(today);
    const month = first.slice(0, 7); // dedupe 用の "YYYY-MM"

    // わんちゃん単位で繰越分の残数を出し、お客様単位に1通へまとめる
    const { rows } = await pool.query(
      `SELECT c.id, c.line_user_id, c.name,
              json_agg(json_build_object(
                'name', p.name, 'remaining', b.remaining, 'expiresOn', b.expires_on
              ) ORDER BY p.id) AS pets
       FROM customers c
       JOIN pets p ON p.customer_id = c.id
       JOIN LATERAL (
         SELECT COALESCE(SUM(g.count + COALESCE(u.used, 0)), 0)::int AS remaining,
                max(g.expires_on)::text AS expires_on
         FROM plan_credits g
         LEFT JOIN LATERAL (
           SELECT SUM(count) AS used FROM plan_credits WHERE grant_id = g.id
         ) u ON true
         WHERE g.pet_id = p.id AND g.source = 'plan' AND g.kind = 'grant'
           -- 当月より前の付与＝繰越分。そのうち当月中に失効するものだけを知らせる
           AND g.effective_on < $1::date
           AND g.expires_on IS NOT NULL
           AND g.expires_on >= $2::date
           AND g.expires_on <= $3::date
       ) b ON b.remaining > 0
       WHERE c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'carryNudge' AND s.enabled = false
         )
         -- 次の予約があっても除外しない: 当月分から先に消化する運用のため、
         -- 予約どおり来店しても繰越分は失効しうる（それを知らせるのがこの配信）
         -- 同じ月のうちに送っていない（月1回まで。dedupe_key でも同じ月は弾かれる）
         AND NOT EXISTS (
           SELECT 1 FROM message_logs m
           WHERE m.customer_id = c.id AND m.job_type = 'carryNudge'
             AND m.sent_at >= $1::date
         )
       GROUP BY c.id, c.line_user_id, c.name
       ORDER BY c.id`,
      [first, today.iso, last]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, queued: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      try {
        const message = buildCarryNudgeMessage({ customerName: row.name, pets: row.pets });
        const result = await lineClient.deliver({
          customerId: row.id,
          lineUserId: row.line_user_id,
          jobType: 'carryNudge',
          dedupeKey: `carry_nudge:cust:${row.id}:${month}`,
          messages: [message],
          approvable: true,   // 承認モード（スタッフ確認付き送信）の対象
        });
        if (result.status === 'sent') summary.sent++;
        else if (result.status === 'dry_run') summary.dryRun++;
        else if (result.status === 'queued') summary.queued++;
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

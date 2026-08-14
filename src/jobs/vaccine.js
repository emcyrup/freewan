// ワクチン更新案内ジョブ（要件 R3）: 接種日から1年の期限が近づいた子の
// 飼い主様へ更新をお願いし、スタッフにも一覧を通知する（受け入れ可否の確認漏れ防止）。
// 直近半年以内に利用のあるお客様だけに送る。疎遠になったお客様への
// 「更新してください」は営業と受け取られやすく、休眠フォロー（R10）の役割と分ける。
import { buildVaccineMessage } from '../line/messages/vaccine.js';
import { jstToday } from '../util/jst.js';

export function createVaccineJob({ pool, lineClient, slack = null, remindDays = 30, activeDays = 180 }) {
  return async function run() {
    const today = jstToday();

    // 混合・狂犬病を1つの LATERAL で行に展開し、期限が窓内のものだけ残す。
    // 期限は「接種日＋1年」で導出（テーブルには接種日しか持たない）
    const { rows } = await pool.query(
      `SELECT c.id, c.line_user_id, c.name,
              json_agg(json_build_object(
                'name', p.name, 'vaccine', v.label, 'expiresOn', v.expires_on::text
              ) ORDER BY p.id, v.label) AS pets
       FROM customers c
       JOIN pets p ON p.customer_id = c.id
       JOIN LATERAL (
         SELECT t.label, t.expires_on
         FROM (VALUES
           ('混合ワクチン',   (p.mixed_vaccinated_on  + INTERVAL '1 year')::date),
           ('狂犬病予防接種', (p.rabies_vaccinated_on + INTERVAL '1 year')::date)
         ) AS t(label, expires_on)
         WHERE t.expires_on IS NOT NULL
           AND t.expires_on >= (now() AT TIME ZONE 'Asia/Tokyo')::date
           AND t.expires_on <= (now() AT TIME ZONE 'Asia/Tokyo')::date + ($1 * INTERVAL '1 day')
       ) v ON true
       WHERE c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'vaccine' AND s.enabled = false
         )
         -- 直近半年以内の利用者のみ
         AND c.last_visit_at IS NOT NULL
         AND c.last_visit_at >= (now() AT TIME ZONE 'Asia/Tokyo')::date - ($2 * INTERVAL '1 day')
         -- 案内の窓（既定30日）のうちに送っていない（その期間に1回まで）
         AND NOT EXISTS (
           SELECT 1 FROM message_logs m
           WHERE m.customer_id = c.id AND m.job_type = 'vaccine'
             AND m.sent_at > now() - ($1 * INTERVAL '1 day')
         )
       GROUP BY c.id, c.line_user_id, c.name
       ORDER BY c.id`,
      [remindDays, activeDays]
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, queued: 0, skipped: 0, failed: 0, errors: [] };
    const staffLines = [];

    for (const row of rows) {
      try {
        const message = buildVaccineMessage({ customerName: row.name, pets: row.pets });
        // dedupe は「一番近い期限」を軸にする。同じ期限に対して二重には送らず、
        // 次のワクチンが窓に入ってきたときは新しいキーになって案内できる
        const minExpiry = row.pets.map((p) => p.expiresOn).sort()[0];
        const result = await lineClient.deliver({
          customerId: row.id,
          lineUserId: row.line_user_id,
          jobType: 'vaccine',
          dedupeKey: `vaccine:cust:${row.id}:${minExpiry}`,
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
        // 送信の成否に関わらずスタッフには知らせる（台帳の更新・声かけの段取りに使うため）
        if (result.status !== 'skipped') {
          for (const p of row.pets) {
            staffLines.push(`・${p.name}ちゃん（${row.name}様）: ${p.vaccine} ${p.expiresOn}まで`);
          }
        }
      } catch (err) {
        summary.failed++;
        summary.errors.push({ customerId: row.id, message: err.message });
      }
    }

    if (slack && staffLines.length > 0) {
      await slack.notify(
        `:syringe: *ワクチン更新が近い子（${remindDays}日以内）*\n${staffLines.join('\n')}\n` +
          `更新を確認したらカルテの接種日を新しい日付に直してください。`
      );
    }
    return summary;
  };
}

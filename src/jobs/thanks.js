// 来店お礼ジョブ（要件 R9）: 当日来店（visited）した予約のうち、スタッフが写真を
// 付けたものだけへ、お礼のメッセージと写真を送る。
// 「写真を付ける」操作を送る意思表示とみなす（写真なしの全来店者へ自動送信すると
// お礼が形式的になり、通数も消費するため）。
// 実行は 19:00 JST（営業終了後）。10:00 の日次まとめとは別枠で動かす。
import { buildThanksMessages } from '../line/messages/thanks.js';

// LINE の Push は1回5通まで。お礼テキスト1通＋写真4枚に収める
export const MAX_THANKS_PHOTOS = 4;

export function createThanksJob({ pool, lineClient, publicBaseUrl }) {
  return async function run() {
    // 写真は LINE クライアントが公開 URL から直接取得する。URL を組み立てられない
    // 構成では送りようがないため、対象を数える前に設定不足として空で返す
    if (!publicBaseUrl) {
      console.error('[thanks] PUBLIC_BASE_URL（または DOMAIN）が未設定のため実行できません');
      return { total: 0, sent: 0, dryRun: 0, queued: 0, skipped: 0, failed: 0, errors: [] };
    }

    const { rows } = await pool.query(
      `SELECT r.id AS reservation_id, c.id, c.line_user_id, c.name, p.name AS pet_name,
              (SELECT json_agg(vp.file ORDER BY vp.sort_order, vp.id)
               FROM visit_photos vp WHERE vp.reservation_id = r.id) AS files
       FROM reservations r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN pets p ON p.id = r.pet_id
       WHERE r.status = 'visited'
         AND (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date = (now() AT TIME ZONE 'Asia/Tokyo')::date
         AND c.line_user_id IS NOT NULL
         AND c.opt_out = false
         AND c.is_blocked = false
         AND NOT EXISTS (
           SELECT 1 FROM customer_reminder_settings s
           WHERE s.customer_id = c.id AND s.job = 'thanks' AND s.enabled = false
         )
         -- 写真が付いた来店だけ（写真＝送る意思表示）
         AND EXISTS (SELECT 1 FROM visit_photos vp WHERE vp.reservation_id = r.id)
       ORDER BY r.id`
    );

    const summary = { total: rows.length, sent: 0, dryRun: 0, queued: 0, skipped: 0, failed: 0, errors: [] };

    for (const row of rows) {
      try {
        const photoUrls = (row.files ?? [])
          .slice(0, MAX_THANKS_PHOTOS)
          .map((f) => `${publicBaseUrl}/thanks-media/${f}`);
        const messages = buildThanksMessages({
          customerName: row.name,
          petName: row.pet_name,
          photoUrls,
        });
        const result = await lineClient.deliver({
          customerId: row.id,
          lineUserId: row.line_user_id,
          jobType: 'thanks',
          reservationId: row.reservation_id,
          dedupeKey: `thanks:res:${row.reservation_id}`,
          messages,
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

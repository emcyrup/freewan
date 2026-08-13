// 予約時刻を過ぎた SNS 投稿（Instagram / Threads）を公開する。数分おきの cron から呼ばれる。
//
// 二重投稿を防ぐため、対象の行をまず publishing に更新してから投稿する
// （UPDATE ... WHERE status = 'scheduled' が同時実行時のロック代わりになる）。
import { splitIntoPosts } from '../instagram/client.js';

const PLATFORM_LABELS = { instagram: 'Instagram', threads: 'スレッズ' };

export function createSnsPublisher({ pool, instagram, threads = null, slack, config }) {
  function photoUrl(file) {
    if (!config.publicBaseUrl) throw new Error('PUBLIC_BASE_URL（または DOMAIN）が未設定です');
    return `${config.publicBaseUrl}/sns-media/${file}`;
  }

  /** 1件の投稿レコードを実際に公開する（Instagram は10枚超を自動分割） */
  async function publishOne(postId) {
    const { rows: claimed } = await pool.query(
      `UPDATE sns_posts SET status = 'publishing'
       WHERE id = $1 AND status IN ('scheduled', 'failed')
       RETURNING id, caption, platform`,
      [postId]
    );
    if (claimed.length === 0) return { ok: false, error: 'not_publishable' };
    const post = claimed[0];

    const { rows: photos } = await pool.query(
      `SELECT file FROM sns_photos WHERE post_id = $1 ORDER BY sort_order, id`,
      [postId]
    );
    if (photos.length === 0) {
      await pool.query(`UPDATE sns_posts SET status = 'failed', error = $2 WHERE id = $1`, [
        postId,
        '写真がありません',
      ]);
      return { ok: false, error: 'no_photos' };
    }

    const platform = post.platform || 'instagram';
    const client = platform === 'threads' ? threads : instagram;
    if (!client) {
      await pool.query(`UPDATE sns_posts SET status = 'failed', error = $2 WHERE id = $1`, [
        postId,
        `${PLATFORM_LABELS[platform] ?? platform} への投稿が設定されていません`,
      ]);
      return { ok: false, error: 'platform_unavailable' };
    }

    try {
      // Threads は1投稿20枚まで入るため分割しない（Instagram だけ10枚で割る）
      const parts =
        platform === 'threads'
          ? [{ files: photos.map((p) => p.file), caption: post.caption }]
          : splitIntoPosts(photos.map((p) => p.file), post.caption);
      const mediaIds = [];
      let dryRun = false;
      for (const part of parts) {
        const result = await client.publishPost({
          imageUrls: part.files.map(photoUrl),
          caption: part.caption,
        });
        if (result.status === 'dry_run') dryRun = true;
        if (result.mediaId) mediaIds.push(result.mediaId);
      }
      await pool.query(
        `UPDATE sns_posts
         SET status = $2, published_at = now(), media_ids = $3, error = NULL
         WHERE id = $1`,
        [postId, dryRun ? 'dry_run' : 'published', mediaIds.join(',') || null]
      );
      return { ok: true, status: dryRun ? 'dry_run' : 'published', parts: parts.length };
    } catch (err) {
      await pool.query(`UPDATE sns_posts SET status = 'failed', error = $2 WHERE id = $1`, [
        postId,
        err.message,
      ]);
      // 予約投稿の失敗は放置すると気付けないため、スタッフへ即時通知する
      const label = PLATFORM_LABELS[platform] ?? platform;
      await slack.notify(`:warning: *${label} 投稿に失敗しました*（post=${postId}）\n${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  /** 予約時刻を過ぎた投稿をまとめて処理する（cron 用） */
  async function publishDue() {
    const { rows } = await pool.query(
      `SELECT id FROM sns_posts
       WHERE status = 'scheduled' AND scheduled_at <= now()
       ORDER BY scheduled_at
       LIMIT 5`
    );
    const results = [];
    for (const row of rows) {
      results.push({ id: row.id, ...(await publishOne(row.id)) });
    }
    return results;
  }

  return { publishOne, publishDue };
}

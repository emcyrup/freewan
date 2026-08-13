// SNS 投稿（Instagram / スレッズ）の管理 API。全ルートが Basic 認証（index.js 側で適用）配下にある前提。
//
// 写真は管理画面のブラウザ側で JPEG へ正規化してから、1枚ずつ raw ボディで受け取る
// （multipart パーサを足さず依存を増やさないため）。保存名は推測不能なランダム値。
import { randomBytes } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';

const MAX_PHOTOS = 20; // 10枚×2投稿ぶんまで
const MAX_CAPTION = 2200; // Instagram の上限
const MAX_THREADS_TEXT = 500; // Threads の上限（Instagram より短い）
const PLATFORMS = ['instagram', 'threads'];

export function createSnsRouter({ pool, publisher, dataDir }) {
  const router = express.Router();

  // ---- 写真アップロード（正規化済み JPEG を1枚ずつ）----
  router.post(
    '/photos',
    express.raw({ type: ['image/jpeg'], limit: '8mb' }),
    async (req, res, next) => {
      try {
        const buf = req.body;
        // JPEG のマジックバイト。ブラウザ側の変換をすり抜けた別形式を弾く
        if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
          return res.status(400).json({ error: 'invalid_jpeg' });
        }
        const file = `${randomBytes(12).toString('hex')}.jpg`;
        await writeFile(path.join(dataDir, file), buf);
        res.json({ ok: true, file });
      } catch (err) {
        next(err);
      }
    }
  );

  // ---- アップロード済み写真の削除（投稿前に選択から外したとき）----
  // 投稿に紐づいた写真は消さない（履歴のサムネイル表示が壊れるため）
  router.delete('/photos/:file', async (req, res, next) => {
    try {
      const { file } = req.params;
      if (!/^[0-9a-f]{24}\.jpg$/.test(file)) return res.status(400).json({ error: 'invalid_file' });
      const { rows } = await pool.query(`SELECT 1 FROM sns_photos WHERE file = $1 LIMIT 1`, [file]);
      if (rows.length > 0) return res.status(400).json({ error: 'file_in_use' });
      await unlink(path.join(dataDir, file)).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // ---- 投稿の作成（即時 or 予約）----
  router.post('/posts', async (req, res, next) => {
    try {
      const { caption = '', files, scheduledAt = null, platform = 'instagram' } = req.body ?? {};
      if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'invalid_platform' });
      if (!Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: 'no_photos' });
      }
      if (files.length > MAX_PHOTOS) return res.status(400).json({ error: 'too_many_photos' });
      const maxCaption = platform === 'threads' ? MAX_THREADS_TEXT : MAX_CAPTION;
      if (typeof caption !== 'string' || caption.length > maxCaption) {
        return res.status(400).json({ error: 'invalid_caption' });
      }
      // アップロード API が発行した名前だけを受け付ける（パス操作の防止）
      if (!files.every((f) => /^[0-9a-f]{24}\.jpg$/.test(f))) {
        return res.status(400).json({ error: 'invalid_file' });
      }
      let when = null;
      if (scheduledAt) {
        when = new Date(scheduledAt);
        if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'invalid_datetime' });
      }

      const client = await pool.connect();
      let postId;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO sns_posts (caption, scheduled_at, platform)
           VALUES ($1, COALESCE($2, now()), $3)
           RETURNING id`,
          [caption, when, platform]
        );
        postId = rows[0].id;
        for (let i = 0; i < files.length; i++) {
          await client.query(
            `INSERT INTO sns_photos (post_id, file, sort_order) VALUES ($1, $2, $3)`,
            [postId, files[i], i]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // 予約なし（即時投稿）は cron を待たずこの場で公開する
      if (!when) {
        const result = await publisher.publishOne(postId);
        return res.json({ ok: result.ok, postId, ...result });
      }
      return res.json({ ok: true, postId, status: 'scheduled' });
    } catch (err) {
      next(err);
    }
  });

  // ---- 一覧（管理画面の履歴表示用）----
  router.get('/posts', async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.caption, p.status, p.platform, p.scheduled_at, p.published_at, p.error,
                count(ph.id)::int AS photo_count,
                (SELECT file FROM sns_photos WHERE post_id = p.id ORDER BY sort_order, id LIMIT 1) AS thumb
         FROM sns_posts p
         LEFT JOIN sns_photos ph ON ph.post_id = p.id
         GROUP BY p.id
         ORDER BY p.created_at DESC
         LIMIT 20`
      );
      res.json({ posts: rows });
    } catch (err) {
      next(err);
    }
  });

  // ---- 予約の取り消し（未投稿のものだけ。写真ファイルも掃除する）----
  router.post('/posts/:id/cancel', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { rows: photos } = await pool.query(
        `SELECT file FROM sns_photos WHERE post_id = $1`,
        [id]
      );
      const { rowCount } = await pool.query(
        `DELETE FROM sns_posts WHERE id = $1 AND status IN ('scheduled', 'failed')`,
        [id]
      );
      if (rowCount === 0) return res.status(400).json({ error: 'not_cancellable' });
      for (const p of photos) {
        // 同じ写真を別の投稿でも使っていることがある（Instagram と スレッズ に同じ写真を出す等）。
        // 消してしまうと残った投稿が画像を取得できなくなるため、他で使われていないものだけ消す
        const { rows: used } = await pool.query(
          `SELECT 1 FROM sns_photos WHERE file = $1 LIMIT 1`,
          [p.file]
        );
        if (used.length > 0) continue;
        await unlink(path.join(dataDir, p.file)).catch(() => {});
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

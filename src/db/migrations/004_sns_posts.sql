-- Instagram 投稿（管理画面から作成し、即時または予約時刻に自動投稿する）

CREATE TABLE IF NOT EXISTS sns_posts (
  id            BIGSERIAL PRIMARY KEY,
  caption       TEXT NOT NULL DEFAULT '',
  -- scheduled: 予約時刻待ち / publishing: 投稿処理中（多重実行の防止用）
  -- published: 投稿済み / dry_run: ガードにより実投稿せず完了 / failed: 失敗
  status        TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'publishing', 'published', 'dry_run', 'failed')),
  scheduled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ,
  -- 10枚超は自動で複数投稿に分割されるため、メディアIDは複数になりうる
  media_ids     TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sns_posts_due_idx ON sns_posts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS sns_photos (
  id          BIGSERIAL PRIMARY KEY,
  post_id     BIGINT NOT NULL REFERENCES sns_posts(id) ON DELETE CASCADE,
  -- 公開ディレクトリ内のファイル名（推測不能なランダム名）。パスは含めない
  file        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sns_photos_post_idx ON sns_photos (post_id, sort_order);

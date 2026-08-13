-- SNS 投稿に投稿先を持たせる（Instagram / Threads）。
-- 既存行はすべて Instagram 投稿なので、既定値でそのまま移行できる。

ALTER TABLE sns_posts
  ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'instagram';

DO $$
BEGIN
  ALTER TABLE sns_posts
    ADD CONSTRAINT sns_posts_platform_check CHECK (platform IN ('instagram', 'threads'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 予約投稿の取り出しは投稿先を問わず時刻順で行うため、既存の due インデックスをそのまま使う

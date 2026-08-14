-- リマインドの「スタッフ確認付き送信」（試験運用 Phase 5 用）。
-- 承認モードが manual のとき、日次ジョブは送信せずここに積み、
-- 管理画面でスタッフが承認したものだけを実際に送信する。

CREATE TABLE pending_deliveries (
  id             BIGSERIAL PRIMARY KEY,
  job_type       TEXT NOT NULL,
  customer_id    BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reservation_id BIGINT REFERENCES reservations(id) ON DELETE SET NULL,
  line_user_id   TEXT NOT NULL,             -- 承認時の宛先。ログには出さない（CLAUDE.md）
  dedupe_key     TEXT NOT NULL,             -- 承認送信時に message_logs 側の二重送信防止で使う
  messages       JSONB NOT NULL,            -- 送信予定の LINE メッセージそのもの（承認時に文面を確かめられる）
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected', 'failed')),
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ
);

-- 同じ顧客×ジョブの承認待ちは1件まで。日付入りの dedupe_key は毎日変わるため、
-- 放置された承認待ちに翌日のジョブが重ねて積むのをここで防ぐ
CREATE UNIQUE INDEX pending_deliveries_pending_uniq
  ON pending_deliveries (job_type, customer_id) WHERE status = 'pending';

CREATE INDEX pending_deliveries_status_idx ON pending_deliveries (status, created_at);

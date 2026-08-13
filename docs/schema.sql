-- LINE リマインド配信システム スキーマ全体像（読み物用）
--
-- ※ これは現在のスキーマを1枚にまとめた参照用ファイルであり、適用対象ではない。
--    実際に適用されるのは src/db/migrations/NNN_*.sql（`npm run migrate`）で、
--    スキーマの正はそちら。差異が出た場合は migrations を信じること。
--
-- 全タイムスタンプは TIMESTAMPTZ。日付比較は Asia/Tokyo に明示変換して行う。

-- requested: LIFF 予約フォームからの承認待ち。配信ジョブは confirmed のみを対象にするため、
-- 未承認の予約に前々日確認は飛ばない
CREATE TYPE reservation_status AS ENUM
  ('requested', 'confirmed', 'cancelled', 'visited', 'no_show');
-- reservation_confirmed: 予約リクエストを承認したときに顧客へ送る確定通知
CREATE TYPE job_type          AS ENUM
  ('pre_reminder', 'after_visit', 'dormant', 'birthday', 'reservation_confirmed');
CREATE TYPE send_status       AS ENUM ('sent', 'failed', 'skipped');

CREATE TABLE staff (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id            BIGSERIAL PRIMARY KEY,
  line_user_id  TEXT UNIQUE,               -- 未紐付けの顧客は NULL
  name          TEXT NOT NULL,
  phone_norm    TEXT,                      -- ハイフン除去済み。突合キー
  birthday      DATE,                      -- LINE からは取得不可。LIFF で収集
  last_visit_at DATE,                      -- 休眠判定用。visited 登録時に更新
  opt_out       BOOLEAN NOT NULL DEFAULT FALSE,  -- 販促配信の停止希望
  is_blocked    BOOLEAN NOT NULL DEFAULT FALSE,  -- unfollow 時に TRUE
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX customers_phone_norm_key
  ON customers (phone_norm) WHERE phone_norm IS NOT NULL;
CREATE INDEX customers_birthday_md_idx
  ON customers (EXTRACT(MONTH FROM birthday), EXTRACT(DAY FROM birthday));
CREATE INDEX customers_last_visit_idx ON customers (last_visit_at);

CREATE TABLE reservations (
  id            BIGSERIAL PRIMARY KEY,
  customer_id   BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  staff_id      BIGINT REFERENCES staff(id),
  menu          TEXT,                      -- menus.name のコピー。後からメニュー名を変えても過去の予約は変わらない
  note          TEXT,                      -- 予約フォームの「ご要望」欄
  reserved_at   TIMESTAMPTZ NOT NULL,
  status        reservation_status NOT NULL DEFAULT 'confirmed',
  confirmed_by_customer BOOLEAN NOT NULL DEFAULT FALSE,  -- 前々日確認への返答
  external_id   TEXT UNIQUE,               -- 外部予約システム連携時の元ID
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reservations_reserved_at_idx ON reservations (reserved_at);
CREATE INDEX reservations_customer_idx    ON reservations (customer_id, reserved_at DESC);

-- 配信ログ。dedupe_key の UNIQUE 制約が二重送信を防ぐ唯一の砦。
-- 送信「前」に INSERT し、成功後に status を確定させる。
CREATE TABLE message_logs (
  id             BIGSERIAL PRIMARY KEY,
  dedupe_key     TEXT NOT NULL UNIQUE,
  customer_id    BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reservation_id BIGINT REFERENCES reservations(id) ON DELETE SET NULL,
  job_type       job_type NOT NULL,
  status         send_status NOT NULL DEFAULT 'sent',
  error          TEXT,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX message_logs_customer_job_idx ON message_logs (customer_id, job_type, sent_at DESC);

-- 顧客からの反応（postback / 自由入力）
CREATE TABLE customer_responses (
  id             BIGSERIAL PRIMARY KEY,
  customer_id    BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  message_log_id BIGINT REFERENCES message_logs(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL,  -- confirm_ok / confirm_change / good / concern / question / opt_out
  raw_text       TEXT,
  notified_at    TIMESTAMPTZ,    -- Slack 通知済みなら時刻が入る
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 予約フォームで顧客が選ぶメニュー。管理画面から登録する
CREATE TABLE menus (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  duration_minutes INTEGER,                          -- 任意。顧客への表示と店舗の目安に使う
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX menus_active_idx ON menus (active, sort_order, id);

-- 実行時に変わる設定値（スタッフ通知先グループなど）。
-- 環境変数と違い、再デプロイなしで更新できる
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- dedupe_key の命名規則
--   pre_reminder          : pre_reminder:res:{reservation_id}
--   after_visit           : after_visit:res:{reservation_id}
--   dormant               : dormant:cust:{customer_id}:{YYYY-MM-DD}
--   birthday              : birthday:cust:{customer_id}:{YYYY}
--   reservation_confirmed : reservation_{confirmed|cancelled}:res:{reservation_id}

-- LIFF 予約フォーム（顧客がリッチメニューから予約をリクエストする）用の追加。

-- 顧客が送信した予約は requested（承認待ち）で作られ、店舗が承認して初めて confirmed になる。
-- 配信ジョブは confirmed のみを対象にしているため、未承認の予約に前々日確認は飛ばない。
ALTER TYPE reservation_status ADD VALUE IF NOT EXISTS 'requested';

-- 承認時に顧客へ送る確定通知も message_logs に記録し、二重送信を防ぐ
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'reservation_confirmed';

-- 予約フォームで顧客が選ぶメニュー。予約側には名称をコピーして保存するため、
-- ここでメニュー名を変更しても過去の予約の表示は変わらない
CREATE TABLE IF NOT EXISTS menus (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  duration_minutes INTEGER,                          -- 任意。顧客への表示と店舗の目安に使う
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menus_active_idx ON menus (active, sort_order, id);

-- 予約フォームの「ご要望」欄
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS note TEXT;

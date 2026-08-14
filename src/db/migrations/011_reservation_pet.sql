-- 来店登録と回数消化の連動（handover「次に着手 1.」）
-- 予約に「どの子か」を持たせ、来店（visited）時に回数を自動消化できるようにする。

-- どの子の予約か。ペット削除時も予約履歴は残したいので SET NULL
ALTER TABLE reservations
  ADD COLUMN pet_id BIGINT REFERENCES pets(id) ON DELETE SET NULL;

CREATE INDEX reservations_pet_idx ON reservations (pet_id, reserved_at DESC);

-- メニューごとの消化対象。NULL = 消化しない（都度払い）。
-- 'plan' = 定額コース（スクール会員）を1回消化、'ticket' = 回数券を1回消化。
-- 店舗ごとの割り当ては scripts/store-data/ の JSON か管理 API で設定する。
ALTER TABLE menus
  ADD COLUMN consumes TEXT CHECK (consumes IN ('plan', 'ticket'));

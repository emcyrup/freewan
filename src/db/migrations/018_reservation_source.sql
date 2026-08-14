-- 来店経路（要件書 2.1 / 2.4）。どこから入ったご予約かを1件ずつ残す。
--
-- 顧客ではなく予約に持たせる。同じお客様でも「今回はEPARK、前回は電話」があり、
-- 集計したいのは「その月に何経路から何件入ったか」だから。
--
-- 既に入っている予約には値が無い（NULL＝不明）。後から画面で直せる。
ALTER TABLE reservations
  ADD COLUMN source TEXT
  CHECK (source IN ('epark', 'tel', 'epark_tel', 'line', 'walkin', 'other'));

COMMENT ON COLUMN reservations.source IS
  '来店経路。epark=EPARK / tel=電話 / epark_tel=EPARKのTEL予約 / line=公式LINE / walkin=ご来店 / other=紹介・その他';

-- 月ごとの集計で使う
CREATE INDEX reservations_source_idx ON reservations (source, reserved_at);

-- 公式LINEの予約フォームから入ったものは経路が確定している。
-- 取り込み API 経由（external_id あり）は EPARK からの取り込みなので epark とみなす
UPDATE reservations SET source = 'line'
  WHERE source IS NULL AND external_id IS NULL AND status = 'requested';
UPDATE reservations SET source = 'epark'
  WHERE source IS NULL AND external_id IS NOT NULL AND external_id NOT LIKE 'demo:%';

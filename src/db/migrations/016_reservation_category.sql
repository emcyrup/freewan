-- 予約の区分（ホテル／トリミング／スクール）と、重複判定に使う所要時間。
--
-- 区分と所要時間はメニュー側に持たせたうえで、予約作成時に予約へコピーする。
-- メニュー名を後から変えても過去の予約が変わらないのと同じ理由で、
-- メニューの設定を変えても入っている予約の判定は変わらないようにする。
ALTER TABLE menus
  ADD COLUMN category TEXT CHECK (category IN ('hotel', 'trimming', 'school'));

ALTER TABLE reservations
  ADD COLUMN category         TEXT CHECK (category IN ('hotel', 'trimming', 'school')),
  -- 終了時刻ではなく長さで持つ。開始をずらしたときに終了を直し忘れる事故を防ぐ
  ADD COLUMN duration_minutes INTEGER CHECK (duration_minutes > 0),
  -- スクールの進み方（カウンセリング → 体験 → 入園）。他の区分では NULL
  ADD COLUMN school_stage     TEXT CHECK (school_stage IN ('counseling', 'trial', 'enrolled'));

-- 重複判定は「同じ担当者の同じ日」を引くので、その形の索引を用意する
CREATE INDEX reservations_staff_day_idx
  ON reservations (staff_id, reserved_at)
  WHERE staff_id IS NOT NULL AND status IN ('requested', 'confirmed');

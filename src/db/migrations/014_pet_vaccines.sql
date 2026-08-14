-- ワクチン接種日（要件 R3 ワクチン管理＋更新案内）。
-- 年1回の更新なので接種日だけを持ち、期限は「接種日＋1年」で導く。
-- 期限を別カラムで持つと、更新時に片方だけ直して二重管理になるため。
ALTER TABLE pets
  ADD COLUMN mixed_vaccinated_on  DATE,   -- 混合ワクチン
  ADD COLUMN rabies_vaccinated_on DATE;   -- 狂犬病予防接種

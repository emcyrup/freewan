-- お客様ごとのリマインド ON/OFF。
--
-- customers.opt_out は「この方への自動配信をすべて止める」ための一括スイッチで、
-- 「誕生日だけ辞退したい」のような個別の希望は表現できなかった。ここで種類ごとに持つ。
--
-- 行が無い＝既定（ON）。OFF にしたものだけが残るので、既存環境の挙動は変わらない。
-- 顧客を消したときに設定だけ残らないよう CASCADE にする。
CREATE TABLE customer_reminder_settings (
  customer_id BIGINT      NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  job         TEXT        NOT NULL,
  enabled     BOOLEAN     NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, job)
);

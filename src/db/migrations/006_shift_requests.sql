-- スタッフの LINE 連携と、公式LINE から届くシフト変更申請。
--
-- 顧客の発言を誤って申請として扱わないよう、スタッフの識別は line_user_id の一致だけで行う。
-- 連携は管理画面で発行した合言葉をスタッフ本人が送る方式にした。LINE の userId は本人からは
-- 見えないため、管理画面から手入力してもらう運用が成立しないため。

CREATE TYPE shift_kind AS ENUM ('work', 'am', 'pm', 'koukyu', 'yukyu', 'jikan');
CREATE TYPE shift_request_status AS ENUM ('pending', 'approved', 'rejected');

ALTER TABLE staff ADD COLUMN line_user_id TEXT UNIQUE;
-- 連携用の合言葉。使い捨てにするため、連携が済んだら NULL に戻す
ALTER TABLE staff ADD COLUMN link_code TEXT UNIQUE;
ALTER TABLE staff ADD COLUMN link_code_expires_at TIMESTAMPTZ;

CREATE TABLE shift_requests (
  id          BIGSERIAL PRIMARY KEY,
  staff_id    BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  kind        shift_kind NOT NULL,
  start_time  TIME,           -- kind = 'jikan' のときだけ使う
  end_time    TIME,
  reason      TEXT,
  -- 申請の原文。AI の解釈がずれていないかを承認者が確かめられるよう必ず残す
  raw_text    TEXT NOT NULL,
  status      shift_request_status NOT NULL DEFAULT 'pending',
  decided_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX shift_requests_status_idx ON shift_requests (status, target_date);
CREATE INDEX shift_requests_staff_idx  ON shift_requests (staff_id, target_date DESC);

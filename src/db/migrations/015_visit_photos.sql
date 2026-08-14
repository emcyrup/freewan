-- 来店お礼配信（要件 R9）に添付する写真。予約（来店）単位で持つ。
-- スタッフが写真を付けた来店だけがお礼配信の対象になる（写真＝送る意思表示）。
-- ファイル名は SNS 投稿と同じ推測不能なランダム値で、認証なしの
-- 静的配信（/thanks-media）から LINE クライアントが直接取得する。
CREATE TABLE visit_photos (
  id             BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  file           TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX visit_photos_reservation_idx ON visit_photos (reservation_id, sort_order, id);

-- ペット（わんちゃん）情報。ドッグサロンのため顧客本人とは別に管理する。
-- 顧客削除時に取り残されないよう CASCADE にする
CREATE TABLE pets (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  breed       TEXT,
  birthday    DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pets_customer ON pets (customer_id);

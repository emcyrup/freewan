-- 回数券・保育コース（定額プラン）の回数管理。
--
-- 残回数を列で持たず、付与・消化・失効を1行ずつ積む元帳にしている。
-- 集計値を別に持つと履歴と残数がずれ、どちらが正しいのか分からなくなるため。
-- 残回数は SUM(count) で常に履歴から導く。

-- 定額プランのマスタ（例: 保育コース 月4回 / 月8回）
CREATE TABLE plans (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT    NOT NULL,
  monthly_quota     INT     NOT NULL CHECK (monthly_quota > 0),
  -- 使い切らなかった分を持ち越せる月数。0 なら繰越なし
  carry_over_months INT     NOT NULL DEFAULT 1 CHECK (carry_over_months >= 0),
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order        INT     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- プランの加入。保育コースは頭数ごとの契約なので、顧客ではなく わんちゃん に紐づける
CREATE TABLE pet_plans (
  id         BIGSERIAL PRIMARY KEY,
  pet_id     BIGINT NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  plan_id    BIGINT NOT NULL REFERENCES plans(id),
  started_on DATE   NOT NULL,
  ended_on   DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pet_plans_pet_idx ON pet_plans (pet_id);
-- 同じ子が同時に二重加入しないようにする（継続中は1件まで）
CREATE UNIQUE INDEX pet_plans_active_uniq ON pet_plans (pet_id) WHERE ended_on IS NULL;

-- ticket: 回数券（都度購入） / plan: 定額プランの月次付与
CREATE TYPE credit_source AS ENUM ('ticket', 'plan');
-- grant: 付与 / use: 消化 / expire: 期限切れ
CREATE TYPE credit_kind AS ENUM ('grant', 'use', 'expire');

CREATE TABLE plan_credits (
  id             BIGSERIAL     PRIMARY KEY,
  pet_id         BIGINT        NOT NULL REFERENCES pets(id) ON DELETE CASCADE,
  source         credit_source NOT NULL,
  kind           credit_kind   NOT NULL,
  -- grant は正、use / expire は負。合計がそのまま残回数になる
  count          INT           NOT NULL CHECK (count <> 0),
  effective_on   DATE          NOT NULL,
  -- grant のみ。この日を過ぎた残りは失効させる
  expires_on     DATE,
  -- use / expire が、どの付与を消したものか。付与ごとの残数を出すために持つ
  grant_id       BIGINT        REFERENCES plan_credits(id) ON DELETE CASCADE,
  reservation_id BIGINT        REFERENCES reservations(id) ON DELETE SET NULL,
  note           TEXT,
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- 符号の取り違えは残数が静かに狂うため、DB 側でも弾く
  CONSTRAINT plan_credits_sign CHECK (
    (kind = 'grant' AND count > 0 AND grant_id IS NULL)
    OR (kind <> 'grant' AND count < 0 AND grant_id IS NOT NULL)
  )
);
CREATE INDEX plan_credits_pet_idx   ON plan_credits (pet_id, effective_on DESC);
CREATE INDEX plan_credits_grant_idx ON plan_credits (grant_id);

-- 月次付与を二重に走らせても増えないようにする。
-- ジョブが再実行されたり、手動実行と重なったりしても1回だけになる
CREATE UNIQUE INDEX plan_credits_monthly_uniq
  ON plan_credits (pet_id, effective_on)
  WHERE source = 'plan' AND kind = 'grant';

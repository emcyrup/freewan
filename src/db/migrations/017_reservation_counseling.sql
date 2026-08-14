-- カウンセリングをスクールと同じ回に行えるようにする。
--
-- 店舗の流れは2通りある。
--   1. スクール初回時にカウンセリング未実施 → その回でカウンセリングをしてからスクール
--   2. スクール初回前にカウンセリング実施済み → その回はスクールのみ
--
-- school_stage（カウンセリング／体験／入園）は「その子がどこまで進んでいるか」を表すため、
-- 同じ回で両方やる 1. を表せなかった。実施の有無は別の列に分けて持つ。
ALTER TABLE reservations
  ADD COLUMN with_counseling BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN reservations.with_counseling IS
  'この来店でカウンセリングも行う（スクール・体験と同時実施）。段階そのものは school_stage';

-- 既にカウンセリング目的で入れてある予約は、実施ありとして扱う
UPDATE reservations SET with_counseling = TRUE WHERE school_stage = 'counseling';

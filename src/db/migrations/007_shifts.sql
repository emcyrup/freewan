-- 週次シフト。スタッフ×日付で1行を持つ。
--
-- 行が無い日は「未入力」であって「出勤」ではない。既定を出勤にすると、入力漏れの日に
-- 予約を入れられてしまうため、入っていないことを明示的に区別する。
-- 区分は shift_requests と同じ shift_kind（006）を使い、申請の承認をそのまま反映できるようにする。

CREATE TABLE shifts (
  id          BIGSERIAL PRIMARY KEY,
  staff_id    BIGINT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  work_date   DATE NOT NULL,
  kind        shift_kind NOT NULL,
  start_time  TIME,           -- kind = 'jikan' のときだけ使う
  end_time    TIME,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, work_date)
);

CREATE INDEX shifts_date_idx ON shifts (work_date);

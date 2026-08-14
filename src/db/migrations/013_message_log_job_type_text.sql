-- message_logs.job_type を ENUM から TEXT へ変更する。
-- R6（ticketNudge）以降のジョブは ENUM に無い値を使うため、dry_run 以外では
-- INSERT が失敗し、抽出クエリの比較（m.job_type = 'ticketNudge'）も
-- ENUM への暗黙キャストでエラーになる。ジョブを増やすたびに ALTER TYPE を
-- 書く運用は漏れやすいので、値の管理は型ではなくアプリ側の定数に寄せる。
ALTER TABLE message_logs ALTER COLUMN job_type TYPE TEXT;
DROP TYPE job_type;

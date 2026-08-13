-- アプリ実行時に変わる設定値（スタッフ通知先グループなど）の保存先。
-- 環境変数と違い、再デプロイなしで更新できる。
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

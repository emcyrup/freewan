# CLAUDE.md — LINE リマインド配信システム

## このプロジェクトは何か

店舗（サロン／クリニック等）の LINE 公式アカウントから、顧客へ4種類の自動配信を行うシステム。

1. **前々日確認** — 予約日の2日前に来店確認
2. **来店7日後フォロー** — お礼＋経過確認
3. **休眠フォロー** — 最終来店から90日経過で様子見
4. **誕生日祝い** — 誕生日当日にお祝い＋クーポン

加えて、予約発生時のスタッフ向け自動通知（Slack）を行う。

**重要な前提**: これらは LINE 公式アカウントの標準機能では実現できない。標準の「ステップ配信」は友だち追加が起点のため、予約日・来店日・誕生日を起点にするには Messaging API の Push + 自前DB + 日次バッチが必須。

## 技術スタック

- Node.js (LTS) / Express
- PostgreSQL（マイグレーションは素の SQL ファイル、`db/migrations/NNN_*.sql`）
- LINE Messaging API（`@line/bot-sdk`）
- LIFF（顧客情報登録フォーム）
- Slack Incoming Webhook（スタッフ通知）
- Claude API（Haiku。フォロー回答のネガポジ分類のみに使用）
- Vanilla JS（管理画面・LIFF画面。フレームワークは入れない）

依存は最小限に保つ。新しいライブラリを追加する前に必ず提案して確認を取ること。

## ディレクトリ構成

```
src/
  index.js            Express エントリポイント
  config.js           環境変数の読み込みと検証（起動時に必須変数をチェック）
  db/
    pool.js           pg Pool
    migrations/       NNN_name.sql
  line/
    client.js         Messaging API クライアント。送信は必ずここを経由
    messages/         Flex Message テンプレート（ジョブごとに1ファイル）
  jobs/
    runner.js         node-cron 登録とジョブ共通処理（ログ・エラー通知）
    preReminder.js
    afterVisit.js
    dormant.js
    birthday.js
  webhook/
    handler.js        署名検証 → イベント振り分け
    events/           follow.js / unfollow.js / message.js / postback.js
  notify/
    slack.js
  liff/               LIFF 用の静的ファイル
scripts/
  run-job.js          単一ジョブの手動実行（--job=preReminder --dry-run）
docs/
  spec.md             詳細仕様（配信条件・文面・イベント設計）
  roadmap.md          フェーズ別の実装計画
```

## 絶対に守ること

**誤爆防止が最優先。** 本番顧客に誤って配信すると取り返しがつかない。

- 送信は `SEND_MODE` 環境変数で3段階に制御する。実装は `line/client.js` に集約し、他の場所から直接 API を叩かない。
  - `dry_run` — 送信せず、対象者と本文を標準出力に出すだけ（**デフォルト値はこれ**）
  - `test` — `TEST_LINE_USER_ID` にのみ送信。対象者が誰であっても宛先を差し替える
  - `live` — 本番送信
- `SEND_MODE=live` は環境変数ファイルに書かず、実行時に明示的に渡す運用とする
- 送信前に必ず `message_logs` の `dedupe_key` を UNIQUE 制約でチェック。挿入成功時のみ送信する（先にログ、次に送信の順序。送信失敗時は status を failed に更新）
- ログに顧客の氏名・電話番号・LINE userId を出さない。顧客は必ず内部 `id` で参照する

## 時刻の扱い

- DB のタイムスタンプは全て `TIMESTAMPTZ`
- アプリ・cron ともに `TZ=Asia/Tokyo` 前提。日付比較は `(reserved_at AT TIME ZONE 'Asia/Tokyo')::date` の形で明示的に行う
- 配信時刻は 10:00 JST 固定。深夜・早朝の送信は絶対に行わない

## コーディング規約

- CommonJS ではなく ESM（`"type": "module"`）
- SQL は必ずパラメータ化クエリ。文字列連結でクエリを組み立てない
- 例外は握り潰さない。ジョブ内のエラーは1件ずつ捕捉し、他の対象者の処理を止めずに Slack へ通知する
- コメントは日本語で可。ただし「何をしているか」ではなく「なぜそうしているか」を書く

## 作業の進め方

- `docs/roadmap.md` のフェーズ順に進める。フェーズを飛ばさない
- 1フェーズ完了ごとに動作確認の手順を提示し、確認が取れてから次へ進む
- 仕様に迷いが出たら勝手に決めず、選択肢を挙げて確認を取ること

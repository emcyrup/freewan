# 予約取り込み API

外部予約システム（予約 SaaS・CSV エクスポート等）から `reservations` へ予約を取り込むための API。
`external_id` をキーに**冪等に upsert** するため、同じデータを何度送っても二重登録されない。

## 認証

`.env` の `INGEST_API_TOKEN` に設定したトークンを Bearer で送る（未設定の場合 API は 503 で無効）。

```
Authorization: Bearer <INGEST_API_TOKEN>
```

## エンドポイント

```
POST /api/import/reservations
Content-Type: application/json
```

### リクエスト

```json
{
  "reservations": [
    {
      "external_id": "hotpepper-20260801-001",
      "customer_name": "山田 花子",
      "phone": "090-1234-5678",
      "birthday": "1990-04-01",
      "menu": "シャンプー＆カットコース",
      "staff_name": "佐藤",
      "reserved_at": "2026-08-01T14:00:00+09:00",
      "status": "confirmed"
    }
  ]
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `external_id` | ○ | 外部システム側の予約 ID。冪等キー |
| `customer_name` | ○ | 顧客名。突合は電話番号で行い、名前は新規作成時のみ使用 |
| `phone` | ○ | 顧客の電話番号（表記ゆれは自動正規化） |
| `birthday` | - | `YYYY-MM-DD`。新規顧客作成時のみ反映 |
| `menu` | - | メニュー名 |
| `staff_name` | - | 担当者名。存在しなければ staff に自動作成 |
| `reserved_at` | ○ | ISO 8601。タイムゾーン付き推奨（`+09:00`） |
| `status` | - | `confirmed`（デフォルト） / `cancelled` / `visited` / `no_show` |

- 1リクエスト最大 500 件
- 顧客は電話番号（正規化済み）で既存台帳と突合。ヒットしなければ新規作成（LINE 連携には触らない）
- `status: "visited"` で送ると `customers.last_visit_at` も更新される（来店実績の取り込みに使う）
- 新規の確定予約は Slack に通知される（更新では通知しない）

### レスポンス

```json
{
  "summary": { "total": 1, "created": 1, "updated": 0, "failed": 0 },
  "results": [
    { "external_id": "hotpepper-20260801-001", "ok": true, "reservationId": 12, "customerId": 3, "created": true }
  ]
}
```

行単位でエラーを返すため、1件の不正データで全体は失敗しない。

## 使用例（curl）

```bash
curl -X POST https://<ドメイン>/api/import/reservations \
  -H "Authorization: Bearer $INGEST_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @reservations.json
```

## CSV からの取り込み（EPARK など）

EPARK のように公開 API がない予約システムは、管理画面から CSV をエクスポートして
`scripts/import-csv.js` で取り込む。列名の対応は `scripts/mappings/*.json` で調整する。

```bash
# 変換結果の確認（API には送らない）
node scripts/import-csv.js --file=epark.csv --map=scripts/mappings/epark.json --dry-run

# 取り込み実行（VM 上なら）
docker compose exec app node scripts/import-csv.js \
  --file=/tmp/epark.csv --map=scripts/mappings/epark.json --token=$INGEST_API_TOKEN
```

- `scripts/mappings/epark.json` の `columns` を、実際の CSV のヘッダ行に合わせて修正する
- 文字コードは `encoding`（`shift_jis` / `utf-8`）で指定
- ステータスの文言 →`confirmed`/`visited`/`cancelled`/`no_show` の対応は `statusMap` で定義
- 営業終了後に当日分（来店済み）を再エクスポート→再実行すれば、来店実績も反映される（冪等）

## 運用パターン

- **予約 SaaS に Webhook がある場合**: Webhook 受信側でこの形式に変換して POST する
- **CSV エクスポートしかない場合**: CSV → JSON 変換スクリプトを cron で回して定期 POST する
- **来店実績の反映**: 営業終了後に当日分を `status: "visited"` で再送すれば、来店7日後フォロー・休眠判定が回り出す

# LINE からの予約リクエスト（LIFF 予約フォーム）

顧客はリッチメニューの「ご予約」から予約フォームを開き、希望日時をリクエストできる。

- **承認制**: 顧客が送信した予約は `requested`（承認待ち）で作られる。配信ジョブは `confirmed` のみが対象なので、未承認の予約に前々日確認は飛ばない
- **顧客の特定**: LINE の ID トークンをサーバー側で検証して行う。未登録（LIFF 登録前）の顧客には登録フォームへの導線を出し、リクエストは受け付けない
- **メニュー**: 管理画面の「メニュー管理」で登録したものが選択肢になる。予約側には名称をコピーして保存するため、後でメニュー名を変えても過去の予約表示は変わらない
- **スタッフの操作**: 管理画面の予約一覧で「承認」または「見送り」を押す。承認待ちの予約は期間指定に関わらず常に一覧の先頭に表示される
- **顧客への通知**: 承認・見送りのどちらでも顧客へ Push で結果を伝える（1件につき通数を1消費）
- **連投防止**: 承認待ちが3件たまっている顧客は追加でリクエストできない

動作確認用のデモメニューを一括投入する（同名は飛ばすため何度実行しても安全）:

```bash
docker compose exec app node scripts/seed-menus.js
```

リッチメニューの設定（左：ご予約／右：お客様情報）:

```bash
docker compose exec app node scripts/setup-richmenu.js --image=/path/to/richmenu.png
```

「お客様情報」は登録用と変更用を兼ねる。未登録の顧客には登録フォームとして、
登録済みの顧客には現在の内容を入れた**確認・変更フォーム**として開き、
氏名・電話番号・誕生日・配信同意をその場で直せる。

# 管理画面

`https://<ドメイン>/mock/` でスタッフ向けの店舗管理画面が使える（旧 `/admin/` はリダイレクト）（Basic 認証。`.env` の `ADMIN_USER` / `ADMIN_PASSWORD`）。

- 予約一覧（期間指定。画面の最下部）と、来店 / 取消 / 無断キャンセルの操作（来店で `last_visit_at` が自動更新）
- LINE からの予約リクエストの **承認 / 見送り**（承認待ちは常に一覧の先頭に表示）
- 新規予約の手入力（顧客検索 → 日時・メニュー・担当を指定）
- 電話予約など LINE 未連携の顧客登録、スタッフ追加
- **メニュー管理**（予約フォームの選択肢になる。並び順・所要時間・有効/無効）
- 前々日確認に「このまま伺います」と回答済みの予約には「本人確認済」バッジが付く

**配信メッセージのテスト送信**は別画面（`/mock/#test`）にある。顧客へ送りうる7種類
（前々日確認・来店7日後・休眠・誕生日・予約の受付/確定/見送り）を即時に自分へ送れる。
宛先は必ず `TEST_LINE_USER_ID` に固定され、`dry_run` では標準出力のみ、
`live` では誤爆防止のため実行を拒否する。`message_logs` に記録しないので
`dedupe_key` を消費せず、本番の配信には影響しない。

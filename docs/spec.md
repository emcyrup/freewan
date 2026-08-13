# 詳細仕様

## 1. 顧客と LINE ユーザーの紐付け

システム全体の前提となる最重要ポイント。**この紐付けができていない顧客には一切配信できない。**

### 主経路：LIFF 登録フォーム

友だち追加時のあいさつメッセージから LIFF を開かせ、以下を登録する。

| 項目 | 必須 | 備考 |
|---|---|---|
| 氏名 | ○ | 既存顧客との突合に使用 |
| 電話番号 | ○ | 突合キー。ハイフン除去して正規化 |
| 誕生日 | 任意 | **LINE のプロフィール API では取得できないため、ここでしか取れない** |
| 配信同意 | ○ | チェックボックス。未同意なら `opt_out = true` |

LIFF 側は `liff.getProfile()` で `userId` を取得し、フォーム内容と合わせてサーバへ POST する。サーバは電話番号で既存 `customers` を検索し、ヒットすれば `line_user_id` を更新、なければ新規作成する。

**注意**: LIFF から送られてきた `userId` を無条件で信用しない。`liff.getIDToken()` を送らせ、サーバ側で LINE の検証エンドポイントに投げて `sub` を取り出す。なりすまし防止のため必須。

登録済みの顧客が再度 LIFF を開いた場合は、現在の登録内容を表示して**変更フォーム**として使える。
氏名は初回の紐付け時のみ台帳側を正として上書きしないが、既に本人と紐付いたレコードでは
本人による訂正として反映する。

### 補助経路：あいさつメッセージからのテキスト応答

LIFF 未対応端末や離脱者向けに、「電話番号を送信してください」と案内し、`message` イベントで電話番号らしき文字列を受け取ったら突合する。ヒットしなければスタッフへ Slack 通知して手動対応に回す。

---

## 2. 配信ジョブ仕様

全ジョブ共通で、以下の対象者は除外する。

- `line_user_id IS NULL`
- `opt_out = true`
- `is_blocked = true`（unfollow イベントで立てる）

### 2-1. 前々日確認（preReminder）

**実行**: 毎日 10:00 JST

**抽出条件**
```sql
SELECT r.id, r.reserved_at, r.menu, c.id AS customer_id, c.line_user_id, s.name AS staff_name
FROM reservations r
JOIN customers c ON c.id = r.customer_id
LEFT JOIN staff s ON s.id = r.staff_id
WHERE r.status = 'confirmed'
  AND (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date = (CURRENT_DATE + INTERVAL '2 day')::date
  AND c.line_user_id IS NOT NULL
  AND c.is_blocked = false;
```

`opt_out` はこのジョブでは**除外条件にしない**。予約確認は営業ではなく取引に必要な連絡のため。

**dedupe_key**: `pre_reminder:res:{reservation_id}`

**メッセージ**（Flex Message。ボタン2つ）

> ○○様
> ご予約日が近づいてまいりましたのでご連絡いたします。
>
> 【日時】8月3日(月) 14:00
> 【メニュー】シャンプー＆カットコース
> 【担当】山田
>
> ご都合はいかがでしょうか？

- ボタン1「このまま伺います」→ postback `action=confirm&res={id}&v=ok`
- ボタン2「日程を変更したい」→ postback `action=confirm&res={id}&v=change`

**postback 受信時の挙動**
- `ok` → 「お待ちしております」と応答メッセージ（**通数無料**）。`reservations.confirmed_by_customer = true`
- `change` → 「担当者よりご連絡いたします」と応答し、Slack へ即時通知（顧客名・予約日時・担当者）

### 2-2. 来店7日後フォロー（afterVisit）

**実行**: 毎日 10:00 JST

**抽出条件**: `status = 'visited'` かつ来店日が7日前ちょうど。同一顧客が期間内に複数回来店している場合は最新の1件のみ。

**dedupe_key**: `after_visit:res:{reservation_id}`

**メッセージ**

> ○○様
> 先日はご来店いただきありがとうございました。
> その後の調子はいかがでしょうか？
> 気になる点があれば、このままメッセージでお知らせください。

- ボタン「調子いいです」→ postback `v=good`
- ボタン「気になることがある」→ postback `v=concern` → Slack 通知

**自由入力の返信があった場合**: Claude Haiku で `good` / `concern` / `question` の3値に分類し、`concern` と `question` のみ Slack へ通知する。プロンプトは分類のみを返させ、JSON パース失敗時は安全側に倒して `concern` 扱いにする。

### 2-3. 休眠フォロー（dormant）

**実行**: 毎日 10:00 JST。ただし**同一顧客への送信は90日に1回まで**。

**抽出条件**
```sql
SELECT c.id, c.line_user_id, c.name, c.last_visit_at
FROM customers c
WHERE c.line_user_id IS NOT NULL
  AND c.opt_out = false
  AND c.is_blocked = false
  AND c.last_visit_at IS NOT NULL
  AND c.last_visit_at <= CURRENT_DATE - INTERVAL '90 day'
  -- 未来の確定予約がある顧客は除外
  AND NOT EXISTS (
    SELECT 1 FROM reservations r
    WHERE r.customer_id = c.id AND r.status = 'confirmed' AND r.reserved_at > now()
  )
  -- 直近90日以内に休眠フォローを送っていない
  AND NOT EXISTS (
    SELECT 1 FROM message_logs m
    WHERE m.customer_id = c.id AND m.job_type = 'dormant'
      AND m.sent_at > now() - INTERVAL '90 day'
  );
```

`= 90日` ではなく `<= 90日` にしている理由：バッチが1日でも失敗すると、ちょうど90日の顧客が永久に漏れるため。

**dedupe_key**: `dormant:cust:{customer_id}:{YYYY-MM-DD}`

**初回導入時の注意**: リリース直後は「90日以上来ていない顧客」が全員一斉に対象になる。初回実行前に必ず件数を確認し、必要なら日次上限（例：1日50件）を設けて分散させること。これを忘れると通数を一気に食い潰す。

**メッセージ**: 営業色を抑え、末尾に配信停止導線（「今後この案内が不要な方はこちら」→ postback `action=opt_out`）を必ず入れる。

### 2-4. 誕生日（birthday）

**実行**: 毎日 10:00 JST

**抽出条件**: `EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(DAY FROM birthday) = EXTRACT(DAY FROM CURRENT_DATE)`

**2月29日生まれの扱い**: 平年は 2月28日 に送る。閏年判定を入れ、平年かつ本日が2/28の場合は 2/29生まれも対象に含める。

**dedupe_key**: `birthday:cust:{customer_id}:{YYYY}`

**メッセージ**: お祝い＋クーポン。クーポンは LINE 公式アカウントのクーポン機能で作成し、URL を Flex に埋める（クーポン機能自体は通数を消費しない）。有効期限は誕生月末。

---

## 2-5. 予約リクエスト（LIFF 予約フォーム）

顧客はリッチメニューの「ご予約」から予約フォームを開き、希望日時をリクエストできる。

**承認制**: 顧客が送信した予約は `requested`（承認待ち）で作られ、店舗が承認して初めて
`confirmed` になる。配信ジョブは `confirmed` のみを対象にしているため、未承認の予約に
前々日確認が飛ぶことはない。

| 項目 | 内容 |
|---|---|
| 顧客の特定 | LINE の ID トークンをサーバー側で検証。未登録なら登録フォームへ誘導し、リクエストは受け付けない |
| 日時 | 自由入力。過去・半年より先は拒否 |
| メニュー | 管理画面で登録した `menus` から選択。予約側には名称をコピーして保存する |
| 担当 | 任意。指名なしも可 |
| ご要望 | 任意（500文字まで）。`reservations.note` に保存 |
| 連投防止 | 承認待ちが3件たまっている顧客は追加リクエスト不可 |

**通知**

- 送信時: 顧客へ「まだ確定ではない」旨を応答（通数無料）、スタッフへ要対応通知
- 承認時: 顧客へ確定通知を Push（`dedupe_key` = `reservation_confirmed:res:{id}`、`job_type` = `reservation_confirmed`）
- 見送り時: 顧客へ調整の連絡を Push

**スタッフの操作**: 管理画面の予約一覧で「承認」または「見送り」。承認待ちは対応漏れを防ぐため、
期間指定に関わらず常に一覧の先頭に表示する。

---

## 3. Webhook イベント設計

| イベント | 処理 |
|---|---|
| `follow` | `customers` に line_user_id を upsert。あいさつメッセージ（**通数無料**）で LIFF 登録を案内 |
| `unfollow` | `is_blocked = true` を立てる。以降の全配信対象から外れる |
| `message` | スタッフグループのコマンド（4-2）→ 電話番号らしき文字列なら突合 → それ以外はフォロー回答として分類 |
| `postback` | `action` で分岐（confirm / followup / opt_out） |

署名検証（`x-line-signature`）は必須。検証失敗は 401 で即返す。

**Express の注意**: 署名検証には生のリクエストボディが必要。`express.json()` を webhook ルートより前に適用しないこと。`@line/bot-sdk` の `middleware` を使うのが安全。

---

## 4. スタッフ通知

通知先は Slack Incoming Webhook、またはスタッフ用 LINE グループ（`STAFF_NOTIFY_CHANNEL` で選択。両方も可）。
**LINE グループへの Push は1件につき通数を1消費する**（グループ宛は人数に関わらず1通）点に留意し、
通数を節約したい場合は Slack を使う。

| トリガー | 内容 |
|---|---|
| 新規予約 | 顧客名・日時・メニュー・担当 |
| 予約リクエスト（LIFF） | 顧客名・希望日時・メニュー・ご要望。**要対応**として強調 |
| 予約変更希望（postback） | 顧客名・現予約日時。**要対応**として強調 |
| フォロー回答が concern | 顧客名・回答本文・前回来店日 |
| 突合失敗 | 受信した電話番号・LINE表示名 |
| ジョブ実行結果 | **通知しない**（4-2 参照）。保存しておき、聞かれたときに応答で返す |
| 月間通数の残数警告 | ジョブ実行結果に追記されるため、こちらも聞かれたときに返る |
| ジョブ異常終了 | エラー内容とスタックトレース |

日時は全て `YYYY年M月D日(曜) HH:MM` 形式（JST）に整形する。ISO 文字列のまま出さない。

### 4-1. LINE グループ ID の自動設定

グループ ID は管理画面にも LINE アプリにも表示されないため、**Bot をグループに招待した時点で
`join` イベントから取得し、`app_settings` に保存する**。`.env` を手で編集する運用にしない。

乗っ取り防止のため、挙動は以下に限定する。

- 未設定のとき招待された → そのグループを通知先として設定し、グループへ設定完了を返信する
- 既に設定済みで**別の**グループに招待された → 切り替えず、招待されたグループへ「既に別のグループが設定済み」と返信
- 設定済みのグループから退出させられた（`leave`）→ 設定を削除する

環境変数 `STAFF_LINE_GROUP_ID` は手動上書き用。DB の値が優先される。

### 4-2. ジョブ実行結果は Push せず、聞かれたら返す

グループへの Push は1通ごとに通数を消費する。毎日のサマリは読まない日も多いため、
**日次ジョブの結果は Push せず `app_settings` に保存するだけ**にしている。

スタッフ用グループで **「配信結果」** と発言すると、保存済みの結果を**応答メッセージ**で返す。
応答メッセージは通数を消費しないため、何度聞いても無料。

| 項目 | 内容 |
|---|---|
| 受け付ける言葉 | `配信結果` / `ジョブ結果` / `実行結果`（空白・`?`・`。`などは無視して判定） |
| 受け付ける場所 | **スタッフ通知先に設定済みのグループのみ**。顧客との1対1や別のグループでは反応しない |
| 結果がないとき | 「まだ実行結果がありません」と返す |
| 保存に失敗したとき | 結果が失われないよう、そのときだけ従来どおり Push する |

ジョブの**異常終了**（DB 接続断など）は保存を待たず即時に Push する。気付けないまま
配信が止まるのを防ぐため、ここだけは通数を使ってでも知らせる。

**注意**: 応答メッセージは `SEND_MODE=dry_run` では送信されない（標準出力に出るだけ）。
グループで聞いても返ってこない場合はまず送信モードを確認する。

---

## 5. 環境変数

実際に設定する値と説明は [.env.example](../.env.example) を正とする。ここでは役割ごとの整理のみ。

| 変数 | 必須 | 役割 |
|---|---|---|
| `DATABASE_URL` | ○ | PostgreSQL 接続文字列 |
| `LINE_CHANNEL_ACCESS_TOKEN` | ○ | Messaging API チャネルの長期アクセストークン |
| `LINE_CHANNEL_SECRET` | ○ | Webhook 署名検証用（32文字。LINE Login チャネルの値ではない） |
| `LIFF_ID` | LIFF を使うなら | 登録フォーム・予約フォームの LIFF アプリ ID |
| `LIFF_CHANNEL_ID` | 通常不要 | ID トークン検証用チャネル ID。既定では `LIFF_ID` の先頭部分から導出する |
| `SEND_MODE` | | `dry_run`（既定）/ `test` / `live`。`live` は env ファイルに書かず実行時に渡す |
| `TEST_LINE_USER_ID` | `test` 時 | 宛先の差し替え先 |
| `STAFF_NOTIFY_CHANNEL` | | `slack`（既定）/ `line` / `both` |
| `STAFF_LINE_GROUP_ID` | 通常不要 | Bot をグループに招待すると自動設定される（4-1 参照）。固定したい場合のみ |
| `SLACK_WEBHOOK_URL` | slack を含む場合 | Incoming Webhook |
| `ANTHROPIC_API_KEY` | | フォロー回答の分類（Haiku）に使用。未設定なら分類せず `concern` 扱い |
| `DORMANT_DAILY_LIMIT` | | 休眠フォローの日次上限（既定 50） |
| `BIRTHDAY_COUPON_URL` | | 誕生日クーポンの URL。空なら文面のみ |
| `QUOTA_WARN_RATIO` | | 月間通数の残数警告の閾値（既定 0.1 = 上限の10%）。割合判定のためプラン変更時も設定変更不要 |
| `QUOTA_WARN_REMAINING` | | 通数で固定したい場合のみ。設定するとこちらが優先 |
| `ADMIN_USER` / `ADMIN_PASSWORD` | 管理画面を使うなら | Basic 認証。未設定なら `/admin` は無効 |
| `INGEST_API_TOKEN` | 外部連携するなら | 取り込み API の Bearer トークン。未設定なら API は無効 |
| `TZ` | ○ | `Asia/Tokyo` 固定 |
| `PORT` | | 既定 3000 |

`config.js` で起動時に必須変数（`DATABASE_URL` / `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET`）の
存在を検証し、欠けていたら即座に落とす。`STAFF_NOTIFY_CHANNEL` に応じた依存変数
（slack なら `SLACK_WEBHOOK_URL`）も同時に検証する。

---

## 6. コストの前提

Push / Multicast / Broadcast / Narrowcast は通数カウント対象。一方、応答メッセージ・あいさつメッセージ・1対1のLINEチャットは**カウント対象外で無料**。

したがって設計方針として、**こちらから起点を作る配信だけが課金対象**であり、postback への応答は無料で返せる。顧客数500人規模なら月数百通に収まる想定のため、ライトプラン（月5,000円／5,000通）が目安。

配信前に月間通数の残数を Messaging API の quota エンドポイントで確認し、残数が閾値を下回ったら Slack へ警告を出す。

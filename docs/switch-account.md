# 運用中の LINE 公式アカウントへの接続

テスト用チャネルで動かしていたシステムを、**すでにお客様が友だちになっている運用中のアカウント**に
繋ぐ手順。

新規アカウントと違い、設定を変えた瞬間にお客様の画面が変わる操作がある。
**止めてよいものと止めてはいけないものを切り分けてから触ること。**

---

## まず確認する（ここを飛ばすと既存の運用が壊れる）

### 1. Webhook を他のツールが使っていないか

**Webhook URL は1アカウントに1つしか設定できない。** 予約システムや配信ツールを LINE と連携させて
いる場合、そこに URL が入っている。上書きすると**そちらの連携が黙って止まる**。

LINE Developers → Messaging API 設定 → Webhook URL に既に何か入っていたら、
何のツールか分かるまで進めない。

### 2. 今の設定を控える

戻せるように、変更前にスクリーンショットを撮っておく。

| 場所 | 控えるもの |
|---|---|
| OA Manager → 設定 → 応答設定 | 応答モード／あいさつメッセージ／応答メッセージ の各 ON・OFF |
| OA Manager → ホーム → あいさつメッセージ | 現在の文面 |
| OA Manager → ホーム → 応答メッセージ | 現在の文面・キーワード |
| OA Manager → ホーム → リッチメニュー | 現在のメニュー画像とリンク先 |

### 3. お客様対応にチャットを使っているか

LINE の**チャット（有人対応）を使っている場合、応答モードは「チャット」になっているはず**。
これを「Bot」に変えないと Webhook が飛ばない。ただし Bot モードでもチャットは併用できる
（OA Manager → 設定 → 応答設定 → チャットを「オン」）。切り替え後、スタッフが今までどおり
返信できるかを必ず確認する。

---

## 既存の友だちには、いきなり配信されない

安心材料として先に書いておく。

配信対象は `customers.line_user_id` が入っている人だけ。**既存の友だちは、この値をまだ持っていない。**
LIFF から登録してもらって初めて紐付く。したがって Webhook を繋いだだけでは誰にも配信されない。

逆に言えば、**登録してもらうまで配信は始まらない**。導線（リッチメニュー・あいさつ）を出すのが
実質的な開始タイミングになる。

---

## 手順

### Step 1. 資格情報を取得する

LINE Developers で運用中アカウントのプロバイダーを開く。

| 取得するもの | 場所 | 入る変数 |
|---|---|---|
| チャネルアクセストークン（長期） | Messaging API チャネル → Messaging API 設定 | `LINE_CHANNEL_ACCESS_TOKEN` |
| チャネルシークレット（32文字） | Messaging API チャネル → **チャネル基本設定** | `LINE_CHANNEL_SECRET` |
| LIFF ID | 同じプロバイダーの LINE Login チャネル → LIFF タブ | `LIFF_ID` |

**よくある間違い**: `LINE_CHANNEL_SECRET` に LINE Login チャネルのシークレットを入れると、
Webhook の署名検証が必ず 401 になる。Messaging API チャネル側の値を使う。

LIFF アプリがなければ作る（サイズ **Full**、エンドポイント `https://<ドメイン>/liff/`、
スコープ `profile` を有効化）。

### Step 2. `.env` を書き換える（`dry_run` のまま）

```bash
cd cocotte-vert
cp .env .env.test.bak      # テスト用の値を残す
vi .env
```

```
LINE_CHANNEL_ACCESS_TOKEN=（運用中アカウントの長期トークン）
LINE_CHANNEL_SECRET=（運用中アカウントのチャネルシークレット）
LIFF_ID=（運用中アカウントの LIFF ID）
SEND_MODE=dry_run
```

**3つは必ず同時に差し替える。** トークンだけ替えて `LIFF_ID` が古いままだと、友だち追加した
お客様に**旧アカウントの登録フォームの URL** が送られ、開いても登録できない。

```bash
docker compose --profile standalone up -d
curl -s https://<ドメイン>/health
```

意図したアカウントに繋がったかを確認する。

```bash
docker compose exec app node scripts/check-line.js
```

表示名・ベーシック ID が運用中アカウントのものであること、応答モードが Bot であること、
Webhook の疎通テストが成功することを確認する。ここが通らないうちは先に進まない。

### Step 3. 古い紐付けを消す

LINE の **userId はプロバイダーごとに別の値**になる。テスト用チャネルで取得した値は
運用中アカウントでは通用しない。

```bash
docker compose exec db psql -U postgres -d cocotte_vert
```

```sql
-- 顧客台帳（氏名・電話番号・誕生日）は残る。LIFF 登録時に電話番号で再突合される
UPDATE customers SET line_user_id = NULL, is_blocked = false;

-- 通知先グループも旧チャネル基準。消さないと Bot を招待しても
-- 「既に別のグループが設定済み」と判定され、切り替わらない
DELETE FROM app_settings WHERE key = 'staff_line_group_id';
```

### Step 4. Webhook を繋ぐ

リッチメニューを変えるまで、お客様の画面は変わらない。ただし**この時点から、新しく友だち
追加した人にはシステムのあいさつが返る**（応答メッセージなので通数は消費しない）。

**LINE Developers → Messaging API 設定**

- Webhook URL: `https://<ドメイン>/webhook`
- Webhook の利用: オン
- 「検証」ボタンが成功すること（`scripts/check-line.js` の疎通テストでも同じ確認ができる）

**OA Manager → 設定 → 応答設定**

- 応答モード: **Bot**
- Webhook: **オン**
- チャットを使っているなら、チャットも**オン**のまま

応答メッセージ・あいさつメッセージはこの時点では**触らない**。

### Step 5. 自分で動作を確認する

1. 自分のアカウントで**一度ブロック → 解除**する（`follow` イベントが飛ぶ）
2. `customers` にレコードが増えることを確認
3. LIFF（`https://liff.line.me/<LIFF_ID>`）を開いて自分の情報を登録
4. `line_user_id` が入ることを確認

```sql
SELECT id, name, line_user_id IS NOT NULL AS linked, phone_norm
FROM customers ORDER BY id DESC LIMIT 5;
```

5. スタッフ用グループに Bot を招待し、「配信結果」で応答が返ることを確認

この時点で、**あいさつメッセージが2通届く**はず（LINE 側の既存あいさつ ＋ システムの案内）。
気になる場合は次のどちらかにする。

- OA Manager のあいさつメッセージをオフにし、システム側の文面に一本化する
- システム側の文面をお店の既存あいさつに寄せる（`src/webhook/events/follow.js`）

### Step 6. テスト送信で文面を確認する

```
SEND_MODE=test
TEST_LINE_USER_ID=（運用中アカウントでの自分の userId）
```

**テスト用に別のアカウントを作る必要はない。** 店長やスタッフ本人の LINE でよい。
`SEND_MODE=test` の間は、対象者が誰であっても宛先がこの1つに差し替わる。
条件は**そのアカウントが運用中の公式アカウントを友だち追加していること**。
userId は公式アカウント（プロバイダー）ごとに違う値のため、別アカウントの値は使えない。

userId は LINE アプリの画面には出ない。Step 5 で友だち追加した本人の行を DB から取り出す。

```bash
docker compose exec db psql -U postgres -d cocotte_vert -c \
  "SELECT line_user_id FROM customers ORDER BY id DESC LIMIT 1;"
```

`[follow]` のログには**内部 id しか出ない**（顧客の LINE userId をログに残さない方針のため）。
ログから拾おうとしても見つからないので、上の SQL を使う。

```bash
docker compose --profile standalone up -d
```

店舗管理画面の**「テスト送信」**（`/mock/#test`）で、7種類とも自分に届くことを確認する。
宛先は `TEST_LINE_USER_ID` に固定されるため、**この段階でもお客様には届かない**。

### Step 7. リッチメニュー（お客様の画面が変わる最初の操作）

> **`scripts/setup-richmenu.js` は既定のリッチメニューを差し替える。**
> 既に運用中のメニューがあるなら、そのまま実行すると**今のメニューが消える**。

選択肢は2つ。

**A. 既存のメニューに導線を足す（推奨）**
OA Manager のリッチメニュー編集で、空いている枠のリンク先に LIFF の URL を設定する。

- ご予約: `https://liff.line.me/<LIFF_ID>/reserve.html`
- お客様情報: `https://liff.line.me/<LIFF_ID>`

**B. このシステムのメニューに置き換える**

```bash
docker compose exec app node scripts/setup-richmenu.js --image=/path/to/richmenu.png
```

2分割（左「ご予約」／右「お客様情報」）の画像が必要。既存メニューの内容を失ってよいか、
事前に店舗と確認すること。

### Step 8. 段階的に本番送信へ

**ここから先はお客様に実際に届く。** 一度に全部を有効にしない。

1. **前々日確認だけ先に始める。** 対象は予約が入っていて、かつ LIFF 登録済みの人だけなので
   件数が読める。数日運用して反応を見る
2. 来店7日後フォローを追加する
3. **誕生日は当日分のみ**なので影響が小さい
4. **休眠フォローは最後。必ず対象件数を dry-run で確認する**

```bash
# 対象件数の確認（送信しない）
docker compose exec app node scripts/run-job.js --job=dormant --dry-run
```

リリース直後は「90日以上来ていない人」が全員一斉に対象になる。
想定より多ければ `DORMANT_DAILY_LIMIT` を下げて分散させる。

```bash
# .env には書かず、実行時に渡す
docker compose exec -e SEND_MODE=live app node scripts/run-job.js --job=preReminder
```

常時 `live` にするのは、上記を一通り確認してから。

---

## 戻し方

| 戻すもの | 方法 |
|---|---|
| システム側 | `cp .env.test.bak .env && docker compose --profile standalone up -d` |
| Webhook | LINE Developers で URL を空にする（他ツールを使っていたなら元の URL に戻す） |
| 応答設定 | Step 0 で控えたスクリーンショットのとおりに戻す |
| リッチメニュー | OA Manager で以前のメニューを再度「デフォルト」に設定 |

`customers.line_user_id` は Step 3 で消しているため、テスト側の紐付けは復活しない。

---

## 新規アカウント（友だちがいない）の場合

上の手順から次を省ける。

- 「まず確認する」の3項目（既存の運用がないため）
- Step 7 の選択肢 A（既存メニューがないので B でよい）
- Step 8 の段階導入（対象がいないため、まとめて有効にしてよい）

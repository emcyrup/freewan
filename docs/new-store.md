# 別の店舗へ展開する

**店舗ごとに1セット（サーバー・DB・ドメイン）を立てる**構成で増やす。
1つのシステムに複数店舗を同居させるマルチテナント化は未着手（`roadmap.md` の Phase 7）。

コードは**1本のまま**にして、店舗ごとの違いは `.env` に寄せる。店舗ごとにコードを分岐させると、
不具合を直すたびに店舗数ぶん同じ作業をすることになるため。

---

## 店舗ごとに変わるもの

| | 変え方 | コード編集 |
|---|---|---|
| 店名・ロゴ・サブタイトル | `STORE_NAME` / `STORE_LOGO` / `STORE_TAGLINE` | 不要 |
| 営業時間・定休日 | `STORE_OPEN_TIME` / `STORE_CLOSE_TIME` / `STORE_CLOSED_DAYS` | 不要 |
| 住所・電話 | `STORE_ADDRESS` / `STORE_PHONE` | 不要 |
| 配信の日数（何日前・何日後・休眠） | `PRE_REMINDER_DAYS_BEFORE` / `AFTER_VISIT_DAYS_AFTER` / `DORMANT_DAYS` | 不要 |
| 休眠フォローの日次上限 | `DORMANT_DAILY_LIMIT` | 不要 |
| メニュー・スタッフ | 管理画面から登録 | 不要 |
| リマインドの ON/OFF | 管理画面から（店舗全体・お客様ごと） | 不要 |
| **配色** | `index.html` 先頭の `:root`（ダークモード含め4ブロック） | **必要** |
| **料金表（全29犬種）** | `index.html` の `#s-resv` に直書き | **必要** |
| **メッセージの文面** | `src/line/messages/` | 必要な場合のみ |

文面は**店名を含まない汎用の書き方**にしてあるので、通常はそのまま使える。
友だち追加時のあいさつ（`src/webhook/events/follow.js`）だけ、店舗の言い回しに合わせたいことがある。

---

## 手順

### 1. LINE（店舗ごとに必須・共有できない）

1. **Messaging API チャネル**を作る（公式アカウント1つにつき1チャネル）
2. 同じチャネルに **LIFF アプリ**を作る（登録フォーム・予約フォーム）
3. スタッフ用の LINE グループを作り、Bot を招待する

> **既存の友だちを引き継ぐ場合は、同じプロバイダー内でチャネルを作ること。**
> LINE の `userId` はプロバイダーごとに違う値なので、別プロバイダーだと紐付けが全部切れる。
> 詳しくは [switch-account.md](switch-account.md)。

### 2. サーバー

[deploy.md](deploy.md) のとおりに VM を1台立てる。ドメインも店舗ごとに要る。

```bash
# Docker が未導入なら先に入れる。グループの変更は SSH に入り直すまで効かない
sudo apt install -y docker.io docker-compose-v2 git nano
sudo usermod -aG docker $USER
# ここで一度ログアウト → 再ログインしてから docker ps が通ることを確認する

git clone https://github.com/emcyrup/freewan.git
cd cocotte-vert
cp .env.example .env
nano .env
docker compose --profile standalone up -d --build
```

`.env` で店舗ごとに変える値：

```
DOMAIN / POSTGRES_PASSWORD
LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET / LIFF_ID
SLACK_WEBHOOK_URL / STAFF_NOTIFY_CHANNEL
ADMIN_USER / ADMIN_PASSWORD / INGEST_API_TOKEN
STORE_*（店舗プロフィール）
IG_* / THREADS_*（店舗のアカウントごと。使わないなら空のまま）
BIRTHDAY_COUPON_URL
```

`ANTHROPIC_API_KEY` は店舗間で共有してよい。
**`SEND_MODE` は `dry_run` のまま**にしておく（`.env` に `live` と書かない）。

### つまずきやすい点

実際に2店舗目を立ち上げたときに引っかかった順に並べてある。

| 症状 | 原因と対処 |
|---|---|
| 起動して `Invalid URL` だけが繰り返し出る | **`POSTGRES_PASSWORD` に記号が入っている。** この値は接続 URL に埋め込まれるため `/` や `@` があると壊れる。`openssl rand -base64` は使わず **`openssl rand -hex 24`** で作り直す。DB は初回起動時のパスワードを保存するので、`.env` を直すだけでは直らない。**データが無いうちに** `docker compose --profile standalone down -v` でボリュームごと消してから起動し直す |
| 起動直後に落ち、`SLACK_WEBHOOK_URL が必要です` と出る | `.env.example` の `STAFF_NOTIFY_CHANNEL` は `slack`。Slack を使わないなら **`line` に変える** |
| `.env` が見当たらない | `.` で始まるので `ls` では見えない。`ls -a` で確認する |
| `docker ps` が `permission denied` | `usermod -aG docker` のあと**再ログインしていない**。SSH の窓を閉じて入り直す |
| `nano: command not found` | GCP の Ubuntu イメージには入っていない。`sudo apt install -y nano` |
| 手元では動くのに Webhook が届かない | **Cloud Shell で作業している。** Cloud Shell は VM とは別のマシン。プロンプトが `@cloudshell` なら間違い |

### 3. 画面の見た目

`.env` だけでは変わらない部分を編集する。詳しくは [../src/mock/README.md](../src/mock/README.md)。

- **配色** — `index.html` 先頭の `:root` にある CSS 変数。ダークモードを含めて**4ブロックとも**書き換える
- **料金表** — 犬種ごとの料金は店舗の公式情報を正とする。**掲載がない犬種を推測で埋めない**
- **デモ用サンプルデータ** — `FAMILIES` / `RESV` / `MENUS` / `WEEK` / `MONTH` / `TRIALS` の6配列。
  実運用モードでは使われないが、提案・説明で見せるなら店舗に合わせる。
  **実在の顧客名や電話番号を書き込まないこと**

### 4. リッチメニュー

2500×843px の画像を用意して登録する。

```bash
docker compose exec app node scripts/setup-richmenu.js --image=/app/menu.png
```

> **既存のリッチメニューがあると差し替わる。** 運用中のアカウントに繋ぐ場合は事前に確認する。

### 5. 初期データ

```bash
# メニュー・定額コース。店舗ごとの内容は scripts/store-data/ の JSON を渡す
# （コードの書き換えは不要。引数なしならここっとベールの既定値が入る）
docker compose exec app node scripts/seed-menus.js --file=scripts/store-data/freewan.menus.json
docker compose exec app node scripts/seed-plans.js --file=scripts/store-data/freewan.plans.json
```

新しい店舗の JSON は `scripts/store-data/README.md` の形式で追加する。

- スタッフを管理画面から登録し、LINE と連携する（[shift-requests.md](shift-requests.md)）
- **既存顧客台帳（氏名・電話番号）を投入する。** LIFF 登録時の突合率に直結するので、
  ここが立ち上がりの成否を一番左右する

### 6. 立ち上げ

1. `SEND_MODE=dry_run` のまま数日動かし、毎朝のジョブ実行サマリを確認する
2. `SEND_MODE=test` と `TEST_LINE_USER_ID` を設定し、
   管理画面の「テスト送信」（`/mock/#test`）で**7種類とも**文面を確認する
3. **休眠フォローの初回対象件数を dry-run で必ず確認する**
   （長く来ていないお客様が一斉に対象になり、通数を使い切ることがある）
4. `SEND_MODE=live` へ切り替える（`.env` に書かず実行時に渡す）
5. DB の日次バックアップを設定する

---

## 業種が変わるとき

ペットサロン以外へ広げるなら、上記に加えて次が要る。**設定では吸収できない。**

- `pets` テーブル（`breed` など犬前提）と、画面の「わんちゃん」「飼い主様」という語。
  画面ごとに洗い出してから着手する。1箇所でも残ると借り物に見える
- 料金表・コース構成の作り替え
- 配信条件の考え方そのもの（「来店7日後にフォロー」が適切かどうか）

---

## 増やしたあとの保守

- コードは1本。修正は `main` に入れ、各店舗のサーバーで `git pull` → `docker compose up -d --build`
- **店舗ごとにコードを分岐させない。** 分岐が必要になったら、まず設定で吸収できないかを考える
- 店舗が10を超えるなら、マルチテナント化（Phase 7）を検討する時期

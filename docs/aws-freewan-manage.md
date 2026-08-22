# 本番環境（AWS・ai-labo.cloud）への移行

`freewan-manage.ai-labo.cloud` / ポート **8016** で本番稼働させるための手順。

> **接続情報はこのファイルに書かない。** サーバーの IP・SSH ユーザー名・秘密鍵ファイル名・
> データベースのパスワードは、先方から配布された「【本番環境のご案内】」に記載がある。
> このリポジトリは公開設定のため、値は転記せず、必要なときにその資料を見ること。

---

## この環境は、これまでの構成と前提が違う

先方（インフラ提供元）が管理する**共用サーバーの中の、隔離された1区画**を借りる形になる。
そのため `docs/deploy.md` の構成 A/B（Docker Compose ＋ 自前 Nginx）は**そのままでは使えない**。

| | これまで（現行サーバー） | 本番環境（ai-labo.cloud） |
|---|---|---|
| 実行 | Docker Compose | **Docker 不可**（sudo が無い）。Node を直接動かす |
| Web サーバー | 自前の Nginx / Caddy | **先方が一括管理**。こちらは触れない |
| SSL 証明書 | certbot | **先方が管理** |
| ポート | 80/443 | **80/443 は使用不可。** 8016 を `0.0.0.0` で待ち受ける |
| DB | 同梱の PostgreSQL コンテナ | **共用の PostgreSQL 18.4**。DB名は先方が発行 |
| バックアップ | 自前 cron で `pg_dump` | **先方が自動取得**（7日分のスナップショット）。**自前で組まない** |
| 権限 | root 相当 | sudo 無し。作業はホームディレクトリ内で完結 |

固定されている環境: Ubuntu 26.04 LTS / Node.js v22.22.1 / PostgreSQL 18.4 / nginx 1.28.3。
このアプリの必要条件は Node 20 以上で、依存も4つ（`@line/bot-sdk` / `express` / `node-cron` / `pg`）
すべて純 JS のため、ビルドツールなしで `npm ci` が通る。**環境側の変更は要らない。**

---

## 先に先方へ依頼・確認すること

サーバーに入る前に、この4点を片付けておく。こちらでは対処できない。

1. **サブドメインの割り当てとプロキシ設定**
   `https://freewan-manage.ai-labo.cloud` へのアクセスを `127.0.0.1:8016` へ流す設定。
   あわせて**アップロードの上限を 20MB 以上**にしてもらう（既定の 1MB では来店お礼・SNS の
   写真が送れない。アプリ側は1枚 8MB まで受け付ける）。
2. **データベース名の発行**（開発環境を踏襲した名前）。ユーザー・パスワードは共用のものを使う。
3. **常駐化の方法**。`pm2 startup`（再起動後の自動復帰）には sudo が要るため、
   先方に登録してもらうか、systemd のユーザーユニットを有効にしてもらう。
   どちらも難しければ `nohup` で起動し、**サーバー再起動時は手動で起動し直す**運用になる。
4. **外向き通信の許可**。LINE Messaging API・Anthropic API・Instagram / Threads へ
   HTTPS で出ていく。塞がれていると配信も投稿も動かない。

### GitHub について

**`emcyrup/freewan` を引き続き使う**（決定済み）。先方の「弊社管理リポジトリで一元管理」に
合わせる必要が出た場合は、そのときに移送を検討する。
サーバーの `~/.ssh` に鍵を作り、GitHub に登録して clone する（下の手順1）。

---

## 手順

### 1. サーバーへ入り、コードを置く

```bash
ssh -i <配布された .pem> <SSHユーザー名>@<サーバーIP>

# このリポジトリは公開設定なので、HTTPS なら鍵の登録なしに clone できる。
# サーバー側で必要なのは pull だけなので、これで足りる
git clone https://github.com/emcyrup/freewan.git
cd freewan
```

> `git@github.com:` （SSH）で clone すると `Permission denied (publickey)` になる。
> サーバーの鍵を GitHub に登録していないため。**サーバーから push する予定が無ければ
> 登録は不要**で、上の HTTPS のままでよい。
>
> サーバーから push もしたい場合だけ、鍵を作って GitHub に登録する:
>
> ```bash
> ssh-keygen -t ed25519 -C "freewan-prod" -f ~/.ssh/id_ed25519
> cat ~/.ssh/id_ed25519.pub        # これを GitHub の SSH keys に貼る
> git config --global user.name "..."
> git config --global user.email "..."
> git remote set-url origin git@github.com:emcyrup/freewan.git
> ```

### 2. `.env` を作る

```bash
cp .env.example .env
nano .env
```

現行サーバーの `.env` から**そのまま写すもの**（同じ LINE チャネルを使うため）:
`LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LIFF_ID` /
`ADMIN_USER` / `ADMIN_PASSWORD` / `ANTHROPIC_API_KEY` / `STORE_*` 一式 /
`IG_*` / `THREADS_*` / `INGEST_API_TOKEN` / `STAFF_NOTIFY_CHANNEL`

必要な行だけを取り出すには、**現行サーバー**（ディレクトリは旧名 `cocotte-vert`）で:

```bash
cd ~/cocotte-vert 2>/dev/null || cd ~/freewan
grep -E '^(LINE_CHANNEL_|LIFF_|ADMIN_|ANTHROPIC_API_KEY|TEST_LINE_USER_ID|SLACK_WEBHOOK_URL|STAFF_NOTIFY_CHANNEL|BIRTHDAY_COUPON_URL|INGEST_API_TOKEN|IG_|THREADS_|STORE_)' .env
```

**この環境用に変えるもの:**

```
# 先方から割り当てられたポート。0.0.0.0 で待ち受ける（Node の既定で全インタフェース）
PORT=8016

# 共用 PostgreSQL。ユーザー・パスワードは先方資料、DB名は発行されたもの
DATABASE_URL=postgres://<ユーザー>:<パスワード>@localhost:5432/<発行されたDB名>

# 写真の公開 URL。ポートは付けない（外からは 443 で入ってくるため）
PUBLIC_BASE_URL=https://freewan-manage.ai-labo.cloud

# 誤爆防止。live は .env に書かず、実行時に渡す
SEND_MODE=dry_run
TZ=Asia/Tokyo
```

`DOMAIN` と `HOST_PORT` は**空のままでよい**（Caddy も Docker も使わないため）。

> パスワードに `@` `/` などの記号が入る場合、`DATABASE_URL` の中では
> **パーセントエンコード**が必要（`@` は `%40`、`!` はそのままで可、`#` は `%23`、`$` は `%24`）。
> 配布されたパスワードは記号を含むため、ここでつまずきやすい。

### 3. セットアップ（依存・マイグレーション・起動確認）

```bash
sh scripts/server-setup.sh
```

`.env` の不足・`DATABASE_URL` の書き方の誤りを先に指摘したうえで、依存の導入 →
マイグレーション → 起動確認までを行い、最後に次にやることを表示する。

> 手で行う場合は `npm ci --omit=dev` → `npm run migrate` → `npm start`。
> `.env` はアプリ自身が読む（`src/env.js`）ので `node src/index.js` と直に叩いても構わない。
> ただし `SEND_MODE=live` は `.env` に書かず、実行時に前置きして渡すこと。

### 4. 常駐させる

PM2 が使える場合:

```bash
# sudo が無いので、グローバル導入先をホーム配下に移してから入れる。
# PATH を通さないと、入れた直後に「pm2: command not found」になる
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g pm2

# npm start を起動する形にする（.env を読ませるため。src/index.js を直接指定しない）
cd ~/freewan
pm2 start npm --name freewan --time -- start
pm2 save
pm2 logs freewan
```

`pm2 save` のあと、**再起動後の自動復帰は `pm2 startup` の登録（sudo 必要）が要る**ため、
先方に依頼する。依頼できない場合は `nohup` で起動し、再起動時は手で立て直す。

```bash
cd ~/freewan && nohup npm start > ~/freewan/app.log 2>&1 &
```

### 5. 先方のプロキシ経由で開けることを確認

```
https://freewan-manage.ai-labo.cloud/health
https://freewan-manage.ai-labo.cloud/mock/     ← 管理画面（Basic 認証）
```

**この時点では LINE はまだ切り替えない。**
`seed-*.js` も実行しない（このあとデータごと移すため。実行すると重複する）。

### 6. 既存データを移す

同じ LINE チャネルを使うため、**友だち（LINE userId）も同じ**。DB が空のままだと
いまのお客様を特定できず、予約フォームもリマインドも動かない。必ず移す。

**現行サーバー（Docker 構成）で:**

> 現行サーバーのディレクトリは**旧名の `cocotte-vert` のまま**。Docker のボリューム名が
> ディレクトリ名から決まるため rename していない（rename すると空の DB で起動してしまう）。

```bash
cd ~/cocotte-vert 2>/dev/null || cd ~/freewan
docker compose exec -T db pg_dump -U postgres --no-owner --no-acl cocotte_vert > freewan.sql
docker compose cp app:/app/data ./appdata && tar czf appdata.tgz appdata
```

`freewan.sql` と `appdata.tgz` を新サーバーへ送る（`scp -i <.pem>`）。

**新サーバーで:**

```bash
cd ~/freewan
# psql は .env を自動では読まないので、シェルへ読み込ませてから使う
set -a && . ./.env && set +a

psql "$DATABASE_URL" < freewan.sql      # 3 で作った空のテーブルへ流し込む
tar xzf appdata.tgz && cp -r appdata/. ~/freewan/data/
```

`--no-owner --no-acl` を付けるのは、共用 DB では所有者名が現行サーバーと違うため。

件数を突き合わせる（**両方のサーバーで実行して一致を確認**）:

```bash
psql "$DATABASE_URL" -c "SELECT (SELECT count(*) FROM customers) AS 顧客,
  (SELECT count(*) FROM pets) AS わんちゃん, (SELECT count(*) FROM reservations) AS 予約,
  (SELECT count(*) FROM staff) AS スタッフ, (SELECT count(*) FROM message_logs) AS 配信ログ"
```

**`message_logs` を必ず一緒に移すこと。** 二重送信を防いでいるのはこのテーブルの
`dedupe_key` なので、空のまま切り替えると**送信済みのリマインドがもう一度飛ぶ**。

### 7. 切り替え（この順序を守る）

Webhook URL は1つしか登録できないため、**2台の並行運用はできない**。
移行中に両方が動いていると、両方の毎朝10:00のジョブが同じお客様へ送り、
**同じメッセージが2通届く**。必ず「止めてから向ける」。

```bash
# ① 現行サーバー: 止める（ディレクトリは旧名 cocotte-vert のまま）
cd ~/cocotte-vert 2>/dev/null || cd ~/freewan
docker compose stop app

# ② 止めたあとに増えたぶんが無いか、最終ダンプを取り直して入れ直す
#    （①〜②が短時間なら省略可）

# ③ LINE Developers で差し替える（ポートは付けない）
#    Webhook URL     https://freewan-manage.ai-labo.cloud/webhook
#    LIFF エンドポイント https://freewan-manage.ai-labo.cloud/liff/
#    → 「検証」ボタンで 200 が返ることを確認

# ④ 新サーバーで疎通確認
curl https://freewan-manage.ai-labo.cloud/health
```

**現行サーバーは消さずに止めたまま残す。** 問題があれば ③ を戻すだけで復旧できる。
先方の案内どおり、現行サーバーはこのあと `st-` 付きのサブドメインで
ステージング環境として使う想定。

### 8. 更新と自動デプロイ

更新はこれ1本でよい。Docker が使えるかを見て自動で振り分けるので、
現行サーバーでも新サーバーでも同じコマンドで済む。

```bash
cd ~/freewan && sh scripts/server-update.sh
```

CI もこのスクリプトを呼ぶようにしてあるため、**main への push で新サーバーにも配れる**。
有効にするには:

1. 既存の deploy_key の**公開鍵**を、新サーバーの `~/.ssh/authorized_keys` に追記する
2. Secret `DEPLOY_TARGETS` の**現行サーバーの行を、新サーバーの行に置き換える**
   （残したままだと、止めてあるサーバーへの配布が毎回失敗として報告される）

自動デプロイに載せない場合は、上のコマンドを手で実行する。

---

## 運用メモ

- ログ: `pm2 logs freewan`（nohup なら `tail -f ~/freewan/app.log`）
- **バックアップは先方が自動取得する。** 自前で cron を組まないこと（多重実行の負荷とディスク圧迫を避けるため）
- 過去のダンプが必要になったら先方担当へ依頼する
- 送信モードを上げるときも `.env` は書き換えず、実行時に渡す
  `SEND_MODE=test node scripts/run-job.js --job=preReminder`
- CPU はバースト方式（t3.small）。長時間の高負荷をかける検証は事前に先方へ連絡する

## つまずきやすいところ

| 症状 | 原因 |
|---|---|
| 起動時に `Invalid URL` | `DATABASE_URL` のパスワードの記号が未エンコード。`@` → `%40` など |
| `password authentication failed for user "user"` | `DATABASE_URL` が `.env.example` の雛形のまま。実際の DB ユーザー・パスワード・DB 名に書き換える |
| 起動時に「環境変数が未設定です」 | `.env` がリポジトリ直下に無い。`cp .env.example .env` から作る |
| `node: bad option: --env-file-...` | 古い node が PATH の先にいる。`command -v -a node` で確認する（v20 以上が必要） |
| `[boot]` は出るが外から開けない | 先方のプロキシ設定がまだ。8016 への転送を依頼する |
| Webhook の検証が通らない | URL にポートが付いている／`LINE_CHANNEL_SECRET` が別チャネルの値 |
| 切り替え直後にリマインドが再送された | `message_logs` を移していない。`dedupe_key` が二重送信を防いでいる |
| 来店お礼の写真が届かない | `PUBLIC_BASE_URL` 未設定。未設定だと対象を数えず何も送らない |
| 写真のアップロードが 413 で失敗 | 先方のプロキシの上限が既定（1MB）のまま。20MB 以上への引き上げを依頼する |
| サーバー再起動後に落ちたまま | `pm2 startup` が未登録。先方に依頼するか、手で起動し直す |
| `pm2: command not found` | `~/.npm-global/bin` が PATH に入っていない。上の export を実行する |
| clone で `Permission denied (publickey)` | SSH で clone している。公開リポジトリなので `https://github.com/...` を使う |
| `cp: cannot stat '.env.example'` | clone に失敗していて `freewan` ディレクトリが無い。clone からやり直す |
| 現行サーバーで `cd ~/freewan` が `No such file or directory` | 現行はディレクトリ名が旧名 `cocotte-vert` のまま。`cd ~/cocotte-vert` を使う |

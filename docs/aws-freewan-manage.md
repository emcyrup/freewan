# AWS 上に freewan-manage を立てる

`freewan-manage.ai-labo.cloud` / ホスト側ポート **8016** で、いまの北区店と同じものを
AWS 上に用意するための手順。**サーバーの中の作業は、この環境からは行えない**ため、
EC2 に SSH できる人がこのとおりに実行する。

構成そのものは [deploy.md](deploy.md) の「構成 A: 既存 EC2（Nginx 稼働中）」と同じで、
違うのは**ホスト側のポートを 3000 ではなく 8016 にする**点だけ。

---

## 決まっていること

- **8016 は既存 Nginx の内側のポート。** Nginx が 443 で `freewan-manage.ai-labo.cloud` を
  受け、`127.0.0.1:8016` へ流す。ブラウザからはポート無しの URL で開く
- **LINE チャネルは北区店と同じものを使う**

## そのため、これは「新設」ではなく「引っ越し」になる

LINE チャネルが同じなら、**Webhook URL は1つしか登録できない**。新しいサーバーに向けた
時点で、いまの北区店のサーバーには届かなくなる。**2台の並行運用はできない。**

さらに、同じチャネルということは**友だち（LINE userId）も同じ**。新しいサーバーの DB が
空のままだと、いまのお客様が「知らない人」として扱われる（予約フォームの本人特定が
できず、リマインドの対象にもならない）。**既存データを移すのが前提**になる。

### 二重配信に注意

移行の途中で**2台とも動いている時間帯**があると、両方の毎朝10:00のジョブが同じ
お客様に同じ内容を送り、**飼い主様に同じメッセージが2通届く**。これは取り返しがつかない。
下の「切り替え手順」の順序を必ず守ること。

---

## 手順

### 1. EC2 とネットワーク

- EC2 を1台用意する（Ubuntu 22.04 以降・t3.small 以上を推奨。DB を同居させるため t3.micro は避ける）
- セキュリティグループの受信許可は **80 / 443 / 22 のみ**。
  **8016 は開けない**（ループバックにのみ束縛するため、開けても届かず、開けると事故のもとになる）
- Route 53（または ai-labo.cloud を管理している DNS）に
  `freewan-manage.ai-labo.cloud` の **A レコード**を追加し、EC2 の Elastic IP へ向ける

### 2. Docker とコードを入れる

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && exec su -l $USER   # 一度入り直す

git clone https://github.com/emcyrup/freewan.git
cd freewan
cp .env.example .env
nano .env
```

### 3. `.env`

最低限これだけ埋めれば起動する。

```
# ホスト側のポート。これが今回の肝
HOST_PORT=8016

# DB のパスワード。記号を入れないこと（接続 URL に埋め込まれるため）
POSTGRES_PASSWORD=（openssl rand -hex 24 の出力）

# LINE・管理画面・店舗プロフィール・Claude API は、
# 現行サーバーの .env から「そのまま」写す（同じチャネルを使うため）
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LIFF_ID=...
ADMIN_USER=...
ADMIN_PASSWORD=...
ANTHROPIC_API_KEY=...
STORE_NAME=... など STORE_* 一式

# 写真の公開 URL。ポート無しのドメインを書く（8016 は外から見えないため）
PUBLIC_BASE_URL=https://freewan-manage.ai-labo.cloud

# スタッフ通知。Slack を使わないなら line、グループ招待までは何も届かない
STAFF_NOTIFY_CHANNEL=line

# 誤爆防止。live は .env に書かず、実行時に渡す
SEND_MODE=dry_run
TZ=Asia/Tokyo
```

`DATABASE_URL` は compose が内部 DB を指すよう自動設定するので**空のまま**にする。
`DOMAIN` も空でよい（Caddy を使わないため）。

`STORE_*`（店名・営業時間・定休日など）は未設定だと1号店の値が出るため、写し忘れないこと。
`POSTGRES_PASSWORD` だけは新しく作ってよい（DB ごと入れ替えるため）。

### 4. 起動

```bash
docker compose up -d --build
docker compose logs -f app     # [migrate] 完了 → [boot] port=3000 SEND_MODE=dry_run
curl http://127.0.0.1:8016/health
# {"ok":true,"sendMode":"dry_run","version":"..."}
```

`[boot] port=3000` はコンテナの中のポートなので正しい。外から見えるのは 8016 の方。

### 5. Nginx

`/etc/nginx/sites-available/freewan-manage.ai-labo.cloud`:

```nginx
server {
    listen 80;
    server_name freewan-manage.ai-labo.cloud;

    # 来店お礼・SNS の写真がそのまま流れるので、既定の 1MB では足りない
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8016;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/freewan-manage.ai-labo.cloud /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d freewan-manage.ai-labo.cloud
curl https://freewan-manage.ai-labo.cloud/health
```

### 6. 動作だけ先に確かめる（LINE はまだ切り替えない）

この時点では Webhook は**まだ現行サーバーに向いたまま**にしておく。
管理画面が開くこと、`/health` が返ることだけ確認する。

```
https://freewan-manage.ai-labo.cloud/mock/
```

メニューやスタッフはこのあとデータごと移すので、`seed-*.js` は**実行しない**
（実行すると移行後に重複する）。

### 7. 既存データを移す

**現行サーバーで:**

```bash
cd ~/freewan
docker compose exec -T db pg_dump -U postgres --clean --if-exists cocotte_vert > freewan.sql
# 写真（来店お礼・SNS）も持っていく
docker compose cp app:/app/data ./appdata
tar czf appdata.tgz appdata
```

`freewan.sql` と `appdata.tgz` を新サーバーへ送る（`scp` など）。

**新サーバーで:**

```bash
cd ~/freewan
docker compose exec -T db psql -U postgres -d cocotte_vert < freewan.sql
tar xzf appdata.tgz
docker compose cp ./appdata/. app:/app/data
docker compose restart app       # マイグレーションが必要なら起動時に適用される
```

移せたことを確認する。

```bash
docker compose exec -T db psql -U postgres -d cocotte_vert -c \
  "SELECT (SELECT count(*) FROM customers) AS 顧客, (SELECT count(*) FROM pets) AS わんちゃん,
          (SELECT count(*) FROM reservations) AS 予約, (SELECT count(*) FROM staff) AS スタッフ"
```

現行サーバーで同じ SQL を流し、**数が一致すること**を確かめる。

### 8. 切り替え（この順序を守る）

二重配信を避けるため、**必ず「止めてから向ける」**。

```bash
# ① 現行サーバー: 止める（ここから予約フォーム等は一時的に受け付けられない）
cd ~/freewan && docker compose stop app

# ② 現行サーバー: 止めたあとに増えたぶんが無いか、念のため最終ダンプを取り直して
#    新サーバーへ入れ直す（①〜②が短時間なら省略可）

# ③ LINE Developers で Webhook URL を差し替える
#    https://freewan-manage.ai-labo.cloud/webhook
#    LIFF のエンドポイントも同様に差し替える
#    → 「検証」ボタンで 200 が返ることを確認

# ④ 新サーバー: 動いていることを確認
curl https://freewan-manage.ai-labo.cloud/health
```

**現行サーバーは消さずに止めたまま残す。** 問題があれば ③ を戻すだけで復旧できる。
数日〜1週間ほど様子を見てから片付ける。

> 現行サーバーの `.env` の中身（LINE トークン・`ADMIN_*`・`STORE_*`・`ANTHROPIC_API_KEY`）は
> **そのまま新サーバーへ写す**。`HOST_PORT=8016` と `PUBLIC_BASE_URL` だけ新しい値にする。

### 9. 自動デプロイの向き先を変える

既存の CI は Secret `DEPLOY_TARGETS`（`user@host` の改行区切り）に書いた全台へ配る。

1. 既存の deploy_key の**公開鍵**を、この EC2 の `~/.ssh/authorized_keys` に追記する
2. `DEPLOY_TARGETS` の**現行サーバーの行を、この EC2 の行に置き換える**
   （残したままだと、止めてあるサーバーへの配布が毎回失敗として報告される）
3. main に何かをマージし、Actions のログで届いていることを確認する

配置先はホーム直下の `freewan` を見るので、上の手順どおりなら追加の設定は要らない。

```bash
# 手動で更新する場合
cd ~/freewan && git pull && docker compose up -d --build
```

---

## 運用メモ

- 更新: `cd ~/freewan && git pull && docker compose up -d --build`（マイグレーションも自動適用）
- ログ: `docker compose logs -f app`
- バックアップ: `docker compose exec db pg_dump -U postgres cocotte_vert > backup.sql`（日次 cron 推奨）
- 送信モードを上げるときも `.env` は書き換えず、実行時に渡す
  `docker compose run --rm -e SEND_MODE=test app node scripts/run-job.js --job=preReminder`

## つまずきやすいところ

| 症状 | 原因 |
|---|---|
| コンテナが再起動を繰り返し `Invalid URL` だけ出る | `POSTGRES_PASSWORD` に `/` `@` `+` などの記号が入っている。`openssl rand -hex 24` で作り直す |
| 8016 に curl は通るがブラウザで開けない | ループバック束縛は正常。Nginx の vhost と証明書を確認する |
| Webhook の検証が通らない | URL にポートが付いている／証明書が未取得／`LINE_CHANNEL_SECRET` が別チャネルの値 |
| 来店お礼の写真が届かない | `PUBLIC_BASE_URL` 未設定。未設定だと対象を数えず何も送らない |
| スタッフ通知が届かない | `STAFF_NOTIFY_CHANNEL=line` のとき、Bot をスタッフ用グループに招待するまで届き先が無い |

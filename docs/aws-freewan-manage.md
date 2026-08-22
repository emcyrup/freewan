# AWS 上に freewan-manage を立てる

`freewan-manage.ai-labo.cloud` / ホスト側ポート **8016** で、いまの北区店と同じものを
AWS 上に用意するための手順。**サーバーの中の作業は、この環境からは行えない**ため、
EC2 に SSH できる人がこのとおりに実行する。

構成そのものは [deploy.md](deploy.md) の「構成 A: 既存 EC2（Nginx 稼働中）」と同じで、
違うのは**ホスト側のポートを 3000 ではなく 8016 にする**点だけ。

---

## 先に決めること（2つ）

### 1. 8016 は「内側のポート」か「外から見えるポート」か

| | 想定 | LINE 連携 |
|---|---|---|
| **A. 内側**（推奨） | 既存の Nginx が 443 で `freewan-manage.ai-labo.cloud` を受け、`127.0.0.1:8016` へ流す | そのまま使える |
| **B. 外から** | `https://freewan-manage.ai-labo.cloud:8016` を直接開く | **Webhook が登録できない見込み**（下記） |

**LINE の Webhook URL は HTTPS（443）が前提。**B のようにポートを付けた URL は
登録・検証が通らない可能性が高い（B で進める場合は、先に LINE Developers の
「検証」ボタンで 200 が返るか確かめること）。届かなければ、予約フォーム・友だち追加・
スタッフのシフト申請など**公式LINE からの入力がすべて入らない**。
管理画面を見るだけなら B でも動くが、このシステムは LINE 連携の上に成り立っているため
**A を強く勧める**。

この手順書は A（既存 Nginx が 443 を受け、8016 へプロキシ）を前提に書いてある。

### 2. LINE チャネルを分けるか

- **分ける**（別チャネルを新規作成）→ 検証環境として安全。友だち・LINE userId は引き継がれない
- **同じにする**（北区店と同じチャネル）→ **Webhook URL は1つしか登録できない**ため、
  切り替えた時点で**北区店側に届かなくなる**。並行運用はできない

検証用に立てるなら**必ず分ける**こと。

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

# LINE（検証用に新しく作ったチャネルの値）
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LIFF_ID=...

# 管理画面の Basic 認証
ADMIN_USER=...
ADMIN_PASSWORD=...

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

`STORE_*`（店名・営業時間・定休日など）は未設定だと1号店の値が出る。
北区店と同じ表示にしたい場合は、北区店の `.env` から `STORE_*` をそのまま写す。

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

### 6. LINE 側の URL

作成した検証用チャネルに登録する。**いずれもポート番号は付けない。**

| 設定先 | URL |
|---|---|
| Webhook URL | `https://freewan-manage.ai-labo.cloud/webhook` |
| LIFF（顧客情報登録） | `https://freewan-manage.ai-labo.cloud/liff/` |
| 管理画面 | `https://freewan-manage.ai-labo.cloud/mock/` |

Webhook を登録したら LINE Developers の「検証」で 200 が返ることを確認する。

### 7. 初期データ

```bash
# メニューとスクール会員コース（北区店と同じ内容）
docker compose exec app node scripts/seed-menus.js --file=scripts/store-data/freewan.menus.json
docker compose exec app node scripts/seed-plans.js --file=scripts/store-data/freewan.plans.json

# 画面を触るためのデモ顧客・予約（任意。--remove で消せる）
docker compose exec app node scripts/seed-customers.js
docker compose exec app node scripts/seed-reservations.js
```

スタッフは管理画面から登録する。デモ投入は予約サービスを通さない直接 INSERT で、
LINE 連携済みの顧客にはぶら下げないため、配信は発生しない。

### 8. 自動デプロイに載せる（任意）

既存の CI は `DEPLOY_TARGETS`（`user@host` の改行区切り）に書いた全台へ配る。
このサーバーも main への push で自動更新したいなら:

1. 既存の deploy_key の**公開鍵**を、この EC2 の `~/.ssh/authorized_keys` に追記する
2. リポジトリの Secret `DEPLOY_TARGETS` に、この EC2 の `user@freewan-manage.ai-labo.cloud` を1行足す

配置先はホーム直下の `freewan` を見るので、上の手順どおりなら追加の設定は要らない。

> **注意**: 自動デプロイに載せると、**北区店の本番と同時に更新される**。
> 検証用として本番と切り離しておきたいなら、載せずに手動更新にする。

```bash
# 手動更新
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

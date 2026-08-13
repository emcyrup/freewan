# Instagram 投稿の設定

店舗管理画面（`/mock/` の「SNS投稿」）から、店舗の Instagram アカウントへ写真を投稿できる。
11枚以上は自動で2投稿に分割し、予約投稿にも対応する。

LINE の配信と同じく **`IG_POST_MODE=dry_run` が既定**で、`live` にするまで実投稿されない。

---

## 仕組み（先に知っておくこと）

- Instagram の API は「画像の公開 URL を渡し、Instagram 側に取りに来させる」方式。
  そのためアップロードした写真は `/sns-media/<ランダム名>.jpg` で一時的に公開される
  （URL が推測不能であることが実質のアクセス制御。管理画面の認証はかかっていない）
- 写真は管理画面のブラウザ側で JPEG に変換し、Instagram が受け付ける縦横比
  （4:5 〜 1.91:1）から外れるものは白地でパディングしてから送られる
- API 経由の投稿には**1日あたりの回数上限**がある（Meta の仕様。数十件程度）。
  店舗の日常運用では気にならない範囲
- リール（動画）は未対応。写真（単発・カルーセル）のみ
- 同じ画面から**スレッズ**にも投稿できる（別トークン・別設定）。[docs/threads.md](threads.md) を参照

---

## Meta 側のセットアップ（初回のみ・手作業）

### 1. Instagram をプロアカウントにする

Instagram アプリ → 設定 → アカウントの種類とツール → プロアカウントに切り替える
（ビジネス・クリエイターどちらでも可）。すでにプロアカウントなら不要。

### 2. Meta 開発者アプリを作る

1. https://developers.facebook.com/ にログイン（店舗の管理者の Facebook アカウント）
2. マイアプリ → アプリを作成 → ユースケースは **「Instagram」** を選択
3. アプリ作成後、左メニューの **Instagram → API setup with Instagram login** を開く

### 3. アカウントを接続してトークンを取得する

1. 「Add account」で店舗の Instagram アカウントを接続する
2. 接続したアカウントの行に **「Generate token」** ボタンが出るので押す
3. Instagram 側でログイン・許可すると**アクセストークン**（長期・60日有効）が表示される
4. 同じ画面に **Instagram user ID**（数字）も表示される

この2つを控える。**トークンは Bitwarden に保管し、チャットや Notion に貼らない。**

> アプリは「開発モード」のままでよい。自分のアカウント（テスターとして接続済み）への
> 投稿は審査（App Review）なしで動く。他店へ横展開する場合のみ審査が必要になる。

### 4. `.env` に設定する

```bash
cd cocotte-vert
vi .env
```

```
IG_ACCESS_TOKEN=（Generate token で取得したトークン。IGAA〜 で始まる長い1行）
IG_POST_MODE=dry_run
```

`IG_USER_ID` は**空でよい**（トークンからアカウントが特定される）。
指定する場合は「API setup with Instagram login」画面の Instagram user ID を使うこと。
Facebook 側の画面に出る ID は別物で、`object does not exist` エラーになる。

```bash
docker compose --profile standalone up -d
```

### 5. 接続を確認する

```bash
docker compose exec app node scripts/check-line.js   # LINE 側（従来どおり）
docker compose exec app node -e "
import('./src/config.js').then(async ({loadConfig}) => {
  const { createInstagramClient } = await import('./src/instagram/client.js');
  const me = await createInstagramClient({ config: loadConfig() }).whoAmI();
  console.log('接続OK:', me.username);
})"
```

店舗のアカウント名が表示されれば接続完了。

---

## 使い方

1. 店舗管理画面 `/mock/` の「SNS投稿」で写真を選ぶ（複数可・最大20枚）
2. キャプションを書く
3. 「今すぐ投稿」または日時を指定して「予約投稿」

- 11枚以上を選ぶと自動で2投稿に分割される（2件目のキャプションに「つづき（2/2）」が付く）
- 予約投稿は5分おきにチェックされ、時刻を過ぎたものから順に投稿される
- 失敗するとスタッフ通知が飛び、一覧に「失敗」と理由が表示される。「取消」して再投稿できる

### dry_run で動作を確認してから live へ

`IG_POST_MODE=dry_run` のまま一度「今すぐ投稿」し、一覧に「dry_run」と記録されること・
コンテナのログに投稿内容が出ることを確認する。問題なければ:

```
IG_POST_MODE=live
```

に変えて `docker compose --profile standalone up -d` で反映する。

---

## トークンの期限（自動延長あり）

トークンは60日で切れるが、**アプリが7日ごとに自動延長する**（毎日 4:30 にチェック）。
延長後のトークンは DB（`app_settings`）に保存され、`.env` の値より優先される。

延長に失敗が続くとスタッフ通知が飛ぶ。その場合は Meta の開発者画面で
「Generate token」からトークンを再発行し、`.env` の `IG_ACCESS_TOKEN` を差し替えたうえで:

```bash
docker compose exec db psql -U postgres -d cocotte_vert -c \
  "DELETE FROM app_settings WHERE key IN ('ig_access_token', 'ig_token_refreshed_at');"
docker compose --profile standalone up -d
```

（DB の古いトークンを消さないと、そちらが優先され続けるため）

---

## うまくいかないとき

| 症状 | 原因 |
|---|---|
| 投稿が「dry_run」と記録される | `IG_POST_MODE` が `dry_run` のまま。実投稿には `live` が必要 |
| `Instagram のアクセストークンが未設定です` | `IG_ACCESS_TOKEN` 未設定、または反映漏れ（`up -d` し直す） |
| `Instagram API 400: Invalid image` など | 画像 URL に Instagram が到達できていない。`PUBLIC_BASE_URL`（通常は `DOMAIN` から自動導出）が外から見える URL か確認 |
| `Instagram API 190` 系 | トークン期限切れ。上記の再発行手順へ |
| 投稿はされるが画質が粗い | ブラウザ側で長辺1440pxに縮小している仕様。原寸で投稿したい場合は相談 |

# スレッズ（Threads）投稿の設定

店舗管理画面（`/mock/` の「SNS投稿」）で、**Instagram 用に選んだ写真の左上にチェックを入れると、
その写真だけをスレッズへ投稿できる**。Instagram の選択は消えないので、同じ写真を両方へ出せる。

LINE・Instagram と同じく **`THREADS_POST_MODE=dry_run` が既定**で、`live` にするまで実投稿されない。

Instagram とは**別のアクセストークン**を使う。Instagram の設定は
[docs/instagram.md](instagram.md) を参照。

---

## 仕組み（先に知っておくこと）

- Instagram と同じ「画像の公開 URL を渡し、Threads 側に取りに来させる」方式。
  写真は `/sns-media/<ランダム名>.jpg` で一時的に公開される
- 写真の変換・保存は Instagram 投稿と共通。同じ写真を両方へ出しても二重にアップロードしない
- **1投稿20枚まで**（2枚以上はカルーセル）。Instagram の10枚制限とは別なので、
  スレッズ側は分割しない
- **本文は500文字まで**。Instagram のキャプション（2200文字）とは別枠なので、
  画面でも入力欄を分けている。超えた分は投稿時に切り詰める
- 動画・リプライ・引用は未対応。写真（単発・カルーセル）のみ

---

## Meta 側のセットアップ（初回のみ・手作業）

### 1. Threads のプロフィールを用意する

店舗の Instagram アカウントに紐づくスレッズのプロフィールを作っておく。

### 2. Meta 開発者アプリに Threads を追加する

1. https://developers.facebook.com/ にログイン
2. Instagram 投稿で作ったアプリを開く（別アプリでもよい）
3. ユースケースに **「Threads API」** を追加し、`threads_basic` と
   `threads_content_publish` の権限を有効にする

### 3. アクセストークンを取得する

Threads API の設定画面で店舗のプロフィールを接続し、**「Generate token」** で
長期トークン（60日有効）を発行する。同じ画面に **Threads user ID**（数字）も出る。

**トークンは Bitwarden に保管し、チャットや Notion に貼らない。**

### 4. `.env` に設定する

```
THREADS_ACCESS_TOKEN=（Generate token で取得したトークン）
THREADS_POST_MODE=dry_run
```

`THREADS_USER_ID` は**空でよい**（トークンからアカウントが特定される）。

```bash
docker compose --profile standalone up -d
```

### 5. 接続を確認する

```bash
docker compose exec app node -e "
import('./src/config.js').then(async ({loadConfig}) => {
  const { createThreadsClient } = await import('./src/threads/client.js');
  const me = await createThreadsClient({ config: loadConfig() }).whoAmI();
  console.log('接続OK:', me.username);
})"
```

---

## 使い方

1. 「SNS投稿」で写真を追加する（Instagram の候補と共通）
2. **スレッズに出したい写真の左上のチェックを入れる**（選ぶと枠が付く）
3. 「スレッズ投稿」カードに本文を書く
4. 「スレッズに投稿」、または日時を指定して「予約投稿」

- 投稿すると**チェックだけが外れ、写真は候補に残る**。続けて Instagram へも投稿できる
- 予約投稿は Instagram と同じ5分おきのチェックで、時刻を過ぎたものから投稿される
- 履歴の「投稿先」列で Instagram／スレッズを区別できる。失敗するとスタッフ通知が飛ぶ

### dry_run で動作を確認してから live へ

`THREADS_POST_MODE=dry_run` のまま一度投稿し、履歴に「dry_run」と記録されること・
コンテナのログに `[dry_run threads]` が出ることを確認してから `live` に変える。

---

## トークンの期限（自動延長あり）

Instagram と同じく60日で切れ、**アプリが7日ごとに自動延長する**（毎日 4:30 にチェック）。
延長後のトークンは `app_settings` に保存され、`.env` の値より優先される。
片方の延長に失敗しても、もう片方の延長は止まらない。

再発行したときは DB の古い値を消してから反映する。

```bash
docker compose exec db psql -U postgres -d cocotte_vert -c \
  "DELETE FROM app_settings WHERE key IN ('threads_access_token', 'threads_token_refreshed_at');"
docker compose --profile standalone up -d
```

---

## うまくいかないとき

| 症状 | 原因 |
|---|---|
| 投稿が「dry_run」と記録される | `THREADS_POST_MODE` が `dry_run` のまま |
| `Threads のアクセストークンが未設定です` | `THREADS_ACCESS_TOKEN` 未設定、または反映漏れ（`up -d` し直す） |
| `スレッズ への投稿が設定されていません` | サーバ側でスレッズのクライアントが作られていない。設定を確認して再起動する |
| `画像の処理に失敗しました` | 画像 URL に Threads が到達できていない。`PUBLIC_BASE_URL`（通常は `DOMAIN` から自動導出）が外から見える URL か確認 |
| 本文が途中で切れる | 500文字の上限。画面でも投稿前に警告が出る |

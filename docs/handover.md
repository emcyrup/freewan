# 引き継ぎ（2店舗目の立ち上げ）

作業を別のセッション・別の担当へ引き継ぐための現在地。**日付順の記録ではなく、
「いまどこまで進んでいて、次に何をするか」だけを書く。** 終わった項目は消してよい。

サーバーのホスト名・IP・認証情報は**このファイルに書かない**（リポジトリは公開設定のため）。
引き継ぎ時に別途伝える。

> **リポジトリの移管（2026-08）**: FREE WAN 店（2店舗目）のアプリは
> **emcyrup/freewan で管理する**ことになった。デプロイの Secrets もこのリポジトリに置く。
> cocotte-vert（1号店）は元リポジトリのまま。汎用的な修正は upstream 経由で相互に取り込む
> （README の手順参照）。
>
> これに伴うサーバー側の切り替え（1回だけ・データは消えない）:
>
> ```bash
> cd ~/cocotte-vert
> git remote set-url origin https://github.com/emcyrup/freewan.git
> git fetch origin && git checkout main && git reset --hard origin/main
> docker compose --profile standalone up -d --build
> ```
>
> ディレクトリ名は `cocotte-vert` のままでよい（CI は freewan / cocotte-vert 両対応）。
> Docker のボリューム名はディレクトリ名から決まるため、**ディレクトリを rename しないこと**
> （rename すると新しい空の DB で起動してしまう）。

---

## 1. 2店舗目のサーバー構築

GCP に VM を1台立て、`docs/new-store.md` の手順で構築中。

| Step | 内容 | 状態 |
|---|---|---|
| 1 | VM を用意（固定 IP・ポート80/443 開放） | **完了** |
| 2 | ドメインを DNS で VM に向ける（DuckDNS） | **完了** |
| 3 | Docker とコードを入れる | **完了** |
| 4 | `.env` を作る | **完了**（LINE の値は仮の可能性あり。下記参照） |
| 5 | 起動して HTTPS を確認・管理画面が開く | **完了** |
| 6 | LINE チャネル・LIFF を作り Webhook を設定 | **進行中**（チャネル作成・`.env` 反映済み。Webhook 設定と検証・リッチメニューが残） |
| 7 | 初期データ投入（メニュー・コース・スタッフ・既存顧客） | **未**（FREEWAN 用の投入データは `scripts/store-data/` に用意済み） |
| 8 | 自動デプロイを2台目に対応させる | **完了**（2026-08-13 疎通確認済み。main への push で自動反映される） |

### Step 6 でやること

1. LINE Developers で Messaging API チャネルと LIFF アプリを作る
2. `.env` の `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LIFF_ID` を本物に差し替える
   - **インフラ確認のために仮の値（`dummy`）を入れている場合がある。必ず確認する**
3. `docker compose --profile standalone up -d` で反映
4. LINE 側の Webhook URL に `https://<ドメイン>/webhook` を設定し、検証を通す
5. リッチメニュー登録（`scripts/setup-richmenu.js`。画像 2500×843px が要る）

### Step 7 でやること

```bash
# FREEWAN 用の内容は scripts/store-data/ に用意済み（コードの編集は不要になった）
docker compose exec app node scripts/seed-menus.js --file=scripts/store-data/freewan.menus.json
docker compose exec app node scripts/seed-plans.js --file=scripts/store-data/freewan.plans.json
```

- メニューの所要時間はモック段階の仮値。ヒアリング後に JSON を直して再実行する
  （同名はスキップされるので何度でも安全）

- スタッフを管理画面から登録し、LINE 連携する（`docs/shift-requests.md`）
- **既存顧客台帳（氏名・電話番号）の投入が最重要。** LIFF 登録時の突合率に直結する
- `STORE_*` の残り（営業時間・定休日・住所・電話・サブタイトル）を `.env` に追記する。
  未設定だと現行店舗の既定値が出る

### Step 8 でやること（残りは Secrets 登録のみ）

ci.yml は複数台対応済み。`DEPLOY_TARGETS`（`user@host` の改行区切り）で全店舗へ配る。
残作業（リポジトリの Settings → Secrets and variables → Actions）:

1. 1台目と同じ deploy_key の**公開鍵を2台目にも登録**（GCP なので `authorized_keys` 直接追記ではなく
   **インスタンスのメタデータ**に追加する。手順と注意は docs/deploy.md「GCP では〜」参照）
2. Secret `DEPLOY_TARGETS` に2台ぶんの `user@host` を改行区切りで登録
   （設定後は旧 `VM_HOST` / `VM_USER` は使われないので消してよい）
3. main に何かをマージし、両店舗へ配られることを Actions のログで確認
   （1台の失敗で他店舗は止まらず、最後にまとめて失敗報告される）

**店舗ごとにコードを分岐させないこと。** 差分は `.env` に寄せる方針で作ってある
（`src/store.js` と配信日数の設定）。メニュー・定額コースの初期データも
`scripts/store-data/` の JSON に寄せた。どうしても吸収できない差が出たら、まず設定化を検討する。

---

## 2. 本稼働までの残り作業（北区店の計画に対して）

計画の Phase と、システム側の状態の対応。

| 計画 | 状態 |
|---|---|
| 顧客管理・カルテ・来店履歴 | 実装済み |
| シフト | 実装済み |
| **回数券・会員管理** | **実装済み**（`docs/plans.md`）。ただし来店登録との連動は未 |
| リマインド R1〜R4 | 実装済み（店舗単位・お客様単位の ON/OFF 付き） |
| SNS 投稿（2分割） | 実装済み（Instagram・スレッズ） |
| **予約カレンダー＋シフト連動** | **未**（画面はサンプルのまま） |
| **EPARK メール自動取込** | **未**。Phase 1 で実物を確認してから着手する（それまで工数が読めない） |
| **リマインド R5〜R8** | 未。R6/R7 は回数券に依存、R8 はワクチン管理が別途要る |
| ダッシュボードの入園数・トリマー実績 | トリマー実績は担当者データから出せる。入園数は回数券から出せるようになった |
| リール投稿 | 未 |
| **リマインドのスタッフ確認付き送信** | **未**。計画では試験運用（Phase 5）で使うので、その前に作る必要がある |

### 次に着手すべきもの

1. **来店登録と回数消化の連動** — `reservations` に「どの子か」（`pet_id`）を持たせる。
   予約フォーム・取り込み API にも波及する
2. R6 / R7 の配信条件（残回数が取れるようになったので組める）
3. リマインドのスタッフ確認付き送信

### 計画に抜けているもの（要確認）

- **ワクチン管理**が Phase 3 の項目に無いのに、R8（ワクチン更新のご案内）が Phase 4 にある
- Phase 2 の API 申請に**スレッズ**が含まれていない（Instagram とは別トークンが要る）

---

## 3. 店舗へ確認したい運用ルール

回数券・保育コースは現行モックの表示に合わせて実装してある。店舗ごとに違いうるので、
ヒアリング（Phase 1）で確認する。変更はいずれも1箇所で済むようにしてある。

- 消化の順番は**当月分優先**でよいか（繰越分が失効しやすくなる）
- 繰越は**1ヶ月**でよいか
- 月途中の加入は**満額**か日割りか（いまは満額）
- 解約後の残回数は**期限まで使えるまま**でよいか

---

## 4. 引き継ぐときに必ず伝えること

このファイルに書かない情報。口頭か別の安全な経路で渡す。

- 2店舗目のドメイン・外部 IP・SSH のユーザー名
- 管理画面の `ADMIN_USER` / `ADMIN_PASSWORD`
- LINE / Instagram / Threads / Anthropic の各トークン
- `POSTGRES_PASSWORD`

---

## 5. 作業を引き継いだ人が最初に読むもの

| | |
|---|---|
| 開発の約束ごと | `CLAUDE.md`（**誤爆防止のルールは必ず読む**） |
| 全体像 | `README.md` |
| 別店舗への展開手順 | `docs/new-store.md` |
| サーバー構築 | `docs/deploy.md` |
| 画面の切り分け（実運用／デモ） | `src/mock/README.md` |
| 回数券・保育コース | `docs/plans.md` |
| スタッフ勤怠 | `docs/shift-requests.md` |
| 運用中アカウントへの接続 | `docs/switch-account.md` |

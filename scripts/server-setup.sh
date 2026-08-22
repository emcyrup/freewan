#!/bin/sh
# 共用サーバー（Docker が使えない本番環境）での初回セットアップ。
# 手順は docs/aws-freewan-manage.md。このスクリプトはその「3〜4」に当たる部分を代行する。
#
#   cd ~/freewan && sh scripts/server-setup.sh
#
# 先に .env を用意しておくこと。何が要るかはこのスクリプトが教えてくれる。
set -e

cd "$(dirname "$0")/.."

# サーバーによっては古い node が PATH の先に来ていることがある。
# その場合の失敗は npm ci やマイグレーションの途中で分かりにくい形で出るため、先に見る
echo "[setup] node $(node -v) / npm $(npm -v)  ($(command -v node))"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[setup] node が古すぎます（v20 以上が必要）。" >&2
  echo "        新しい node が別の場所に入っていないか確認してください:" >&2
  echo "          ls ~/.nvm/versions/node ; command -v -a node" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "[setup] .env がありません。まず作ってください:" >&2
  echo "        cp .env.example .env && nano .env" >&2
  exit 1
fi

# 足りない設定は、起動してから気付くと原因が分かりにくい。ここで先にまとめて知らせる
missing=''
for key in DATABASE_URL LINE_CHANNEL_ACCESS_TOKEN LINE_CHANNEL_SECRET PORT; do
  grep -q "^${key}=." .env || missing="$missing $key"
done
if [ -n "$missing" ]; then
  echo "[setup] .env に次の値が入っていません:$missing" >&2
  exit 1
fi

PORT_TO_CHECK="$(sed -n 's/^PORT=//p' .env | tail -1)"

# .env.example の既定は slack。そのまま使うと SLACK_WEBHOOK_URL が要る。
# 起動時にしか分からないと原因が見えにくいので、ここで先に知らせる
CHANNEL="$(sed -n 's/^STAFF_NOTIFY_CHANNEL=//p' .env | tail -1)"
case "$CHANNEL" in
  slack|both)
    if ! grep -q '^SLACK_WEBHOOK_URL=.' .env; then
      echo "[setup] STAFF_NOTIFY_CHANNEL=$CHANNEL ですが SLACK_WEBHOOK_URL が空です。" >&2
      echo "        Slack を使わないなら STAFF_NOTIFY_CHANNEL=line にしてください" >&2
      exit 1
    fi ;;
esac

# パスワードの記号は URL の中では書き換えが要る。起動時の Invalid URL でつまずきやすいので先に見る
if grep -q '^DATABASE_URL=.*#' .env; then
  echo "[setup] DATABASE_URL に # がそのまま入っています。%23 に書き換えてください" >&2
  echo "        （# より後ろが切り捨てられ、接続できません）" >&2
  exit 1
fi

# 止める理由ではないが、気付かないと「管理画面が開けない」と後で悩むことになる
grep -q '^ADMIN_USER=.' .env && grep -q '^ADMIN_PASSWORD=.' .env \
  || echo "[setup] 注意: ADMIN_USER / ADMIN_PASSWORD が空です。このままだと管理画面は無効になります"
grep -q '^LIFF_ID=.' .env \
  || echo "[setup] 注意: LIFF_ID が空です。このままだと予約フォーム・顧客情報登録が使えません"

echo "[setup] 依存を入れます"
npm ci --omit=dev

echo "[setup] マイグレーションを適用します"
npm run migrate

echo "[setup] 起動確認（数秒で止めます）"
npm start &
APP_PID=$!
i=0
ok=0
while [ $i -lt 15 ]; do
  if curl -sf "http://127.0.0.1:${PORT_TO_CHECK}/health" >/dev/null 2>&1; then ok=1; break; fi
  i=$((i + 1))
  sleep 2
done
kill $APP_PID 2>/dev/null || true
wait $APP_PID 2>/dev/null || true

if [ $ok -ne 1 ]; then
  echo "[setup] ポート ${PORT_TO_CHECK} で応答がありませんでした。上のログを確認してください" >&2
  exit 1
fi

echo ""
echo "[setup] ここまで成功しました。次にやること:"
echo "  1) 常駐させる"
echo "       pm2 start npm --name freewan --time -- start && pm2 save"
echo "     再起動後の自動復帰（pm2 startup）は sudo が要るため、先方へ依頼してください"
echo "  2) 先方に https://<サブドメイン> → 127.0.0.1:${PORT_TO_CHECK} のプロキシ設定を依頼"
echo "  3) 既存データの移送（docs/aws-freewan-manage.md の 6）"
echo "     message_logs を必ず一緒に移すこと。二重送信を止めているのはこのテーブルです"
echo "  4) LINE の Webhook / LIFF の URL を差し替える（同 7。現行サーバーを止めてから）"

#!/bin/sh
# サーバー上でこのアプリを最新にする。手動更新にも CI からの自動デプロイにも同じものを使う。
#
#   sh scripts/server-update.sh
#
# 2種類のサーバーがあるため、環境を見て自動で振り分ける。
#   - Docker が使えるサーバー（自前 VM）        → docker compose で入れ替える
#   - Docker が使えないサーバー（共用の本番環境）→ Node を直接動かし、PM2 で常駐させる
# 分岐をここに閉じ込めておかないと、CI 側と手順書の両方に同じ条件分岐が散らばるため。
set -e

cd "$(dirname "$0")/.."

git fetch origin main
git checkout main
git pull --ff-only origin main

# 「Docker が動くか」で判断する。コマンドの有無だけでは、
# 入っていても権限が無くて使えないサーバーを取りこぼす
if docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "[update] Docker 構成として更新します"
  docker compose --profile standalone up -d --build
  PORT_TO_CHECK="${HOST_PORT:-3000}"
else
  echo "[update] Node を直接動かす構成として更新します"
  npm ci --omit=dev
  npm run migrate

  # .env の PORT を見て疎通確認する。既定は 3000
  PORT_TO_CHECK="$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -1)"
  [ -z "$PORT_TO_CHECK" ] && PORT_TO_CHECK=3000

  if command -v pm2 >/dev/null 2>&1; then
    # .env を読ませるため npm start を起動する（src/index.js を直接指定しない）
    if pm2 describe freewan >/dev/null 2>&1; then
      pm2 restart freewan --update-env
    else
      pm2 start npm --name freewan --time -- start
    fi
    pm2 save
  else
    echo "[update] pm2 が無いため、起動し直しは手動で行ってください:"
    echo "         pkill -f 'node .*src/index.js' ; nohup npm start > ~/freewan/app.log 2>&1 &"
  fi
fi

# 起動を待ってから確認する。落ちていればここで失敗させ、CI に気付かせる
i=0
while [ $i -lt 15 ]; do
  if curl -sf "http://127.0.0.1:${PORT_TO_CHECK}/health" >/dev/null 2>&1; then
    echo "[update] 完了: http://127.0.0.1:${PORT_TO_CHECK}/health が応答しました"
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "[update] 起動確認に失敗しました（ポート ${PORT_TO_CHECK}）" >&2
exit 1

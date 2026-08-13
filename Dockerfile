FROM node:22-slim

# 日付比較は JST 前提のため、コンテナの TZ を固定する
ENV NODE_ENV=production TZ=Asia/Tokyo

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# Instagram 投稿の写真置き場。ボリューム初期化時にこの所有権が引き継がれるよう、
# イメージ側で node 所有のディレクトリを用意しておく（無いと root 所有になり書き込めない）
RUN mkdir -p /app/data/sns && chown -R node:node /app/data

USER node
EXPOSE 3000

CMD ["node", "src/index.js"]

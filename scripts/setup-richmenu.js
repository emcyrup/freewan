// リッチメニューを作成し、全ユーザーのデフォルトに設定する。
// 使い方: node --env-file-if-missing=.env scripts/setup-richmenu.js --image=path/to/menu.png
// 画像は 2500x843 px（PNG/JPEG、1MB 以下）を用意すること。
// 左右2分割で「ご予約」「お客様情報」の導線を置く（画像もこの割付に合わせる）。
import { readFile } from 'node:fs/promises';
import { messagingApi } from '@line/bot-sdk';
import { loadConfig } from '../src/config.js';

const config = loadConfig();

const imageArg = process.argv.find((a) => a.startsWith('--image='));
if (!imageArg) {
  console.error('使い方: node scripts/setup-richmenu.js --image=path/to/menu.png');
  process.exit(1);
}
if (!config.liffUrl) {
  console.error('LIFF_ID が未設定です。リッチメニューは LIFF 導線が前提のため中断します。');
  process.exit(1);
}
const imagePath = imageArg.slice('--image='.length);

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});
const blobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: config.line.channelAccessToken,
});

async function main() {
  // 既存のデフォルトメニューがあれば付け替えのみで済むよう、毎回新規作成→切替の順にする
  const { richMenuId } = await client.createRichMenu({
    size: { width: 2500, height: 843 },
    selected: true,
    name: `main-${Date.now()}`,
    chatBarText: 'メニュー',
    areas: [
      {
        bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'ご予約', uri: config.liffReserveUrl },
      },
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'お客様情報', uri: config.liffUrl },
      },
    ],
  });

  const image = await readFile(imagePath);
  const contentType = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg')
    ? 'image/jpeg'
    : 'image/png';
  await blobClient.setRichMenuImage(richMenuId, new Blob([image], { type: contentType }));

  await client.setDefaultRichMenu(richMenuId);
  console.log(`[richmenu] 作成してデフォルトに設定しました: ${richMenuId}`);
  console.log('[richmenu] 古いメニューが残っている場合は LINE Developers コンソールから削除してください');
}

main().catch((err) => {
  console.error(`[richmenu] 失敗: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node
// 現在の .env がどの LINE 公式アカウントに繋がっているかを確認する。
//
// アカウントを切り替えたあと「本当に意図したアカウントに繋がったか」を確かめる用途。
// トークンは表示せず、アカウント名・ベーシック ID・Webhook の状態だけを出す。
//
// 使い方: docker compose exec app node scripts/check-line.js
//
// 読み取りのみで、送信も設定変更も行わない（SEND_MODE に関わらず安全）。
import { messagingApi } from '@line/bot-sdk';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

const ok = (label, value) => console.log(`  ✓ ${label}: ${value}`);
const ng = (label, value) => console.log(`  ✗ ${label}: ${value}`);

async function main() {
  console.log('\n== 接続先のアカウント ==');
  const bot = await client.getBotInfo();
  ok('表示名', bot.displayName);
  ok('ベーシックID', bot.basicId);
  ok('友だち追加URL', `https://line.me/R/ti/p/${bot.basicId}`);
  // chatMode: chat = 手動チャット中心 / bot = Bot 応答。Webhook を受けるには bot が必要
  if (bot.chatMode === 'bot') ok('応答モード', 'Bot（Webhook を受け取れます）');
  else ng('応答モード', `${bot.chatMode}（Webhook が飛びません。OA Manager で Bot に変更してください）`);
  if (bot.markAsReadMode) console.log(`  ・既読設定: ${bot.markAsReadMode}`);

  console.log('\n== Webhook ==');
  try {
    const endpoint = await client.getWebhookEndpoint();
    const expected = config.liffUrl ? null : null; // URL の正解はドメイン依存のため判定しない
    ok('設定URL', endpoint.endpoint || '(未設定)');
    if (endpoint.active) ok('有効', 'はい');
    else ng('有効', 'いいえ（LINE Developers で Webhook の利用をオンにしてください）');

    const test = await client.testWebhookEndpoint({ endpoint: endpoint.endpoint });
    if (test.success) ok('疎通テスト', `成功（HTTP ${test.statusCode}）`);
    else ng('疎通テスト', `失敗: ${test.reason} / ${test.detail}`);
    void expected;
  } catch (err) {
    ng('取得失敗', err.message);
  }

  console.log('\n== 月間通数 ==');
  const quota = await client.getMessageQuota();
  const consumption = await client.getMessageQuotaConsumption();
  if (quota.type === 'limited') {
    const remaining = quota.value - consumption.totalUsage;
    ok('残数', `${remaining} / ${quota.value}（使用済み ${consumption.totalUsage}）`);
  } else {
    ok('上限', `なし（使用済み ${consumption.totalUsage}）`);
  }

  console.log('\n== このアプリの設定 ==');
  console.log(`  ・SEND_MODE: ${config.sendMode}`);
  console.log(`  ・LIFF: ${config.liffUrl ?? '(未設定)'}`);
  console.log(`  ・予約フォーム: ${config.liffReserveUrl ?? '(未設定)'}`);
  console.log(`  ・スタッフ通知: ${config.staffNotifyChannel}`);
  console.log('');
}

main().catch((err) => {
  console.error(`\n[check-line] 失敗: ${err.message}`);
  console.error('トークンが正しいか、アカウントを切り替えたあとコンテナを再起動したかを確認してください。\n');
  process.exit(1);
});

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { middleware, SignatureValidationFailed } from '@line/bot-sdk';
import { loadConfig } from './config.js';
import { loadStoreProfile } from './store.js';
import { pool } from './db/pool.js';
import { createLineClient } from './line/client.js';
import { createIdTokenVerifier } from './line/verifyIdToken.js';
import { createSlackNotifier } from './notify/slack.js';
import { createStaffNotifier } from './notify/staffNotifier.js';
import { createSettings } from './settings.js';
import { createReminderSettings, createCustomerReminders } from './reminders.js';
import { createLinkService } from './customers/linkService.js';
import { createWebhookHandler } from './webhook/handler.js';
import { createJobRunner } from './jobs/runner.js';
import { createPreReminderJob } from './jobs/preReminder.js';
import { createAfterVisitJob } from './jobs/afterVisit.js';
import { createDormantJob } from './jobs/dormant.js';
import { createBirthdayJob } from './jobs/birthday.js';
import { createFollowupClassifier } from './ai/classifyFollowup.js';
import { createShiftRequestParser } from './ai/parseShiftRequest.js';
import { createShiftService } from './shifts/service.js';
import { createPlanService } from './plans/service.js';
import { createReservationService } from './reservations/service.js';
import { basicAuth, bearerAuth } from './http/auth.js';
import { createAdminRouter } from './http/adminRoutes.js';
import { createImportRouter } from './http/importRoutes.js';
import { createSnsRouter } from './http/snsRoutes.js';
import { createInstagramClient } from './instagram/client.js';
import { createThreadsClient } from './threads/client.js';
import { createSnsPublisher } from './jobs/snsPublisher.js';
import { mkdirSync, statSync } from 'node:fs';
import cron from 'node-cron';

const config = loadConfig();
const store = loadStoreProfile();
const lineClient = createLineClient({ config, pool });
const settings = createSettings({ pool });
const reminderSettings = createReminderSettings({ settings });
const customerReminders = createCustomerReminders({ pool });
// スタッフ通知は staffNotifier に集約（Slack / LINE グループ / 両方を設定で切替）
const slackChannel = config.slackWebhookUrl
  ? createSlackNotifier({ webhookUrl: config.slackWebhookUrl })
  : null;
const slack = createStaffNotifier({ config, slack: slackChannel, lineClient, settings });
const linkService = createLinkService({ pool, slack });
const classifier = createFollowupClassifier({ apiKey: config.anthropicApiKey });
// シフト変更申請（スタッフが公式LINE へ自由記述で送る）
const shiftParser = createShiftRequestParser({ apiKey: config.anthropicApiKey });
const shiftService = createShiftService({ pool, lineClient, slack, settings, config });
// 回数券・保育コースの回数管理（残回数は元帳の合計から導く）
const planService = createPlanService({ pool });

const app = express();

// デプロイ確認用にバージョンも返す
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

app.get('/health', (_req, res) =>
  res.json({ ok: true, sendMode: config.sendMode, version: pkg.version })
);

// 署名検証には生ボディが必要なため、express.json() を webhook より前に適用しない
app.post(
  '/webhook',
  middleware({ channelSecret: config.line.channelSecret }),
  createWebhookHandler({
    pool,
    lineClient,
    slack,
    linkService,
    classifier,
    settings,
    shiftService,
    shiftParser,
    config,
    liffUrl: config.liffUrl,
  })
);

// ---- ここから下は JSON パースを使う（webhook 以外のルート） ----
app.use(express.json());

// 画面（HTML/JS）は毎回サーバーへ更新確認させる。デプロイ後に古い app.js が
// キャッシュされたまま残り、「ボタンが効かない」事故が繰り返されたため。
// 変更がなければ 304 で返るので転送量はほぼ増えない
const noStaleCache = {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
};

// LIFF 登録フォーム（静的ファイル）
const liffDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'liff');
app.use('/liff', express.static(liffDir, noStaleCache));

// フロントに LIFF ID を渡す（HTML に焼き込まない）
app.get('/liff/config', (_req, res) => {
  if (!config.liffId) return res.status(503).json({ error: 'LIFF 未設定' });
  res.json({ liffId: config.liffId });
});

// LIFF 登録フォームの送信先。userId は ID トークン検証で得た sub のみを信用する
const verifyIdToken = config.liffChannelId
  ? createIdTokenVerifier({ channelId: config.liffChannelId })
  : null;

// 登録済みの顧客が「お客様情報」を開いたときに、現在の内容を出して変更できるようにする
app.post('/liff/profile', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ error: 'liff_not_configured' });
  try {
    let payload;
    try {
      payload = await verifyIdToken(req.body?.idToken);
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const { rows } = await pool.query(
      `SELECT name, phone_norm, birthday, opt_out
       FROM customers
       WHERE line_user_id = $1 AND is_blocked = false`,
      [payload.sub]
    );
    // 電話番号が未登録なら本登録前（follow 時の仮レコード）とみなす
    if (rows.length === 0 || !rows[0].phone_norm) return res.json({ registered: false });

    const c = rows[0];
    return res.json({
      registered: true,
      name: c.name,
      phone: c.phone_norm,
      // DATE 型は JST 前提。ISO 変換で日付がずれないよう文字列のまま返す
      birthday: c.birthday ? new Date(c.birthday).toLocaleDateString('sv-SE') : null,
      consent: !c.opt_out,
    });
  } catch (err) {
    console.error(`[liff/profile] 失敗: ${err.message}`);
    return res.status(500).json({ error: 'internal' });
  }
});

app.post('/liff/register', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ ok: false, error: 'liff_not_configured' });
  try {
    const { idToken, name, phone, birthday, consent } = req.body ?? {};
    let payload;
    try {
      payload = await verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
    const result = await linkService.registerFromLiff({
      lineUserId: payload.sub,
      name,
      phone,
      birthday,
      consent: Boolean(consent),
    });
    if (!result.ok) return res.status(400).json(result);
    // outcome はクライアントに返さない（他人の登録状況を推測させない）
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[liff/register] 失敗: ${err.message}`);
    await slack.notifyError('LIFF 登録処理失敗', err);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// ---- 予約データの取り込み（Phase 6）----
const reservationService = createReservationService({ pool, slack, lineClient });

// LIFF 予約フォーム。顧客の特定は ID トークン検証で得た sub のみを信用する
app.post('/liff/reserve/options', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ error: 'liff_not_configured' });
  try {
    let payload;
    try {
      payload = await verifyIdToken(req.body?.idToken);
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const { rows: customers } = await pool.query(
      `SELECT name FROM customers WHERE line_user_id = $1 AND is_blocked = false`,
      [payload.sub]
    );
    if (customers.length === 0) return res.json({ registered: false });

    const { rows: menus } = await pool.query(
      `SELECT id, name, duration_minutes FROM menus WHERE active = true ORDER BY sort_order, id`
    );
    const { rows: staff } = await pool.query(
      `SELECT id, name FROM staff WHERE active = true ORDER BY id`
    );
    return res.json({ registered: true, customerName: customers[0].name, menus, staff });
  } catch (err) {
    console.error(`[liff/reserve/options] 失敗: ${err.message}`);
    return res.status(500).json({ error: 'internal' });
  }
});

app.post('/liff/reserve', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ ok: false, error: 'liff_not_configured' });
  try {
    const { idToken, menuId, staffId, reservedAt, note } = req.body ?? {};
    let payload;
    try {
      payload = await verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
    const result = await reservationService.createRequest({
      lineUserId: payload.sub,
      menuId: menuId ? Number(menuId) : null,
      staffId: staffId ? Number(staffId) : null,
      reservedAt,
      note,
    });
    if (!result.ok) return res.status(400).json(result);
    // 予約 ID など内部情報は返さない
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[liff/reserve] 失敗: ${err.message}`);
    await slack.notifyError('LIFF 予約リクエスト処理失敗', err);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// 管理 API（Basic 認証。ADMIN_USER / ADMIN_PASSWORD 未設定なら無効）
const adminGuard = basicAuth({ user: config.adminUser, password: config.adminPassword });
// 旧管理画面（/admin/）はモック側の画面に統合した。ブックマーク・LINE内の旧リンク互換のためリダイレクトを残す
app.get('/admin/customers.html', (_req, res) => res.redirect('/mock/#list'));
app.get(['/admin', '/admin/index.html'], (_req, res) => res.redirect('/mock/#resv'));
app.use(
  '/api/admin',
  adminGuard,
  createAdminRouter({
    pool,
    reservationService,
    lineClient,
    config,
    shiftService,
    reminderSettings,
    customerReminders,
    planService,
  })
);

// 店舗管理画面（モック統合版）。管理 API に疎通できる本番環境では実データで動き、
// 単体で開いたときはサンプルデータのデモとして動く。
// 実在の顧客データを扱うため、管理 API と同じ Basic 認証の内側に置く
const mockDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock');
app.use('/mock', adminGuard, express.static(mockDir, noStaleCache));

// 店舗プロフィール。画面はこれを読んで店名・営業時間などを差し替える
// （店舗ごとにコードを分岐させないため、値は .env に置く）
app.get('/api/admin/store', adminGuard, (_req, res) => res.json({ store }));

// いま配信している画面ファイルの更新時刻。開きっぱなしのタブが古い画面のままでも
// 気付けるよう、画面側が自分の Last-Modified と突き合わせて再読み込みを促す。
// （no-cache を付けていても、タブ一覧から戻ったときに再検証せず描画する端末がある）
app.get('/api/admin/mock-version', adminGuard, (_req, res) => {
  try {
    const { mtime } = statSync(path.join(mockDir, 'index.html'));
    res.json({ mtime: mtime.toISOString() });
  } catch (err) {
    // 判定できないだけなので、画面を止めずに黙って諦めさせる
    res.status(503).json({ error: err.message });
  }
});

// ---- Instagram 投稿 ----
// 投稿画像は Instagram 側が公開 URL から取得する仕様のため、認証なしで配信する。
// ファイル名が推測不能なランダム値であることが実質のアクセス制御になる
const snsDataDir = path.join(process.cwd(), 'data', 'sns');
try {
  mkdirSync(snsDataDir, { recursive: true });
} catch (err) {
  // 写真置き場が作れなくても LINE 配信まで道連れにしない（SNS 機能だけ落とす）
  console.error(`[sns] 写真ディレクトリを作成できません: ${err.message}`);
}
app.use('/sns-media', express.static(snsDataDir, { maxAge: '7d', immutable: true }));

const instagram = createInstagramClient({ config, settings });
const threads = createThreadsClient({ config, settings });
const snsPublisher = createSnsPublisher({ pool, instagram, threads, slack, config });
app.use('/api/admin/sns', adminGuard, createSnsRouter({ pool, publisher: snsPublisher, dataDir: snsDataDir }));

// 予約投稿の時刻チェック（5分おき）。深夜帯の投稿も予約どおり実行する（SNS は顧客への Push ではないため）
cron.schedule('*/5 * * * *', async () => {
  try {
    await snsPublisher.publishDue();
  } catch (err) {
    console.error(`[sns] 予約投稿の処理に失敗: ${err.message}`);
  }
}, { timezone: 'Asia/Tokyo' });

// Instagram / Threads 長期トークンの延長（毎日チェックし、7日ごとに実際に延長）
cron.schedule('30 4 * * *', async () => {
  for (const [label, client] of [['instagram', instagram], ['threads', threads]]) {
    // 片方の失敗でもう片方の延長を止めない（どちらも60日で切れるため）
    try {
      const result = await client.refreshTokenIfNeeded();
      if (result.refreshed) console.log(`[${label}] アクセストークンを延長しました`);
    } catch (err) {
      console.error(`[${label}] トークン延長に失敗: ${err.message}`);
      await slack.notify(
        `:warning: ${label} トークンの延長に失敗しました。期限切れ前に再発行してください。\n${err.message}`
      );
    }
  }
}, { timezone: 'Asia/Tokyo' });

// 外部予約システムからの取り込み（Bearer トークン。INGEST_API_TOKEN 未設定なら無効）
app.use(
  '/api/import',
  bearerAuth({ token: config.ingestApiToken }),
  createImportRouter({ reservationService, slack })
);

// 署名検証失敗は 401 で即返す
app.use((err, _req, res, next) => {
  if (err instanceof SignatureValidationFailed) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  console.error(`[http] ${err.message}`);
  return res.status(500).json({ error: 'internal error' });
});

// 定額プランの月次付与と、期限切れの失効。
// 毎月1日の 0:30 JST に付与し、失効は毎日確認する（期限は月末とは限らないため）。
// 付与は部分ユニーク索引で二重にならないので、再実行しても増えない
cron.schedule('30 0 1 * *', async () => {
  try {
    const result = await planService.grantMonthly();
    console.log(`[plans] 月次付与 加入${result.enrolled}件 / 付与${result.granted}件`);
  } catch (err) {
    console.error(`[plans] 月次付与に失敗: ${err.message}`);
    await slack.notifyError('保育コースの月次付与に失敗', err);
  }
}, { timezone: 'Asia/Tokyo' });

cron.schedule('45 0 * * *', async () => {
  try {
    const result = await planService.expireOverdue();
    if (result.expired > 0) console.log(`[plans] 失効 ${result.expired}件 / 計${result.total}回`);
  } catch (err) {
    console.error(`[plans] 失効処理に失敗: ${err.message}`);
    await slack.notifyError('回数の失効処理に失敗', err);
  }
}, { timezone: 'Asia/Tokyo' });

// 毎日 10:00 JST の配信ジョブ（Phase 4・5 のジョブもここに追加していく）
const runner = createJobRunner({ slack, settings, reminders: reminderSettings });
runner.scheduleDaily(
  {
    preReminder: createPreReminderJob({ pool, lineClient, daysBefore: config.preReminderDaysBefore }),
    afterVisit: createAfterVisitJob({ pool, lineClient, daysAfter: config.afterVisitDaysAfter }),
    dormant: createDormantJob({
      pool, lineClient, dailyLimit: config.dormantDailyLimit, dormantDays: config.dormantDays,
    }),
    birthday: createBirthdayJob({ pool, lineClient, couponUrl: config.birthdayCouponUrl }),
  },
  {
    lineClient,
    quotaWarnRatio: config.quotaWarnRatio,
    quotaWarnRemaining: config.quotaWarnRemaining,
  }
);

app.listen(config.port, () => {
  console.log(`[boot] port=${config.port} SEND_MODE=${config.sendMode}`);
  if (config.sendMode === 'live') {
    console.log('[boot] ⚠️  本番送信モードで起動しています');
  }
});

// 単一ジョブの手動実行。
// 使い方: node scripts/run-job.js --job=preReminder [--dry-run]
// --dry-run を付けると SEND_MODE の設定に関わらず dry_run で実行する（安全側への上書きのみ許可）。

const jobArg = process.argv.find((a) => a.startsWith('--job='));
const dryRun = process.argv.includes('--dry-run');

const JOB_NAMES = ['preReminder', 'afterVisit', 'dormant', 'birthday'];

const jobName = jobArg?.slice('--job='.length);
if (!jobName || !JOB_NAMES.includes(jobName)) {
  console.error(`使い方: node scripts/run-job.js --job=<${JOB_NAMES.join('|')}> [--dry-run]`);
  process.exit(1);
}

if (dryRun) {
  process.env.SEND_MODE = 'dry_run';
}

// SEND_MODE を確定させてから読み込む（config はロード時に環境変数を固定するため動的 import）
const { loadConfig } = await import('../src/config.js');
const { pool } = await import('../src/db/pool.js');
const { createLineClient } = await import('../src/line/client.js');
const { createSlackNotifier } = await import('../src/notify/slack.js');
const { createStaffNotifier } = await import('../src/notify/staffNotifier.js');
const { createSettings } = await import('../src/settings.js');
const { createReminderSettings } = await import('../src/reminders.js');
const { createJobRunner } = await import('../src/jobs/runner.js');
const { createPreReminderJob } = await import('../src/jobs/preReminder.js');
const { createAfterVisitJob } = await import('../src/jobs/afterVisit.js');
const { createDormantJob } = await import('../src/jobs/dormant.js');
const { createBirthdayJob } = await import('../src/jobs/birthday.js');

const config = loadConfig();
console.log(`[run-job] job=${jobName} SEND_MODE=${config.sendMode}`);

const lineClient = createLineClient({ config, pool });
const slackChannel = config.slackWebhookUrl
  ? createSlackNotifier({ webhookUrl: config.slackWebhookUrl })
  : null;
const settings = createSettings({ pool });
const slack = createStaffNotifier({ config, slack: slackChannel, lineClient, settings });
// 管理画面で OFF にしたリマインドは手動実行でも送らない（経路によって挙動が変わらないように）
const runner = createJobRunner({ slack, settings, reminders: createReminderSettings({ settings }) });

const jobs = {
  preReminder: createPreReminderJob({ pool, lineClient, daysBefore: config.preReminderDaysBefore }),
  afterVisit: createAfterVisitJob({ pool, lineClient, daysAfter: config.afterVisitDaysAfter }),
  dormant: createDormantJob({
    pool, lineClient, dailyLimit: config.dormantDailyLimit, dormantDays: config.dormantDays,
  }),
  birthday: createBirthdayJob({ pool, lineClient, couponUrl: config.birthdayCouponUrl }),
};

const summary = await runner.runJob(jobName, jobs[jobName]);
await pool.end();
process.exit(summary ? 0 : 1);

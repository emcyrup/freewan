// 回数の月次付与・失効の手動実行。
// 使い方: node scripts/run-plan-job.js --job=grant|expire
//
// 通常は cron（毎月1日 0:30 付与 / 毎日 0:45 失効）で動く。
// デプロイが月初を跨いだ、サーバーが落ちていた、といったときに埋めるために使う。
// 付与は二重にならないので、何度実行しても増えない。

const jobArg = process.argv.find((a) => a.startsWith('--job='));
const jobName = jobArg?.slice('--job='.length);
if (!['grant', 'expire'].includes(jobName)) {
  console.error('使い方: node scripts/run-plan-job.js --job=<grant|expire>');
  process.exit(1);
}

const { pool } = await import('../src/db/pool.js');
const { createPlanService } = await import('../src/plans/service.js');
const plans = createPlanService({ pool });

if (jobName === 'grant') {
  const r = await plans.grantMonthly();
  console.log(`[plans] 月次付与 加入${r.enrolled}件 / 付与${r.granted}件`);
} else {
  const r = await plans.expireOverdue();
  console.log(`[plans] 失効 ${r.expired}件 / 計${r.total}回`);
}
await pool.end();

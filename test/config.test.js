import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/test',
  LINE_CHANNEL_ACCESS_TOKEN: 'token',
  LINE_CHANNEL_SECRET: 'secret',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
};

test('必須変数が揃っていれば読み込める', () => {
  const config = loadConfig({ ...baseEnv });
  assert.equal(config.databaseUrl, baseEnv.DATABASE_URL);
});

test('必須変数が欠けていると起動時に落ちる', () => {
  const env = { ...baseEnv };
  delete env.LINE_CHANNEL_SECRET;
  assert.throws(() => loadConfig(env), /LINE_CHANNEL_SECRET/);
});

test('SEND_MODE 未指定時のデフォルトは dry_run', () => {
  const config = loadConfig({ ...baseEnv });
  assert.equal(config.sendMode, 'dry_run');
});

test('通数警告は既定で上限の10%判定（通数固定は任意）', () => {
  const config = loadConfig({ ...baseEnv });
  assert.equal(config.quotaWarnRatio, 0.1);
  assert.equal(config.quotaWarnRemaining, null, '未指定なら割合判定を使う');

  const fixed = loadConfig({ ...baseEnv, QUOTA_WARN_REMAINING: '800' });
  assert.equal(fixed.quotaWarnRemaining, 800);
  assert.equal(loadConfig({ ...baseEnv, QUOTA_WARN_RATIO: '0.2' }).quotaWarnRatio, 0.2);
});

test('不正な SEND_MODE は拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, SEND_MODE: 'production' }), /SEND_MODE/);
});

test('SEND_MODE=test は TEST_LINE_USER_ID がないと拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, SEND_MODE: 'test' }), /TEST_LINE_USER_ID/);
  const config = loadConfig({ ...baseEnv, SEND_MODE: 'test', TEST_LINE_USER_ID: 'Utest' });
  assert.equal(config.sendMode, 'test');
});

test('TZ が Asia/Tokyo 以外なら拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, TZ: 'UTC' }), /Asia\/Tokyo/);
});

test('スタッフ通知: デフォルト slack は SLACK_WEBHOOK_URL 必須', () => {
  const env = { ...baseEnv };
  delete env.SLACK_WEBHOOK_URL;
  assert.throws(() => loadConfig(env), /SLACK_WEBHOOK_URL/);
});

test('スタッフ通知: line チャネルは Slack URL 不要、グループ ID は任意（参加時に自動設定）', () => {
  const env = { ...baseEnv, STAFF_NOTIFY_CHANNEL: 'line' };
  delete env.SLACK_WEBHOOK_URL;

  const config = loadConfig(env);
  assert.equal(config.staffNotifyChannel, 'line');
  assert.equal(config.staffLineGroupId, null);

  const withOverride = loadConfig({ ...env, STAFF_LINE_GROUP_ID: 'Cgroup1' });
  assert.equal(withOverride.staffLineGroupId, 'Cgroup1');
});

test('スタッフ通知: 不正なチャネルは拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, STAFF_NOTIFY_CHANNEL: 'email' }), /STAFF_NOTIFY_CHANNEL/);
});

test('配信の日数は既定値があり、設定で変えられる', () => {
  const c = loadConfig(baseEnv);
  assert.equal(c.preReminderDaysBefore, 2);
  assert.equal(c.afterVisitDaysAfter, 7);
  assert.equal(c.dormantDays, 90);

  const custom = loadConfig({
    ...baseEnv,
    PRE_REMINDER_DAYS_BEFORE: '3',
    AFTER_VISIT_DAYS_AFTER: '14',
    DORMANT_DAYS: '180',
  });
  assert.equal(custom.preReminderDaysBefore, 3);
  assert.equal(custom.afterVisitDaysAfter, 14);
  assert.equal(custom.dormantDays, 180);
});

test('配信の日数の書き間違いは起動時に落とす', () => {
  assert.throws(() => loadConfig({ ...baseEnv, DORMANT_DAYS: '0' }), /DORMANT_DAYS/);
  assert.throws(() => loadConfig({ ...baseEnv, DORMANT_DAYS: '90日' }), /DORMANT_DAYS/);
  assert.throws(() => loadConfig({ ...baseEnv, AFTER_VISIT_DAYS_AFTER: '1.5' }), /AFTER_VISIT_DAYS_AFTER/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReminderSettings, REMINDER_JOBS } from '../src/reminders.js';
import { createJobRunner } from '../src/jobs/runner.js';

function makeSettings(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    settings: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => void store.set(k, v),
    },
  };
}

function makeSlack() {
  const notifications = [];
  return {
    notifications,
    slack: {
      notify: async (t) => notifications.push(t),
      notifyError: async (c, e) => notifications.push(`ERROR:${c}:${e.message}`),
    },
  };
}

test('設定が無いときは4種とも ON', async () => {
  const { settings } = makeSettings();
  const reminders = createReminderSettings({ settings });
  const enabled = await reminders.getAll();
  assert.deepEqual(
    enabled,
    Object.fromEntries(REMINDER_JOBS.map((j) => [j.key, true]))
  );
});

test('一括 OFF を保存すると全部 false になる', async () => {
  const { settings } = makeSettings();
  const reminders = createReminderSettings({ settings });
  const patch = Object.fromEntries(REMINDER_JOBS.map((j) => [j.key, false]));

  const after = await reminders.update(patch);
  assert.deepEqual(after, patch);
  assert.deepEqual(await reminders.getAll(), patch);
});

test('変えた分だけ更新され、他はそのまま', async () => {
  const { settings } = makeSettings();
  const reminders = createReminderSettings({ settings });

  await reminders.update({ dormant: false });
  const enabled = await reminders.getAll();
  assert.equal(enabled.dormant, false);
  assert.equal(enabled.preReminder, true);
  assert.equal(enabled.birthday, true);
});

test('未知のキー・真偽値以外は保存しない', async () => {
  const { settings, store } = makeSettings();
  const reminders = createReminderSettings({ settings });

  await assert.rejects(() => reminders.update({ unknownJob: false }), /未知のリマインド/);
  await assert.rejects(() => reminders.update({ dormant: 'off' }), /真偽値/);
  assert.equal(store.size, 0);
});

test('保存値が壊れていても止めない（全 ON として扱う）', async () => {
  const { settings } = makeSettings({ reminders_enabled: '{壊れた' });
  const reminders = createReminderSettings({ settings });
  assert.equal(await reminders.isEnabled('dormant'), true);
});

test('リマインド以外のジョブ名は常に実行対象', async () => {
  const { settings } = makeSettings();
  const reminders = createReminderSettings({ settings });
  await reminders.update({ dormant: false });
  assert.equal(await reminders.isEnabled('somethingElse'), true);
});

test('OFF のジョブは runner が実行しない', async () => {
  const { settings } = makeSettings();
  const { slack, notifications } = makeSlack();
  const reminders = createReminderSettings({ settings });
  await reminders.update({ dormant: false });

  const runner = createJobRunner({ slack, settings, reminders });
  let ran = false;
  const summary = await runner.runJob('dormant', async () => {
    ran = true;
    return { total: 1, sent: 1, dryRun: 0, skipped: 0, failed: 0, errors: [] };
  });

  assert.equal(ran, false);
  assert.equal(summary.disabled, true);
  assert.equal(summary.sent, 0);
  assert.equal(notifications.length, 0);
});

test('ON のジョブはこれまでどおり実行される', async () => {
  const { settings } = makeSettings();
  const { slack } = makeSlack();
  const reminders = createReminderSettings({ settings });

  const runner = createJobRunner({ slack, settings, reminders });
  const summary = await runner.runJob('birthday', async () => ({
    total: 2, sent: 2, dryRun: 0, skipped: 0, failed: 0, errors: [],
  }));
  assert.equal(summary.sent, 2);
});

test('まとめ通知では停止中と分かる', async () => {
  const { settings } = makeSettings();
  const { slack, notifications } = makeSlack();
  const reminders = createReminderSettings({ settings });
  await reminders.update({ preReminder: false });

  const runner = createJobRunner({ slack, settings, reminders });
  await runner.runAll({
    preReminder: async () => ({ total: 5, sent: 5, dryRun: 0, skipped: 0, failed: 0, errors: [] }),
    birthday: async () => ({ total: 1, sent: 1, dryRun: 0, skipped: 0, failed: 0, errors: [] }),
  });

  const saved = await settings.get('last_job_summary');
  assert.match(saved, /前々日確認: 停止中/);
  assert.match(saved, /誕生日: 対象 1/);
  assert.equal(notifications.length, 0);
});

// ---- お客様ごとの設定 ----
import { createCustomerReminders } from '../src/reminders.js';

// customer_reminder_settings の中身だけを持つ最小の pool
function makeCustomerPool(initial = []) {
  const rows = [...initial]; // { customer_id, job, enabled }
  return {
    rows,
    pool: {
      query: async (sql, params) => {
        if (/SELECT job, enabled/.test(sql)) {
          return { rows: rows.filter((r) => r.customer_id === params[0]) };
        }
        if (/INSERT INTO customer_reminder_settings/.test(sql)) {
          const [customer_id, job, enabled] = params;
          const hit = rows.find((r) => r.customer_id === customer_id && r.job === job);
          if (hit) hit.enabled = enabled;
          else rows.push({ customer_id, job, enabled });
          return { rows: [] };
        }
        return { rows: [] };
      },
    },
  };
}

test('お客様ごとの設定は行が無ければ全 ON', async () => {
  const { pool } = makeCustomerPool();
  const cr = createCustomerReminders({ pool });
  assert.deepEqual(await cr.get(1), {
    preReminder: true, afterVisit: true, dormant: true, birthday: true,
  });
});

test('OFF にした種類だけが保存される', async () => {
  const { pool, rows } = makeCustomerPool();
  const cr = createCustomerReminders({ pool });

  const after = await cr.update(1, { birthday: false });
  assert.equal(after.birthday, false);
  assert.equal(after.dormant, true);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { customer_id: 1, job: 'birthday', enabled: false });
});

test('別のお客様の設定は混ざらない', async () => {
  const { pool } = makeCustomerPool([{ customer_id: 1, job: 'dormant', enabled: false }]);
  const cr = createCustomerReminders({ pool });
  assert.equal((await cr.get(1)).dormant, false);
  assert.equal((await cr.get(2)).dormant, true);
});

test('お客様ごとでも未知のキー・真偽値以外は保存しない', async () => {
  const { pool, rows } = makeCustomerPool();
  const cr = createCustomerReminders({ pool });
  await assert.rejects(() => cr.update(1, { nope: false }), /未知のリマインド/);
  await assert.rejects(() => cr.update(1, { dormant: 'off' }), /真偽値/);
  assert.equal(rows.length, 0);
});

test('OFF にしたあと ON に戻せる', async () => {
  const { pool } = makeCustomerPool();
  const cr = createCustomerReminders({ pool });
  await cr.update(1, { afterVisit: false });
  assert.equal((await cr.get(1)).afterVisit, false);
  await cr.update(1, { afterVisit: true });
  assert.equal((await cr.get(1)).afterVisit, true);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffNotifier, toPlainText } from '../src/notify/staffNotifier.js';
import { createJoinHandler } from '../src/webhook/events/join.js';
import { createLeaveHandler } from '../src/webhook/events/leave.js';
import { createSettings, SETTING_KEYS } from '../src/settings.js';

function makeFakes({ channel = 'slack', groupId = 'Cgroup1', storedGroupId = null } = {}) {
  const slackSent = [];
  const lineSent = [];
  const slack = {
    notify: async (text) => {
      slackSent.push(text);
      return true;
    },
  };
  const lineClient = {
    pushStaff: async (to, text) => {
      lineSent.push({ to, text });
      return { status: 'sent' };
    },
  };
  const store = new Map();
  if (storedGroupId) store.set(SETTING_KEYS.staffLineGroupId, storedGroupId);
  const settings = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => store.set(k, v),
    remove: async (k) => store.delete(k),
    _store: store,
  };
  const config = { staffNotifyChannel: channel, staffLineGroupId: groupId };
  return { slack, lineClient, config, settings, slackSent, lineSent, store };
}

test('デフォルト（slack）は Slack のみに送る', async () => {
  const f = makeFakes({ channel: 'slack' });
  const notifier = createStaffNotifier(f);
  await notifier.notify('テスト通知');
  assert.equal(f.slackSent.length, 1);
  assert.equal(f.lineSent.length, 0);
});

test('line チャネルは LINE グループのみに送る（Slack 記法を変換）', async () => {
  const f = makeFakes({ channel: 'line' });
  const notifier = createStaffNotifier(f);
  await notifier.notify(':calendar: *新規予約*\n顧客: 山田');
  assert.equal(f.slackSent.length, 0);
  assert.equal(f.lineSent.length, 1);
  assert.equal(f.lineSent[0].text, '📅 新規予約\n顧客: 山田');
});

test('DB に保存されたグループ ID が env より優先される', async () => {
  const f = makeFakes({ channel: 'line', groupId: 'Cenv', storedGroupId: 'Cstored' });
  const notifier = createStaffNotifier(f);
  await notifier.notify('通知');
  assert.equal(f.lineSent[0].to, 'Cstored');
});

test('グループ未設定（DB も env もなし）なら送らず false', async () => {
  const f = makeFakes({ channel: 'line', groupId: null });
  const notifier = createStaffNotifier(f);
  const ok = await notifier.notify('通知');
  assert.equal(ok, false);
  assert.equal(f.lineSent.length, 0);
});

test('both は両方に送る', async () => {
  const f = makeFakes({ channel: 'both' });
  const notifier = createStaffNotifier(f);
  await notifier.notify('通知');
  assert.equal(f.slackSent.length, 1);
  assert.equal(f.lineSent.length, 1);
});

test('LINE 送信の失敗は例外を外に漏らさない', async () => {
  const f = makeFakes({ channel: 'line' });
  f.lineClient.pushStaff = async () => {
    throw new Error('LINE API down');
  };
  const notifier = createStaffNotifier(f);
  const ok = await notifier.notify('通知');
  assert.equal(ok, false);
});

test('toPlainText: 絵文字コード・強調・引用・コードブロックを変換する', () => {
  assert.equal(toPlainText(':warning: *要対応*'), '⚠️ 要対応');
  assert.equal(toPlainText('> 引用行'), '引用行');
  assert.equal(toPlainText('```stack trace```'), 'stack trace');
  assert.equal(toPlainText(':unknown_emoji: text'), ' text');
});

// ---- join / leave によるグループ ID の自動設定 ----

function makeJoinFakes({ storedGroupId = null } = {}) {
  const f = makeFakes({ channel: 'both', groupId: null, storedGroupId });
  const replies = [];
  f.lineClient.reply = async (token, messages) => replies.push(messages[0].text);
  const notifier = createStaffNotifier(f);
  return { ...f, replies, notifier };
}

function joinEvent(groupId) {
  return { type: 'join', replyToken: 'r1', source: { type: 'group', groupId } };
}

test('join: 未設定なら自動で通知先に設定して案内を返信する', async () => {
  const f = makeJoinFakes();
  const handler = createJoinHandler({ lineClient: f.lineClient, settings: f.settings, slack: f.notifier });

  await handler(joinEvent('Cnew1'));

  assert.equal(f.store.get(SETTING_KEYS.staffLineGroupId), 'Cnew1');
  assert.match(f.replies[0], /通知先として設定しました/);
  assert.equal(f.slackSent.length, 1, '監査用に既存経路へも通知される');
});

test('join: 設定済みの別グループには切り替えない（乗っ取り防止）', async () => {
  const f = makeJoinFakes({ storedGroupId: 'Coriginal' });
  const handler = createJoinHandler({ lineClient: f.lineClient, settings: f.settings, slack: f.notifier });

  await handler(joinEvent('Chijack'));

  assert.equal(f.store.get(SETTING_KEYS.staffLineGroupId), 'Coriginal', '設定は変わらない');
  assert.match(f.replies[0], /変更していません/);
  assert.equal(f.slackSent.length, 1, '警告が既存経路に飛ぶ');
});

test('join: 同じグループへの再参加は何もしない', async () => {
  const f = makeJoinFakes({ storedGroupId: 'Csame' });
  const handler = createJoinHandler({ lineClient: f.lineClient, settings: f.settings, slack: f.notifier });

  await handler(joinEvent('Csame'));
  assert.equal(f.replies.length, 0);
  assert.equal(f.slackSent.length, 0);
});

test('leave: 通知先グループから退出したら設定をクリアする', async () => {
  const f = makeJoinFakes({ storedGroupId: 'Cgone' });
  const handler = createLeaveHandler({ settings: f.settings, slack: f.notifier });

  await handler({ type: 'leave', source: { type: 'group', groupId: 'Cgone' } });
  assert.equal(f.store.has(SETTING_KEYS.staffLineGroupId), false);
});

test('leave: 別グループからの退出では設定を維持する', async () => {
  const f = makeJoinFakes({ storedGroupId: 'Ckeep' });
  const handler = createLeaveHandler({ settings: f.settings, slack: f.notifier });

  await handler({ type: 'leave', source: { type: 'group', groupId: 'Cother' } });
  assert.equal(f.store.get(SETTING_KEYS.staffLineGroupId), 'Ckeep');
});

// ---- settings（DB アクセス層） ----

test('settings: upsert と削除の SQL が実行される', async () => {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT value/.test(sql)) return { rows: [{ value: 'v1' }] };
      return { rows: [] };
    },
  };
  const settings = createSettings({ pool });

  assert.equal(await settings.get('k'), 'v1');
  await settings.set('k', 'v2');
  await settings.remove('k');

  assert.match(queries[1].sql, /ON CONFLICT \(key\) DO UPDATE/);
  assert.match(queries[2].sql, /DELETE FROM app_settings/);
});

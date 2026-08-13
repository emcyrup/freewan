import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffShiftHandler } from '../src/webhook/events/staffShift.js';

function makeFakes({ staff = null, parsed = { isRequest: false, entries: [] }, link = { ok: false, error: 'invalid_code' } } = {}) {
  const replies = [];
  const notices = [];
  const created = [];
  return {
    replies,
    notices,
    created,
    lineClient: { reply: async (token, messages) => replies.push({ token, text: messages[0].text }) },
    slack: { notify: async (text) => notices.push(text) },
    shiftParser: { parse: async () => parsed },
    shiftService: {
      findStaffByLineUserId: async () => staff,
      linkStaffByCode: async (args) => { created.push(args); return link; },
      createRequests: async (args) => {
        created.push(args);
        return { created: args.entries.map((e) => ({ target_date: e.date, kind: e.kind, start_time: e.startTime, end_time: e.endTime })), replaced: 0 };
      },
    },
  };
}

const userEvent = (text) => ({
  type: 'message',
  replyToken: 'r1',
  source: { type: 'user', userId: 'U-staff' },
  message: { type: 'text', text },
});

test('連携済みスタッフの申請を受け付け、内容を復唱する', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    parsed: { isRequest: true, entries: [{ date: '2026-08-01', kind: 'yukyu', startTime: null, endTime: null, reason: null }] },
  });
  const handler = createStaffShiftHandler({ ...f, now: () => new Date('2026-07-24T01:00:00Z') });

  const handled = await handler(userEvent('8/1 有休お願いします'), '8/1 有休お願いします');

  assert.equal(handled, true, '顧客向けの処理へは渡さない');
  assert.match(f.replies[0].text, /受け付けました/);
  assert.match(f.replies[0].text, /8\/1\(土\) 有休/);
  assert.match(f.replies[0].text, /承認後/);
  assert.equal(f.notices.length, 1, '承認待ちに気付けるよう店長へ通知する');
});

test('未連携（＝顧客）の発言は従来の処理へ渡す', async () => {
  const f = makeFakes({ staff: null });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('ありがとうございました'), 'ありがとうございました');

  assert.equal(handled, false);
  assert.equal(f.replies.length, 0);
});

test('グループでの発言は申請にしない（雑談を拾わないため）', async () => {
  const f = makeFakes({ staff: { id: 3, name: '高橋' } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(
    { type: 'message', replyToken: 'r1', source: { type: 'group', groupId: 'G1', userId: 'U-staff' }, message: { type: 'text', text: '8/1 有休' } },
    '8/1 有休'
  );

  assert.equal(handled, false);
});

test('読み取れない発言には書き方を案内して終わる', async () => {
  const f = makeFakes({ staff: { id: 3, name: '高橋' }, parsed: { isRequest: false, entries: [] } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('お疲れさまです'), 'お疲れさまです');

  assert.equal(handled, true);
  assert.match(f.replies[0].text, /読み取れませんでした/);
  assert.equal(f.notices.length, 0, '申請でないものを店長へ通知しない');
});

test('連携コマンドは未連携でも受け付ける', async () => {
  const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('スタッフ登録 123456'), 'スタッフ登録 123456');

  assert.equal(handled, true);
  assert.equal(f.created[0].code, '123456');
  assert.match(f.replies[0].text, /高橋さん、連携しました/);
});

test('連携コードが無効なら再発行を案内する', async () => {
  const f = makeFakes({ staff: null, link: { ok: false, error: 'invalid_code' } });
  const handler = createStaffShiftHandler(f);

  await handler(userEvent('スタッフ登録 999999'), 'スタッフ登録 999999');

  assert.match(f.replies[0].text, /確認できませんでした/);
});

test('連携コマンドは表記ゆれを吸収する', async () => {
  for (const text of ['スタッフ登録123456', 'スタッフ連携 123456', 'スタッフ登録：123456']) {
    const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
    const handler = createStaffShiftHandler(f);
    assert.equal(await handler(userEvent(text), text), true, text);
  }
});

test('6桁の数字だけの発言は連携コマンドにしない（顧客の誤爆を防ぐ）', async () => {
  const f = makeFakes({ staff: null });
  const handler = createStaffShiftHandler(f);
  assert.equal(await handler(userEvent('123456'), '123456'), false);
});

test('1:1 で名前を送られたら、コードでの登録方法を案内する', async () => {
  const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('スタッフ登録 高橋'), 'スタッフ登録 高橋');

  assert.equal(handled, true, '黙って顧客向けの処理へ落とさない');
  assert.match(f.replies[0].text, /6桁の連携コード/);
  // 名前だけで成りすませないよう、1:1 では名前による連携を行わない
  assert.equal(f.created.length, 0);
});

test('接頭辞なしでコードだけ送っても、発行済みなら連携する', async () => {
  const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('123456'), '123456');

  assert.equal(handled, true);
  assert.equal(f.created[0].code, '123456');
  assert.match(f.replies[0].text, /高橋さん、連携しました/);
});

test('発行済みでない6桁は連携せず、顧客の会話を横取りしない', async () => {
  const f = makeFakes({ staff: null, link: { ok: false, error: 'invalid_code' } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('123456'), '123456');

  assert.equal(handled, false, '従来どおり顧客向けの処理へ渡す');
  assert.equal(f.replies.length, 0);
});

test('連携済みスタッフが6桁を送っても、シフト申請の処理へ進む', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    link: { ok: false, error: 'invalid_code' },
    parsed: { isRequest: false, entries: [] },
  });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('123456'), '123456');

  assert.equal(handled, true);
  assert.match(f.replies[0].text, /読み取れませんでした/, 'コード不一致で処理が逸れない');
});

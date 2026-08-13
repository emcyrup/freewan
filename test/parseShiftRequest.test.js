import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShiftRequestParser } from '../src/ai/parseShiftRequest.js';

// Messages API の応答を模した fetch。content[0].text に JSON 文字列が入る
function makeFetch(payload, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok, status, json: async () => payload };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

const reply = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });

test('有休の申請を日付・区分に分解する', async () => {
  const fetchFn = makeFetch(
    reply({ isRequest: true, entries: [
      { date: '2026-08-01', kind: 'yukyu', startTime: null, endTime: null, reason: '子どもの行事のため' },
    ] })
  );
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });

  const result = await parser.parse({ text: '8/1(土) 有休お願いします。子どもの行事のため', today: '2026-07-24' });

  assert.equal(result.isRequest, true);
  assert.deepEqual(result.entries[0], {
    date: '2026-08-01', kind: 'yukyu', startTime: null, endTime: null, reason: '子どもの行事のため',
  });
  // 相対表現を解決できるよう、今日の日付をモデルに渡している
  assert.match(fetchFn.calls[0].body.system, /今日の日付（JST）: 2026-07-24/);
});

test('時間休は開始・終了の時刻を保持する', async () => {
  const fetchFn = makeFetch(
    reply({ isRequest: true, entries: [
      { date: '2026-07-31', kind: 'jikan', startTime: '10:00', endTime: '12:00', reason: null },
    ] })
  );
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });
  const result = await parser.parse({ text: '7/31 10時から12時まで時間休', today: '2026-07-24' });
  assert.equal(result.entries[0].startTime, '10:00');
  assert.equal(result.entries[0].endTime, '12:00');
});

test('複数日の申請はそのまま複数件として扱う', async () => {
  const fetchFn = makeFetch(
    reply({ isRequest: true, entries: [
      { date: '2026-08-01', kind: 'koukyu', startTime: null, endTime: null, reason: null },
      { date: '2026-08-02', kind: 'koukyu', startTime: null, endTime: null, reason: null },
    ] })
  );
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });
  const result = await parser.parse({ text: '8/1と8/2 休みます', today: '2026-07-24' });
  assert.equal(result.entries.length, 2);
});

test('申請でない発言は申請として扱わない', async () => {
  const fetchFn = makeFetch(reply({ isRequest: false, entries: [] }));
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });
  assert.deepEqual(await parser.parse({ text: 'おはようございます', today: '2026-07-24' }), {
    isRequest: false, entries: [],
  });
});

test('時刻の欠けた時間休は誤った勤怠になるため受け付けない', async () => {
  const fetchFn = makeFetch(
    reply({ isRequest: true, entries: [
      { date: '2026-07-31', kind: 'jikan', startTime: '10:00', endTime: null, reason: null },
    ] })
  );
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });
  assert.equal((await parser.parse({ text: '時間休ください', today: '2026-07-24' })).isRequest, false);
});

test('開始が終了より後の時間休は受け付けない', async () => {
  const fetchFn = makeFetch(
    reply({ isRequest: true, entries: [
      { date: '2026-07-31', kind: 'jikan', startTime: '14:00', endTime: '12:00', reason: null },
    ] })
  );
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });
  assert.equal((await parser.parse({ text: 'x', today: '2026-07-24' })).isRequest, false);
});

test('日付の形式が崩れていたら申請にしない', async () => {
  const fetchFn = makeFetch(
    reply({ isRequest: true, entries: [{ date: '8/1', kind: 'yukyu', startTime: null, endTime: null, reason: null }] })
  );
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });
  assert.equal((await parser.parse({ text: 'x', today: '2026-07-24' })).isRequest, false);
});

test('未知の区分は申請にしない', async () => {
  const fetchFn = makeFetch(
    reply({ isRequest: true, entries: [{ date: '2026-08-01', kind: 'sabotage', startTime: null, endTime: null, reason: null }] })
  );
  const parser = createShiftRequestParser({ apiKey: 'k', fetchFn });
  assert.equal((await parser.parse({ text: 'x', today: '2026-07-24' })).isRequest, false);
});

test('API エラー・拒否・API キー未設定では申請を作らない', async () => {
  const errored = createShiftRequestParser({ apiKey: 'k', fetchFn: makeFetch({}, { ok: false, status: 500 }) });
  assert.equal((await errored.parse({ text: 'x', today: '2026-07-24' })).isRequest, false);

  const refused = createShiftRequestParser({
    apiKey: 'k',
    fetchFn: makeFetch({ stop_reason: 'refusal', content: [{ text: '{}' }] }),
  });
  assert.equal((await refused.parse({ text: 'x', today: '2026-07-24' })).isRequest, false);

  const noKey = createShiftRequestParser({ apiKey: null, fetchFn: makeFetch(reply({ isRequest: true, entries: [] })) });
  assert.equal((await noKey.parse({ text: 'x', today: '2026-07-24' })).isRequest, false);
});

test('壊れた JSON が返っても例外を投げない', async () => {
  const parser = createShiftRequestParser({
    apiKey: 'k',
    fetchFn: makeFetch({ content: [{ text: '{壊れている' }] }),
  });
  assert.equal((await parser.parse({ text: 'x', today: '2026-07-24' })).isRequest, false);
});

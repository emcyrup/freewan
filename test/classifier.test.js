import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollowupClassifier } from '../src/ai/classifyFollowup.js';

function makeFetch(status, body) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchFn, calls };
}

function apiResponse(text) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

test('good / question を正しく返す', async () => {
  for (const label of ['good', 'question']) {
    const { fetchFn } = makeFetch(200, apiResponse(JSON.stringify({ label })));
    const { classify } = createFollowupClassifier({ apiKey: 'key', fetchFn });
    assert.equal(await classify('返信テキスト'), label);
  }
});

test('JSON パース失敗時は concern にフォールバックする', async () => {
  const { fetchFn } = makeFetch(200, apiResponse('これはJSONではありません'));
  const { classify } = createFollowupClassifier({ apiKey: 'key', fetchFn });
  assert.equal(await classify('返信'), 'concern');
});

test('未知のラベルは concern にフォールバックする', async () => {
  const { fetchFn } = makeFetch(200, apiResponse(JSON.stringify({ label: 'neutral' })));
  const { classify } = createFollowupClassifier({ apiKey: 'key', fetchFn });
  assert.equal(await classify('返信'), 'concern');
});

test('API エラー時は concern にフォールバックする', async () => {
  const { fetchFn } = makeFetch(500, { error: 'overloaded' });
  const { classify } = createFollowupClassifier({ apiKey: 'key', fetchFn });
  assert.equal(await classify('返信'), 'concern');
});

test('fetch 自体の失敗も concern にフォールバックする', async () => {
  const fetchFn = async () => {
    throw new Error('network down');
  };
  const { classify } = createFollowupClassifier({ apiKey: 'key', fetchFn });
  assert.equal(await classify('返信'), 'concern');
});

test('API キー未設定なら API を呼ばず concern を返す', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse('{}'));
  const { classify } = createFollowupClassifier({ apiKey: null, fetchFn });
  assert.equal(await classify('返信'), 'concern');
  assert.equal(calls.length, 0);
});

test('リクエストは Haiku + 構造化出力で送られる', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse(JSON.stringify({ label: 'good' })));
  const { classify } = createFollowupClassifier({ apiKey: 'key', fetchFn });
  await classify('調子いいです');

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.deepEqual(body.output_config.format.schema.properties.label.enum, [
    'good',
    'concern',
    'question',
  ]);
  assert.equal(calls[0].init.headers['x-api-key'], 'key');
});

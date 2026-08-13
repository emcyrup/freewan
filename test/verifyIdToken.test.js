import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdTokenVerifier } from '../src/line/verifyIdToken.js';

function makeFetch(status, body) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchFn, calls };
}

test('検証成功で sub を含む payload が返る', async () => {
  const { fetchFn, calls } = makeFetch(200, { sub: 'U123', aud: '1656008674' });
  const verify = createIdTokenVerifier({ channelId: '1656008674', fetchFn });

  const payload = await verify('token-abc');
  assert.equal(payload.sub, 'U123');

  const params = calls[0].init.body;
  assert.equal(params.get('id_token'), 'token-abc');
  assert.equal(params.get('client_id'), '1656008674');
});

test('検証エンドポイントがエラーを返したら例外', async () => {
  const { fetchFn } = makeFetch(400, { error: 'invalid_request', error_description: 'expired' });
  const verify = createIdTokenVerifier({ channelId: 'c', fetchFn });
  await assert.rejects(() => verify('bad'), /expired/);
});

test('sub がない応答は拒否する', async () => {
  const { fetchFn } = makeFetch(200, {});
  const verify = createIdTokenVerifier({ channelId: 'c', fetchFn });
  await assert.rejects(() => verify('t'), /sub/);
});

test('トークンなしは即例外', async () => {
  const { fetchFn, calls } = makeFetch(200, { sub: 'U' });
  const verify = createIdTokenVerifier({ channelId: 'c', fetchFn });
  await assert.rejects(() => verify(null));
  assert.equal(calls.length, 0, 'エンドポイントを呼ばない');
});

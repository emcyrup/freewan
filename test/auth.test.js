import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicAuth, bearerAuth } from '../src/http/auth.js';

function makeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  return res;
}

function run(middleware, headers = {}) {
  const res = makeRes();
  let nextCalled = false;
  middleware({ headers }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

const creds = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

test('basicAuth: 正しい資格情報で通過する', () => {
  const mw = basicAuth({ user: 'admin', password: 'secret' });
  const { nextCalled } = run(mw, { authorization: creds('admin', 'secret') });
  assert.equal(nextCalled, true);
});

test('basicAuth: 誤った資格情報は 401', () => {
  const mw = basicAuth({ user: 'admin', password: 'secret' });
  const { res, nextCalled } = run(mw, { authorization: creds('admin', 'wrong') });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['WWW-Authenticate'], /Basic/);
});

test('basicAuth: ヘッダなしは 401', () => {
  const mw = basicAuth({ user: 'admin', password: 'secret' });
  const { res } = run(mw);
  assert.equal(res.statusCode, 401);
});

test('basicAuth: 資格情報が未設定なら 503（機能無効）', () => {
  const mw = basicAuth({ user: null, password: null });
  const { res, nextCalled } = run(mw, { authorization: creds('a', 'b') });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
});

test('bearerAuth: 正しいトークンで通過する', () => {
  const mw = bearerAuth({ token: 'tok123' });
  const { nextCalled } = run(mw, { authorization: 'Bearer tok123' });
  assert.equal(nextCalled, true);
});

test('bearerAuth: 誤ったトークンは 401、未設定は 503', () => {
  const mw = bearerAuth({ token: 'tok123' });
  assert.equal(run(mw, { authorization: 'Bearer bad' }).res.statusCode, 401);

  const disabled = bearerAuth({ token: null });
  assert.equal(run(disabled, { authorization: 'Bearer tok123' }).res.statusCode, 503);
});

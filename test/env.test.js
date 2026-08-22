import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, loadDotEnv } from '../src/env.js';

test('KEY=VALUE を読める', () => {
  assert.deepEqual(parseEnv('PORT=3000\nTZ=Asia/Tokyo'), { PORT: '3000', TZ: 'Asia/Tokyo' });
});

test('空行とコメント行は飛ばす', () => {
  assert.deepEqual(parseEnv('\n# メモ\n  # 字下げしたメモ\nPORT=3000\n'), { PORT: '3000' });
});

test('値に = が含まれても最初の = だけで区切る', () => {
  assert.deepEqual(parseEnv('DATABASE_URL=postgres://u:p@h/db?a=b'), {
    DATABASE_URL: 'postgres://u:p@h/db?a=b',
  });
});

test('引用符は外す', () => {
  assert.deepEqual(parseEnv(`A="x y"\nB='z#w'`), { A: 'x y', B: 'z#w' });
});

test('二重引用符の中の \\n は改行にする', () => {
  assert.deepEqual(parseEnv('A="1\\n2"'), { A: '1\n2' });
});

test('引用符なしの # 以降はコメント扱い', () => {
  assert.deepEqual(parseEnv('PORT=3000 # 待受ポート'), { PORT: '3000' });
});

test('環境変数名として不正な行は無視する', () => {
  assert.deepEqual(parseEnv('1BAD=x\n=y\nOK=z'), { OK: 'z' });
});

test('既にある環境変数は .env で上書きしない（SEND_MODE=live を握り潰さないため）', () => {
  const env = { SEND_MODE: 'live' };
  loadDotEnv(new URL('./fixtures/sample.env', import.meta.url).pathname, env);
  assert.equal(env.SEND_MODE, 'live');
  assert.equal(env.PORT, '3000');
});

test('.env が無ければ何もしない', () => {
  const env = { A: '1' };
  assert.deepEqual(loadDotEnv('/no/such/file.env', env), { A: '1' });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, looksLikePhone } from '../src/customers/phone.js';

test('ハイフンを除去して正規化する', () => {
  assert.equal(normalizePhone('090-1234-5678'), '09012345678');
});

test('全角数字・全角ハイフンを正規化する', () => {
  assert.equal(normalizePhone('０９０－１２３４－５６７８'), '09012345678');
});

test('空白や括弧を除去する', () => {
  assert.equal(normalizePhone('03 (1234) 5678'), '0312345678');
});

test('+81 表記は先頭 0 に戻す', () => {
  assert.equal(normalizePhone('+81 90-1234-5678'), '09012345678');
  assert.equal(normalizePhone('＋８１９０１２３４５６７８'), '09012345678');
});

test('固定電話（10桁）も受け付ける', () => {
  assert.equal(normalizePhone('03-1234-5678'), '0312345678');
});

test('電話番号でない入力は null', () => {
  assert.equal(normalizePhone('こんにちは'), null);
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('12012345678'), null, '0始まりでないものは拒否');
});

test('looksLikePhone はテキストが電話番号かを判定する', () => {
  assert.equal(looksLikePhone('090-1234-5678'), true);
  assert.equal(looksLikePhone('予約お願いします'), false);
});

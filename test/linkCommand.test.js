import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkCommand, parseBareCode } from '../src/webhook/events/linkCommand.js';

test('基本の書き方をコードとして読み取る', () => {
  assert.deepEqual(parseLinkCommand('スタッフ登録 123456'), { arg: '123456', isCode: true });
});

test('送り方の細かな違いを吸収する', () => {
  // 弾かれると「送ったのに無反応」になり原因にたどり着けないため、広めに受ける
  for (const text of [
    'スタッフ登録123456',
    'スタッフ登録　123456',      // 全角空白
    'スタッフ登録：123456',
    'スタッフ登録: 123456',
    'スタッフ連携 123456',
    'シフト登録 123456',
    '  スタッフ登録 123456  ',   // 前後の空白
    'スタッフ登録 １２３４５６',  // 全角数字
    'スタッフ登録　１２３４５６',
  ]) {
    assert.deepEqual(parseLinkCommand(text), { arg: '123456', isCode: true }, text);
  }
});

test('名前はコードと区別して返す', () => {
  assert.deepEqual(parseLinkCommand('スタッフ登録 高橋'), { arg: '高橋', isCode: false });
});

test('姓名の間の全角空白は半角に寄せる（名前の区切りとしては残す）', () => {
  assert.deepEqual(parseLinkCommand('スタッフ登録 田中　里奈'), { arg: '田中 里奈', isCode: false });
});

test('接頭辞のない発言は連携コマンドにしない（顧客の誤爆を防ぐ）', () => {
  for (const text of ['123456', 'こんにちは', '高橋', '', null, undefined]) {
    assert.equal(parseLinkCommand(text), null, String(text));
  }
});

test('接頭辞だけで中身が無ければコマンドにしない', () => {
  assert.equal(parseLinkCommand('スタッフ登録'), null);
  assert.equal(parseLinkCommand('スタッフ登録 '), null);
});

test('桁数の違う数字はコードとして扱わない', () => {
  assert.deepEqual(parseLinkCommand('スタッフ登録 12345'), { arg: '12345', isCode: false });
  assert.deepEqual(parseLinkCommand('スタッフ登録 1234567'), { arg: '1234567', isCode: false });
});

// ---- 接頭辞なしの数字だけ ----

test('6桁の数字だけをコードとして取り出す（全角・空白まじりも）', () => {
  for (const [text, want] of [
    ['123456', '123456'],
    [' 123456 ', '123456'],
    ['１２３４５６', '123456'],
    ['123 456', '123456'],
  ]) {
    assert.equal(parseBareCode(text), want, text);
  }
});

test('6桁でないものはコードとして扱わない', () => {
  for (const text of ['12345', '1234567', '090-1234-5678', 'こんにちは', 'abc123', '', null]) {
    assert.equal(parseBareCode(text), null, String(text));
  }
});

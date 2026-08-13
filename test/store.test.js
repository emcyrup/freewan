import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadStoreProfile } from '../src/store.js';

test('未設定なら現行店舗の値になる（既存環境の挙動を変えない）', () => {
  const s = loadStoreProfile({});
  assert.equal(s.name, 'ここっとベール');
  assert.equal(s.openTime, '10:00');
  assert.equal(s.closeTime, '19:00');
  assert.deepEqual(s.closedDays, [4]);
  assert.equal(s.closedDayLabel, '木曜');
  assert.match(s.address, /大阪市中央区/);
  assert.equal(s.phone, '06-6947-8211');
});

test('店舗ごとの値で上書きできる', () => {
  const s = loadStoreProfile({
    STORE_NAME: 'サロン ひなた',
    STORE_TAGLINE: 'Dog Salon｜予約・顧客',
    STORE_LOGO: '🐾',
    STORE_OPEN_TIME: '09:30',
    STORE_CLOSE_TIME: '18:00',
    STORE_ADDRESS: '東京都〇〇区1-2-3',
    STORE_PHONE: '03-0000-0000',
  });
  assert.equal(s.name, 'サロン ひなた');
  assert.equal(s.logo, '🐾');
  assert.equal(s.openTime, '09:30');
  assert.equal(s.closeTime, '18:00');
  assert.equal(s.address, '東京都〇〇区1-2-3');
  assert.equal(s.phone, '03-0000-0000');
});

test('定休日は曜日名でも数字でも書ける', () => {
  assert.deepEqual(loadStoreProfile({ STORE_CLOSED_DAYS: '水' }).closedDays, [3]);
  assert.deepEqual(loadStoreProfile({ STORE_CLOSED_DAYS: '水曜' }).closedDays, [3]);
  assert.deepEqual(loadStoreProfile({ STORE_CLOSED_DAYS: '水曜日' }).closedDays, [3]);
  assert.deepEqual(loadStoreProfile({ STORE_CLOSED_DAYS: '3' }).closedDays, [3]);
});

test('定休日は複数指定できる', () => {
  const s = loadStoreProfile({ STORE_CLOSED_DAYS: '火,水' });
  assert.deepEqual(s.closedDays, [2, 3]);
  assert.equal(s.closedDayLabel, '火曜・水曜');
});

test('定休日なしにもできる', () => {
  const s = loadStoreProfile({ STORE_CLOSED_DAYS: ' ' });
  assert.deepEqual(s.closedDays, []);
  assert.equal(s.closedDayLabel, 'なし');
});

test('書き間違いは起動時に落とす（黙って既定値に戻さない）', () => {
  assert.throws(() => loadStoreProfile({ STORE_CLOSED_DAYS: '木曜定休' }), /STORE_CLOSED_DAYS/);
  assert.throws(() => loadStoreProfile({ STORE_CLOSED_DAYS: '7' }), /STORE_CLOSED_DAYS/);
  assert.throws(() => loadStoreProfile({ STORE_OPEN_TIME: '9:30' }), /STORE_OPEN_TIME/);
  assert.throws(() => loadStoreProfile({ STORE_CLOSE_TIME: '25:00' }), /STORE_CLOSE_TIME/);
});

test('開店より前の閉店時刻は受け付けない', () => {
  assert.throws(
    () => loadStoreProfile({ STORE_OPEN_TIME: '19:00', STORE_CLOSE_TIME: '10:00' }),
    /STORE_CLOSE_TIME/
  );
});

test('住所・電話は空文字にすると表示しない（新店舗で未入力のまま出さない）', () => {
  const s = loadStoreProfile({ STORE_ADDRESS: '', STORE_PHONE: '' });
  assert.equal(s.address, '');
  assert.equal(s.phone, '');
});

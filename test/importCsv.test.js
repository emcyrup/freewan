import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toJstIso, convertRow } from '../scripts/import-csv.js';

test('parseCsv: 引用符・カンマ・CRLF・引用符内の改行を扱える', () => {
  const rows = parseCsv('a,b,c\r\n"x,1","say ""hi""","line1\nline2"\r\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['x,1', 'say "hi"', 'line1\nline2'],
  ]);
});

test('toJstIso: スラッシュ区切りの日付と時刻を +09:00 の ISO にする', () => {
  assert.equal(toJstIso('2026/8/1', '14:00'), '2026-08-01T14:00:00+09:00');
  assert.equal(toJstIso('2026-08-01', '9:30'), '2026-08-01T09:30:00+09:00');
  assert.equal(toJstIso('不正', '14:00'), null);
});

test('convertRow: マッピングに従って API 形式へ変換する', () => {
  const mapping = {
    externalIdPrefix: 'epark-',
    columns: {
      external_id: '予約番号',
      customer_name: '氏名',
      phone: '電話番号',
      reserved_date: '予約日',
      reserved_time: '予約時間',
      menu: 'メニュー',
      staff_name: '担当者',
      status: 'ステータス',
    },
    statusMap: { 来店済み: 'visited' },
    defaultStatus: 'confirmed',
  };
  const header = ['予約番号', '氏名', '電話番号', '予約日', '予約時間', 'メニュー', '担当者', 'ステータス'];

  const confirmed = convertRow(
    ['R001', '山田 花子', '090-1234-5678', '2026/08/01', '14:00', 'カット', '佐藤', '予約確定'],
    header,
    mapping
  );
  assert.deepEqual(confirmed, {
    external_id: 'epark-R001',
    customer_name: '山田 花子',
    phone: '090-1234-5678',
    birthday: undefined,
    menu: 'カット',
    staff_name: '佐藤',
    reserved_at: '2026-08-01T14:00:00+09:00',
    status: 'confirmed',
  });

  const visited = convertRow(
    ['R002', '田中', '080-0000-1111', '2026/07/19', '11:00', '', '', '来店済み'],
    header,
    mapping
  );
  assert.equal(visited.status, 'visited', 'statusMap で来店実績に変換される');
  assert.equal(visited.menu, undefined, '空文字は undefined にして API 側デフォルトに任せる');
});

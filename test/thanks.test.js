import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThanksJob, MAX_THANKS_PHOTOS } from '../src/jobs/thanks.js';
import { buildThanksMessages } from '../src/line/messages/thanks.js';

test('お礼テキスト＋写真の画像メッセージになる（opt_out 導線は付けない）', () => {
  const messages = buildThanksMessages({
    customerName: '田中',
    petName: 'マロン',
    photoUrls: ['https://example.com/thanks-media/a.jpg', 'https://example.com/thanks-media/b.jpg'],
  });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].type, 'text');
  assert.match(messages[0].text, /田中様/);
  assert.match(messages[0].text, /マロンちゃん/);
  assert.match(messages[0].text, /ご来店ありがとうございました/);
  assert.equal(messages[1].type, 'image');
  assert.equal(messages[1].originalContentUrl, 'https://example.com/thanks-media/a.jpg');
  assert.equal(messages[1].previewImageUrl, 'https://example.com/thanks-media/a.jpg');
  assert.doesNotMatch(JSON.stringify(messages), /opt_out/, '来店に紐づくお礼なので停止導線なし');
});

test('わんちゃんが未指定でも文面が成立する', () => {
  const messages = buildThanksMessages({ customerName: '田中', petName: null, photoUrls: [] });
  assert.match(messages[0].text, /わんちゃんの本日のお写真/);
});

test('抽出条件: 当日来店（visited）かつ写真ありだけが対象', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  await createThanksJob({ pool, lineClient: {}, publicBaseUrl: 'https://example.com' })();

  assert.match(captured.sql, /status = 'visited'/);
  assert.match(captured.sql, /AT TIME ZONE 'Asia\/Tokyo'/, '当日判定は JST で行う');
  assert.match(captured.sql, /EXISTS \(SELECT 1 FROM visit_photos/, '写真を付けた来店だけ');
  assert.match(captured.sql, /opt_out = false/);
  assert.match(captured.sql, /customer_reminder_settings/, 'お客様ごとの停止を尊重する');
});

test('dedupe_key は予約単位。写真は上限枚数までの公開 URL になる', async () => {
  const delivered = [];
  const files = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'];
  const pool = {
    query: async () => ({
      rows: [
        {
          reservation_id: 42, id: 9, line_user_id: 'U9', name: '田中',
          pet_name: 'マロン', files,
        },
      ],
    }),
  };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'dry_run' };
    },
  };
  const summary = await createThanksJob({
    pool, lineClient, publicBaseUrl: 'https://example.com',
  })();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].dedupeKey, 'thanks:res:42');
  assert.equal(delivered[0].jobType, 'thanks');
  assert.equal(delivered[0].reservationId, 42);
  assert.equal(delivered[0].approvable, true);
  // テキスト1通＋写真4枚（Push の上限5通に収める）
  assert.equal(delivered[0].messages.length, 1 + MAX_THANKS_PHOTOS);
  assert.equal(
    delivered[0].messages[1].originalContentUrl,
    'https://example.com/thanks-media/a.jpg'
  );
  assert.equal(summary.dryRun, 1);
});

test('PUBLIC_BASE_URL 未設定なら対象を数えず空で返す（設定不足で誤送信しない）', async () => {
  let queried = false;
  const pool = { query: async () => { queried = true; return { rows: [] }; } };
  const summary = await createThanksJob({ pool, lineClient: {}, publicBaseUrl: null })();
  assert.equal(queried, false);
  assert.equal(summary.total, 0);
});

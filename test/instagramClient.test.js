import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramClient, splitIntoPosts } from '../src/instagram/client.js';

function makeFetch(responses = {}) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, body: options.body ? Object.fromEntries(options.body) : null });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const value =
      responses[key] ??
      (url.includes('status_code') ? { status_code: 'FINISHED' } : { id: `id-${calls.length}` });
    if (value.__status) {
      return { ok: false, status: value.__status, json: async () => value };
    }
    return { ok: true, status: 200, json: async () => value };
  };
  return { calls, fetchFn };
}

const liveConfig = {
  igPostMode: 'live',
  igUserId: '17840000000000000',
  igAccessToken: 'token-env',
  igGraphBase: 'https://graph.instagram.com',
};

test('dry_run では API を一切呼ばない', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createInstagramClient({
    config: { ...liveConfig, igPostMode: 'dry_run' },
    fetchFn,
  });

  const result = await client.publishPost({
    imageUrls: ['https://example.com/a.jpg'],
    caption: 'テスト',
  });
  assert.equal(result.status, 'dry_run');
  assert.equal(calls.length, 0);
});

test('1枚はコンテナ作成→公開の2段階で投稿される', async () => {
  const { calls, fetchFn } = makeFetch({ media_publish: { id: 'media-1' } });
  const client = createInstagramClient({ config: liveConfig, fetchFn });

  const result = await client.publishPost({
    imageUrls: ['https://example.com/a.jpg'],
    caption: '本日のようす',
  });

  assert.equal(result.status, 'published');
  assert.equal(result.mediaId, 'media-1');
  assert.equal(calls.length, 3, 'コンテナ作成 → 状態確認 → 公開');
  assert.match(calls[0].url, /\/media$/);
  assert.equal(calls[0].body.image_url, 'https://example.com/a.jpg');
  assert.equal(calls[0].body.caption, '本日のようす');
  assert.match(calls[1].url, /status_code/);
  assert.match(calls[2].url, /\/media_publish$/);
});

test('複数枚はカルーセルとして投稿される（各画像→束ね→公開）', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createInstagramClient({ config: liveConfig, fetchFn });

  const urls = ['https://e.com/1.jpg', 'https://e.com/2.jpg', 'https://e.com/3.jpg'];
  await client.publishPost({ imageUrls: urls, caption: 'c' });

  // 3枚のコンテナ + カルーセルコンテナ + 状態確認 + 公開 = 6回
  assert.equal(calls.length, 6);
  assert.equal(calls[0].body.is_carousel_item, 'true');
  assert.equal(calls[3].body.media_type, 'CAROUSEL');
  assert.equal(calls[3].body.children, 'id-1,id-2,id-3');
  assert.equal(calls[3].body.caption, 'c');
  assert.match(calls[4].url, /status_code/);
});

test('11枚以上は publishPost では拒否される（分割は呼び出し側の責務）', async () => {
  const { fetchFn } = makeFetch();
  const client = createInstagramClient({ config: liveConfig, fetchFn });
  await assert.rejects(
    () => client.publishPost({ imageUrls: Array(11).fill('https://e.com/x.jpg'), caption: '' }),
    /10枚まで/
  );
});

test('API エラーはメッセージ付きで投げる', async () => {
  const { fetchFn } = makeFetch({
    media: { __status: 400, error: { message: 'Invalid image' } },
  });
  const client = createInstagramClient({ config: liveConfig, fetchFn });
  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' }),
    /Instagram API 400: Invalid image/
  );
});

test('API エラーには失敗箇所と Meta の詳細コードを含める', async () => {
  const { fetchFn } = makeFetch({
    media: {
      __status: 400,
      error: {
        message: 'Only photos or videos can be accepted as media type.',
        error_user_msg: 'メディアを取得できませんでした',
        code: 9004,
        error_subcode: 2207052,
      },
    },
  });
  const client = createInstagramClient({ config: liveConfig, fetchFn });
  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' }),
    (err) => {
      assert.match(err.message, /Only photos or videos/);
      assert.match(err.message, /メディアを取得できませんでした/);
      assert.match(err.message, /at POST \/17840000000000000\/media/);
      assert.match(err.message, /code=9004\/2207052/);
      return true;
    }
  );
});

test('トークンは DB（settings）を env より優先する', async () => {
  const { calls, fetchFn } = makeFetch();
  const settings = { get: async () => 'token-db', set: async () => {} };
  const client = createInstagramClient({ config: liveConfig, settings, fetchFn });

  await client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' });
  assert.equal(calls[0].body.access_token, 'token-db');
});

test('refreshTokenIfNeeded: 前回から7日未満なら延長しない', async () => {
  const { calls, fetchFn } = makeFetch();
  const store = new Map([
    ['ig_access_token', 't'],
    ['ig_token_refreshed_at', new Date().toISOString()],
  ]);
  const settings = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v) };
  const client = createInstagramClient({ config: liveConfig, settings, fetchFn });

  const result = await client.refreshTokenIfNeeded();
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 0);
});

test('refreshTokenIfNeeded: 7日経過で延長し、新トークンを保存する', async () => {
  const { calls, fetchFn } = makeFetch({ refresh_access_token: { access_token: 'new-token' } });
  const store = new Map([
    ['ig_access_token', 'old-token'],
    ['ig_token_refreshed_at', new Date(Date.now() - 8 * 86_400_000).toISOString()],
  ]);
  const settings = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v) };
  const client = createInstagramClient({ config: liveConfig, settings, fetchFn });

  const result = await client.refreshTokenIfNeeded();
  assert.equal(result.refreshed, true);
  assert.equal(store.get('ig_access_token'), 'new-token');
  assert.match(calls[0].url, /refresh_access_token/);
  assert.match(calls[0].url, /old-token/);
});

// ---- 分割 ----

test('splitIntoPosts: 10枚以下は1投稿でキャプションそのまま', () => {
  const parts = splitIntoPosts(['a', 'b'], 'こんにちは');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].files, ['a', 'b']);
  assert.equal(parts[0].caption, 'こんにちは');
});

test('splitIntoPosts: 11枚以上は2投稿に分割し、2件目に「つづき」を追記する', () => {
  const files = Array.from({ length: 14 }, (_, i) => `f${i}`);
  const parts = splitIntoPosts(files, '本日のようす');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].files.length, 10);
  assert.equal(parts[1].files.length, 4);
  assert.equal(parts[0].caption, '本日のようす');
  assert.equal(parts[1].caption, '本日のようす\n\nつづき（2/2）');
});

test('IG_USER_ID 未設定なら me で投稿する（トークンがアカウントを特定する）', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createInstagramClient({
    config: { ...liveConfig, igUserId: null },
    fetchFn,
  });

  await client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' });
  assert.match(calls[0].url, /\/me\/media$/);
  assert.match(calls[2].url, /\/me\/media_publish$/);
});

// ---- コンテナ処理待ち ----

test('処理中（IN_PROGRESS）の間は待ち、FINISHED になってから公開する', async () => {
  const statuses = ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'];
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push(url);
    if (url.includes('status_code')) {
      return { ok: true, status: 200, json: async () => ({ status_code: statuses.shift() }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
  };
  const client = createInstagramClient({ config: liveConfig, fetchFn, sleepFn: async () => {} });

  const result = await client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' });
  assert.equal(result.status, 'published');
  assert.equal(calls.filter((u) => u.includes('status_code')).length, 3);
  assert.ok(calls[calls.length - 1].includes('media_publish'), '公開は FINISHED の後');
});

test('画像処理が ERROR になったら公開せず、原因つきで失敗する', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('status_code')) {
      return { ok: true, status: 200, json: async () => ({ status_code: 'ERROR' }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'x' }) };
  };
  const client = createInstagramClient({ config: liveConfig, fetchFn, sleepFn: async () => {} });

  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' }),
    /画像の処理に失敗/
  );
  assert.ok(!calls.some((u) => u.includes('media_publish')), '公開 API は呼ばない');
});

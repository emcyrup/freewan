import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadsClient, MAX_TEXT } from '../src/threads/client.js';

function makeFetch(responses = {}) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, body: options.body ? Object.fromEntries(options.body) : null });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const value =
      responses[key] ?? (url.includes('fields=status') ? { status: 'FINISHED' } : { id: `id-${calls.length}` });
    if (value.__status) return { ok: false, status: value.__status, json: async () => value };
    return { ok: true, status: 200, json: async () => value };
  };
  return { calls, fetchFn };
}

const liveConfig = {
  threadsPostMode: 'live',
  threadsUserId: '9876543210',
  threadsAccessToken: 'token-env',
  threadsGraphBase: 'https://graph.threads.net',
};

const noSleep = async () => {};

test('dry_run では API を一切呼ばない', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createThreadsClient({
    config: { ...liveConfig, threadsPostMode: 'dry_run' },
    fetchFn,
    sleepFn: noSleep,
  });

  const result = await client.publishPost({ imageUrls: ['https://example.com/a.jpg'], caption: 'テスト' });
  assert.equal(result.status, 'dry_run');
  assert.equal(calls.length, 0);
});

test('1枚は単体の画像投稿として公開される', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createThreadsClient({ config: liveConfig, fetchFn, sleepFn: noSleep });

  const result = await client.publishPost({ imageUrls: ['https://example.com/a.jpg'], caption: '本文' });
  assert.equal(result.status, 'published');

  const posts = calls.filter((c) => c.body);
  assert.equal(posts.length, 2); // コンテナ作成 → 公開
  assert.equal(posts[0].body.media_type, 'IMAGE');
  assert.equal(posts[0].body.image_url, 'https://example.com/a.jpg');
  assert.equal(posts[0].body.text, '本文');
  assert.match(posts[1].url, /threads_publish/);
});

test('複数枚はカルーセルとして公開される', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createThreadsClient({ config: liveConfig, fetchFn, sleepFn: noSleep });

  await client.publishPost({
    imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    caption: '2枚',
  });

  const posts = calls.filter((c) => c.body);
  assert.equal(posts[0].body.is_carousel_item, 'true');
  assert.equal(posts[1].body.is_carousel_item, 'true');
  assert.equal(posts[2].body.media_type, 'CAROUSEL');
  assert.equal(posts[2].body.children.split(',').length, 2);
  assert.equal(posts[2].body.text, '2枚');
});

test('20枚を超えると投稿しない', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createThreadsClient({ config: liveConfig, fetchFn, sleepFn: noSleep });
  await assert.rejects(
    () => client.publishPost({ imageUrls: Array(21).fill('https://example.com/a.jpg'), caption: '' }),
    /20枚まで/
  );
  assert.equal(calls.length, 0);
});

test('本文は上限で切り詰める（長すぎて投稿ごと失敗させない）', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createThreadsClient({ config: liveConfig, fetchFn, sleepFn: noSleep });

  await client.publishPost({ imageUrls: ['https://example.com/a.jpg'], caption: 'あ'.repeat(600) });
  const posts = calls.filter((c) => c.body);
  assert.equal(posts[0].body.text.length, MAX_TEXT);
});

test('コンテナ処理が ERROR なら公開しない', async () => {
  const { calls, fetchFn } = makeFetch({ 'fields=status': { status: 'ERROR', error_message: '画像を取得できません' } });
  const client = createThreadsClient({ config: liveConfig, fetchFn, sleepFn: noSleep });

  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://example.com/a.jpg'], caption: '' }),
    /画像の処理に失敗/
  );
  assert.equal(calls.filter((c) => c.url.includes('threads_publish')).length, 0);
});

test('トークン未設定なら分かるエラーになる', async () => {
  const { fetchFn } = makeFetch();
  const client = createThreadsClient({
    config: { ...liveConfig, threadsAccessToken: null },
    fetchFn,
    sleepFn: noSleep,
  });
  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://example.com/a.jpg'], caption: '' }),
    /アクセストークンが未設定/
  );
});

test('DB に保存されたトークンを env より優先する', async () => {
  const { calls, fetchFn } = makeFetch();
  const store = new Map([['threads_access_token', 'token-db']]);
  const client = createThreadsClient({
    config: liveConfig,
    settings: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    fetchFn,
    sleepFn: noSleep,
  });

  await client.publishPost({ imageUrls: ['https://example.com/a.jpg'], caption: '' });
  assert.equal(calls[0].body.access_token, 'token-db');
});

test('延長間隔が空いていなければトークンを延長しない', async () => {
  const { calls, fetchFn } = makeFetch();
  const store = new Map([
    ['threads_access_token', 'token-db'],
    ['threads_token_refreshed_at', new Date().toISOString()],
  ]);
  const client = createThreadsClient({
    config: liveConfig,
    settings: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    fetchFn,
    sleepFn: noSleep,
  });

  const result = await client.refreshTokenIfNeeded();
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 0);
});

test('期間が空いていればトークンを延長して保存する', async () => {
  const { fetchFn } = makeFetch({ refresh_access_token: { access_token: 'token-new' } });
  const store = new Map([
    ['threads_access_token', 'token-db'],
    ['threads_token_refreshed_at', new Date(Date.now() - 30 * 86_400_000).toISOString()],
  ]);
  const client = createThreadsClient({
    config: liveConfig,
    settings: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) },
    fetchFn,
    sleepFn: noSleep,
  });

  const result = await client.refreshTokenIfNeeded();
  assert.equal(result.refreshed, true);
  assert.equal(store.get('threads_access_token'), 'token-new');
});

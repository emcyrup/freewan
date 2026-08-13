import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnsPublisher } from '../src/jobs/snsPublisher.js';

function makeFakes({ post = { id: 1, caption: 'c' }, photos = ['a'.repeat(24) + '.jpg'] } = {}) {
  const queries = [];
  const published = [];
  const notifications = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SET status = 'publishing'/.test(sql)) {
        return { rows: post ? [post] : [] };
      }
      if (/SELECT file FROM sns_photos/.test(sql)) {
        return { rows: photos.map((f) => ({ file: f })) };
      }
      if (/WHERE status = 'scheduled' AND scheduled_at/.test(sql)) {
        return { rows: post ? [{ id: post.id }] : [] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const instagram = {
    publishPost: async (args) => {
      published.push({ ...args, via: 'instagram' });
      return { status: 'published', mediaId: `m-${published.length}` };
    },
  };
  const threads = {
    publishPost: async (args) => {
      published.push({ ...args, via: 'threads' });
      return { status: 'published', mediaId: `t-${published.length}` };
    },
  };
  const slack = { notify: async (text) => notifications.push(text) };
  const config = { publicBaseUrl: 'https://example.com' };
  return { pool, instagram, threads, slack, config, queries, published, notifications };
}

test('公開 URL を組み立てて投稿し、published へ更新する', async () => {
  const f = makeFakes();
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'published');
  assert.match(f.published[0].imageUrls[0], /^https:\/\/example\.com\/sns-media\/a{24}\.jpg$/);

  const update = f.queries.find((q) => /SET status = \$2, published_at/.test(q.sql));
  assert.equal(update.params[1], 'published');
  assert.equal(update.params[2], 'm-1');
});

test('11枚以上は2回に分けて投稿され、media_ids が両方記録される', async () => {
  const photos = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(24, '0')}.jpg`.slice(-28));
  const f = makeFakes({ photos: Array.from({ length: 12 }, (_, i) => 'b'.repeat(24) + '.jpg') });
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.parts, 2);
  assert.equal(f.published.length, 2);
  assert.equal(f.published[0].imageUrls.length, 10);
  assert.equal(f.published[1].imageUrls.length, 2);
  assert.match(f.published[1].caption, /つづき（2\/2）/);

  const update = f.queries.find((q) => /SET status = \$2, published_at/.test(q.sql));
  assert.equal(update.params[2], 'm-1,m-2');
  void photos;
});

test('dry_run の結果は published ではなく dry_run として記録する', async () => {
  const f = makeFakes();
  f.instagram.publishPost = async () => ({ status: 'dry_run' });
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.status, 'dry_run');
  const update = f.queries.find((q) => /SET status = \$2, published_at/.test(q.sql));
  assert.equal(update.params[1], 'dry_run');
});

test('投稿失敗は failed に更新し、スタッフへ通知する', async () => {
  const f = makeFakes();
  f.instagram.publishPost = async () => {
    throw new Error('Instagram API 400: Invalid image');
  };
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, false);
  const update = f.queries.find((q) => /SET status = 'failed'/.test(q.sql));
  assert.match(update.params[1], /Invalid image/);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /Instagram 投稿に失敗/);
});

test('他プロセスが処理中（claim できない）なら何もしない', async () => {
  const f = makeFakes({ post: null });
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_publishable');
  assert.equal(f.published.length, 0);
});

test('publicBaseUrl 未設定では投稿せず failed にする', async () => {
  const f = makeFakes();
  f.config.publicBaseUrl = null;
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, false);
  assert.match(result.error, /PUBLIC_BASE_URL/);
  assert.equal(f.published.length, 0);
});

test('platform=threads はスレッズ側のクライアントへ渡り、分割しない', async () => {
  const f = makeFakes({
    post: { id: 9, caption: 'スレッズ本文', platform: 'threads' },
    photos: Array.from({ length: 12 }, () => 'c'.repeat(24) + '.jpg'),
  });
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(9);
  assert.equal(result.ok, true);
  assert.equal(result.parts, 1);
  assert.equal(f.published.length, 1);
  assert.equal(f.published[0].via, 'threads');
  assert.equal(f.published[0].imageUrls.length, 12);
});

test('platform 未設定の既存行は Instagram として扱う', async () => {
  const f = makeFakes({ post: { id: 3, caption: 'c' } });
  const publisher = createSnsPublisher(f);

  await publisher.publishOne(3);
  assert.equal(f.published[0].via, 'instagram');
});

test('スレッズ未設定なら失敗として記録し、Instagram 投稿は巻き込まない', async () => {
  const f = makeFakes({ post: { id: 4, caption: 'c', platform: 'threads' } });
  const publisher = createSnsPublisher({ ...f, threads: null });

  const result = await publisher.publishOne(4);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'platform_unavailable');
  assert.equal(f.published.length, 0);
  const failed = f.queries.find((q) => /SET status = 'failed'/.test(q.sql));
  assert.match(failed.params[1], /スレッズ/);
});

test('スレッズ投稿の失敗通知にはスレッズと出る', async () => {
  const f = makeFakes({ post: { id: 5, caption: 'c', platform: 'threads' } });
  const publisher = createSnsPublisher({
    ...f,
    threads: { publishPost: async () => { throw new Error('API 落ち'); } },
  });

  await publisher.publishOne(5);
  assert.match(f.notifications[0], /スレッズ 投稿に失敗/);
});

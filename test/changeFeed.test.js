import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createChangeFeed } from '../src/http/changeFeed.js';

// 実際にポートを開いて確かめる（SSE はヘッダとストリームの両方が揃って初めて動くため）
async function withFeed(fn, { heartbeatMs = 200 } = {}) {
  const feed = createChangeFeed({ heartbeatMs });
  const app = express();
  app.get('/events', (req, res) => feed.subscribe(req, res));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(feed, `http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

/** ストリームから文字が届くまで読む（届かないままテストが止まらないよう時間で打ち切る） */
async function readFor(res, ms) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const race = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ timeout: true }), until - Date.now())),
    ]);
    if (race.timeout || race.done) break;
    out += dec.decode(race.value);
  }
  await reader.cancel().catch(() => {});
  return out;
}

test('SSE として繋がり、プロキシに溜め込まれない指定が入る', async () => {
  await withFeed(async (feed, base) => {
    const res = await fetch(`${base}/events`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    assert.match(res.headers.get('cache-control'), /no-cache/);
    // これが無いとリバースプロキシに溜められ、即時に届かなくなる
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    await res.body.cancel();
  });
});

test('publish した変更が、繋いでいる端末へ届く', async () => {
  await withFeed(async (feed, base) => {
    const res = await fetch(`${base}/events`);
    // 購読が登録されてから流す
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(feed.size(), 1);
    feed.publish('admin');

    const text = await readFor(res, 500);
    assert.match(text, /data: /);
    const line = text.split('\n').find((l) => l.startsWith('data: '));
    const payload = JSON.parse(line.slice('data: '.length));
    assert.equal(payload.topic, 'admin', '何が変わったかだけを送る');
    assert.ok(payload.at > 0);
    assert.doesNotMatch(text, /customer|line_user/i, '中身は送らない（端末側が読み直す）');
  });
});

test('切断された端末は購読から外れる', async () => {
  await withFeed(async (feed, base) => {
    const res = await fetch(`${base}/events`);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(feed.size(), 1);

    await res.body.cancel();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(feed.size(), 0, '残しておくと書き込み先が溜まり続ける');
  });
});

test('無通信が続いても切られないよう合図を送り続ける', async () => {
  await withFeed(async (feed, base) => {
    const res = await fetch(`${base}/events`);
    const text = await readFor(res, 600);
    // ": ping" はコメント行。イベントとしては扱われないが接続は保たれる
    assert.match(text, /: ping/);
  }, { heartbeatMs: 100 });
});

test('繋いでいる端末が無くても publish は落ちない', async () => {
  await withFeed(async (feed) => {
    assert.equal(feed.size(), 0);
    feed.publish('admin');   // 例外にならないこと
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createAdminRouter } from '../src/http/adminRoutes.js';
import { MAX_THANKS_PHOTOS } from '../src/jobs/thanks.js';

// visit_photos の中身だけを持つ最小の pool
function makePool({ photos = [], reservationExists = true } = {}) {
  const rows = [...photos];
  let nextId = 100;
  return {
    rows,
    pool: {
      query: async (sql, params) => {
        if (/SELECT 1 FROM reservations/.test(sql)) {
          return { rows: reservationExists ? [{ '?column?': 1 }] : [] };
        }
        if (/SELECT id, file FROM visit_photos/.test(sql)) {
          return { rows: rows.filter((r) => r.reservation_id === params[0]) };
        }
        if (/count\(\*\)::int AS n FROM visit_photos/.test(sql)) {
          return { rows: [{ n: rows.filter((r) => r.reservation_id === params[0]).length }] };
        }
        if (/INSERT INTO visit_photos/.test(sql)) {
          const row = { id: nextId++, reservation_id: params[0], file: params[1], sort_order: params[2] };
          rows.push(row);
          return { rows: [{ id: row.id }] };
        }
        if (/DELETE FROM visit_photos/.test(sql)) {
          const i = rows.findIndex((r) => r.id === params[0] && r.reservation_id === params[1]);
          if (i === -1) return { rows: [] };
          const [gone] = rows.splice(i, 1);
          return { rows: [{ file: gone.file }] };
        }
        return { rows: [] };
      },
    },
  };
}

async function withServer({ pool, thanksDataDir }, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({
    pool, reservationService: {}, lineClient: {}, config: {}, thanksDataDir,
  }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/admin`);
  } finally {
    server.close();
  }
}

const jpeg = (n = 64) => {
  const b = Buffer.alloc(n, 7);
  b[0] = 0xff; b[1] = 0xd8;   // JPEG のマジックバイト
  return b;
};
const upload = (base, id, body) =>
  fetch(`${base}/reservations/${id}/photos`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body,
  });

test('写真を上げるとランダム名で保存され、一覧に出る', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'visit-photos-'));
  const { pool, rows } = makePool();
  await withServer({ pool, thanksDataDir: dir }, async (base) => {
    const res = await upload(base, 42, jpeg());
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.match(body.file, /^[0-9a-f]{24}\.jpg$/, '推測できない名前で保存する');

    const files = await readdir(dir);
    assert.deepEqual(files, [body.file], '実ファイルも書かれている');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reservation_id, 42);

    const list = await (await fetch(`${base}/reservations/42/photos`)).json();
    assert.equal(list.photos.length, 1);
    assert.equal(list.max, MAX_THANKS_PHOTOS);
  });
});

test('JPEG でないものは受け付けない（ファイルも作らない）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'visit-photos-'));
  const { pool, rows } = makePool();
  await withServer({ pool, thanksDataDir: dir }, async (base) => {
    const res = await upload(base, 42, Buffer.from('<html>not an image</html>'));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_jpeg' });
    assert.equal(rows.length, 0);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('存在しない予約には付けられない', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'visit-photos-'));
  const { pool } = makePool({ reservationExists: false });
  await withServer({ pool, thanksDataDir: dir }, async (base) => {
    const res = await upload(base, 999, jpeg());
    assert.equal(res.status, 404);
  });
});

test('Push の上限に収まるよう、1件の来店につき4枚まで', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'visit-photos-'));
  const { pool } = makePool();
  await withServer({ pool, thanksDataDir: dir }, async (base) => {
    for (let i = 0; i < MAX_THANKS_PHOTOS; i++) {
      assert.equal((await upload(base, 42, jpeg())).status, 200);
    }
    const res = await upload(base, 42, jpeg());
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'too_many_photos' });
  });
});

test('削除は自分の予約の写真だけ。ファイルも消える', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'visit-photos-'));
  const { pool } = makePool();
  await withServer({ pool, thanksDataDir: dir }, async (base) => {
    const { id } = await (await upload(base, 42, jpeg())).json();

    const other = await fetch(`${base}/reservations/7/photos/${id}`, { method: 'DELETE' });
    assert.equal(other.status, 404, '別の予約からは消せない');
    assert.equal((await readdir(dir)).length, 1);

    const mine = await fetch(`${base}/reservations/42/photos/${id}`, { method: 'DELETE' });
    assert.equal(mine.status, 200);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('写真置き場が用意されていない環境では機能ごと止める', async () => {
  const { pool } = makePool();
  await withServer({ pool, thanksDataDir: null }, async (base) => {
    const res = await fetch(`${base}/reservations/42/photos`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'not_configured' });
  });
});

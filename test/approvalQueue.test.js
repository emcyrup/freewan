import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalQueue } from '../src/approvalQueue.js';

function makeFakes({ mode = null, pendingRow = null } = {}) {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT \* FROM pending_deliveries WHERE id/.test(sql)) {
        return { rows: pendingRow ? [pendingRow] : [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT INTO pending_deliveries/.test(sql)) return { rows: [{ id: 31 }] };
      return { rows: [] };
    },
  };
  const settings = {
    get: async () => mode,
    set: async (k, v) => queries.push({ set: [k, v] }),
  };
  const delivered = [];
  const deliver = async (args) => {
    delivered.push(args);
    return { status: 'sent' };
  };
  return { pool, settings, deliver, delivered, queries };
}

test('承認モードの既定は auto。manual を保存すると isManual が true', async () => {
  const f = makeFakes();
  const q = createApprovalQueue(f);
  assert.equal(await q.getMode(), 'auto');
  assert.equal(await q.isManual(), false);

  const f2 = makeFakes({ mode: 'manual' });
  const q2 = createApprovalQueue(f2);
  assert.equal(await q2.isManual(), true);
});

test('queue: 同じ顧客×ジョブの承認待ちは1件まで（部分ユニークで防ぐ）', async () => {
  const f = makeFakes();
  const q = createApprovalQueue(f);
  const r = await q.queue({
    customerId: 7, lineUserId: 'U7', jobType: 'dormant',
    dedupeKey: 'dormant:cust:7:2026-08-15', messages: [{ type: 'text', text: 'x' }],
  });
  assert.equal(r.status, 'queued');
  const insert = f.queries.find((x) => /INSERT INTO pending_deliveries/.test(x.sql));
  assert.match(insert.sql, /ON CONFLICT \(job_type, customer_id\) WHERE status = 'pending' DO NOTHING/);
});

test('承認すると保存された内容そのままで deliver され、approvable は付かない', async () => {
  const row = {
    id: 5, job_type: 'ticketNudge', customer_id: 9, reservation_id: null,
    line_user_id: 'U9', dedupe_key: 'ticket_nudge:cust:9:2026-08-15',
    messages: [{ type: 'flex', altText: '回数券の残り回数のお知らせ' }],
    status: 'pending',
  };
  const f = makeFakes({ pendingRow: row });
  const q = createApprovalQueue(f);

  const r = await q.decide(5, true);
  assert.deepEqual(r, { ok: true, status: 'approved', send: 'sent' });
  assert.equal(f.delivered.length, 1);
  assert.equal(f.delivered[0].dedupeKey, row.dedupe_key, '元の dedupe で二重送信も防がれる');
  assert.equal(f.delivered[0].approvable, undefined, '承認後の送信は再びキューに入らない');
});

test('見送りは deliver を呼ばない', async () => {
  const row = {
    id: 6, job_type: 'dormant', customer_id: 7, reservation_id: null,
    line_user_id: 'U7', dedupe_key: 'k', messages: [], status: 'pending',
  };
  const f = makeFakes({ pendingRow: row });
  const q = createApprovalQueue(f);

  const r = await q.decide(6, false);
  assert.deepEqual(r, { ok: true, status: 'rejected' });
  assert.equal(f.delivered.length, 0);
});

test('存在しない・処理済みの承認待ちは not_found', async () => {
  const f = makeFakes();
  const q = createApprovalQueue(f);
  assert.deepEqual(await q.decide(999, true), { ok: false, error: 'not_found' });
});

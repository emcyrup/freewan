// リマインドの「スタッフ確認付き送信」。
//
// 店舗設定（app_settings の reminder_approval）を manual にすると、日次ジョブの配信は
// 送信されずに pending_deliveries へ積まれ、管理画面で承認されたものだけが送信される。
// 試験運用（live 切り替え直後）に文面と対象をスタッフの目で確かめるための仕組みで、
// 予約確定連絡などの取引上の通知（approvable を付けない送信）は対象外。
//
// 承認時の実送信も必ず line/client.js の deliver を通す。SEND_MODE の3段階ガードと
// message_logs の dedupe はそのまま効く（承認しても dry_run なら送信されない）。
import { SETTING_KEYS } from './settings.js';

export function createApprovalQueue({ pool, settings, deliver }) {
  async function getMode() {
    const raw = await settings.get(SETTING_KEYS.reminderApproval).catch(() => null);
    return raw === 'manual' ? 'manual' : 'auto';
  }

  async function setMode(mode) {
    if (!['auto', 'manual'].includes(mode)) throw new Error('mode は auto / manual のどちらかです');
    await settings.set(SETTING_KEYS.reminderApproval, mode);
    return mode;
  }

  /** ジョブ側の判定。設定を読めないときは auto（配信が黙って止まる方が危ない） */
  async function isManual() {
    try {
      return (await getMode()) === 'manual';
    } catch (err) {
      console.error(`[approval] 設定の取得に失敗したため自動送信します: ${err.message}`);
      return false;
    }
  }

  /** 承認待ちに積む。同じ顧客×ジョブの pending が既にあれば増やさない */
  async function queue({ customerId, lineUserId, jobType, dedupeKey, reservationId = null, messages }) {
    const { rows } = await pool.query(
      `INSERT INTO pending_deliveries
         (job_type, customer_id, reservation_id, line_user_id, dedupe_key, messages)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (job_type, customer_id) WHERE status = 'pending' DO NOTHING
       RETURNING id`,
      [jobType, customerId, reservationId, lineUserId, dedupeKey, JSON.stringify(messages)]
    );
    return { status: 'queued', id: rows[0]?.id ?? null, duplicate: rows.length === 0 };
  }

  /** 承認待ちの一覧（管理画面用）。本文の要約は altText から出す */
  async function list() {
    const { rows } = await pool.query(
      `SELECT pd.id, pd.job_type, pd.customer_id, pd.created_at,
              pd.messages->0->>'altText' AS preview,
              pd.messages AS messages,
              c.name AS customer_name
       FROM pending_deliveries pd
       JOIN customers c ON c.id = pd.customer_id
       WHERE pd.status = 'pending'
       ORDER BY pd.created_at, pd.id`
    );
    return rows;
  }

  /**
   * 承認（approve=true）または見送り（false）。
   * 承認は deliver（approvable なし）で即時送信する。送信失敗は failed として残し、
   * 一覧から消えたのに届いていない、という見えない失敗を作らない。
   */
  async function decide(id, approve) {
    const client = await pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM pending_deliveries WHERE id = $1 AND status = 'pending' FOR UPDATE`,
        [id]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'not_found' };
      }
      row = rows[0];
      await client.query(
        `UPDATE pending_deliveries SET status = $2, decided_at = now() WHERE id = $1`,
        [id, approve ? 'approved' : 'rejected']
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (!approve) return { ok: true, status: 'rejected' };

    const result = await deliver({
      customerId: row.customer_id,
      lineUserId: row.line_user_id,
      jobType: row.job_type,
      dedupeKey: row.dedupe_key,
      reservationId: row.reservation_id ?? undefined,
      messages: row.messages,
    });
    if (result.status === 'failed') {
      await pool.query(
        `UPDATE pending_deliveries SET status = 'failed', error = $2 WHERE id = $1`,
        [id, result.error ?? 'unknown']
      );
    }
    return { ok: true, status: 'approved', send: result.status };
  }

  /** 一括承認。1件の失敗で残りを止めない */
  async function approveAll() {
    const items = await list();
    const out = { total: items.length, sent: 0, failed: 0 };
    for (const item of items) {
      try {
        const r = await decide(item.id, true);
        if (r.ok && r.send !== 'failed') out.sent++;
        else out.failed++;
      } catch (err) {
        console.error(`[approval] 一括承認で失敗 id=${item.id}: ${err.message}`);
        out.failed++;
      }
    }
    return out;
  }

  return { getMode, setMode, isManual, queue, list, decide, approveAll };
}

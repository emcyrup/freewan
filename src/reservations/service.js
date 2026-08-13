// 予約書き込みのアダプタ層。上流（外部 SaaS / 管理画面の手入力）が何であっても
// 必ずここを経由して reservations に入れる。上流を差し替えてもここから下は作り直さない。
import { normalizePhone } from '../customers/phone.js';
import { formatJstDateTime } from '../util/jst.js';
import {
  buildConfirmedMessage,
  buildDeclinedMessage,
} from '../line/messages/reservationStatus.js';

// 顧客が同時に抱えられる承認待ちリクエストの上限（連投の抑止）
const MAX_PENDING_REQUESTS = 3;
// これより先の日時は受け付けない
const MAX_DAYS_AHEAD = 180;

export function createReservationService({ pool, slack, lineClient = null }) {
  async function findOrCreateStaff(client, staffName) {
    if (!staffName) return null;
    const { rows } = await client.query(
      `SELECT id FROM staff WHERE name = $1 AND active = true`,
      [staffName]
    );
    if (rows.length > 0) return rows[0].id;
    const inserted = await client.query(
      `INSERT INTO staff (name) VALUES ($1) RETURNING id`,
      [staffName]
    );
    return inserted.rows[0].id;
  }

  async function notifyNewReservation({ customerName, reservedAt, menu, staffName }) {
    await slack.notify(
      `:calendar: *新規予約*\n顧客: ${customerName}\n日時: ${formatJstDateTime(new Date(reservedAt))}\n` +
        `メニュー: ${menu ?? '未設定'}\n担当: ${staffName ?? '未定'}`
    );
  }

  /** visited になった予約の来店日を customers.last_visit_at に反映する（後退はさせない） */
  async function touchLastVisit(client, customerId, reservedAt) {
    await client.query(
      `UPDATE customers
       SET last_visit_at = GREATEST(
             COALESCE(last_visit_at, '1970-01-01'::date),
             ($2::timestamptz AT TIME ZONE 'Asia/Tokyo')::date
           ),
           updated_at = now()
       WHERE id = $1`,
      [customerId, reservedAt]
    );
  }

  /**
   * 外部予約システムからの取り込み。external_id で冪等に upsert する。
   * 顧客は電話番号で突合し、いなければ新規作成（line_user_id には触らない）。
   */
  async function upsertExternal({
    externalId,
    customerName,
    phone,
    birthday,
    menu,
    staffName,
    reservedAt,
    status = 'confirmed',
  }) {
    if (!externalId) return { ok: false, error: 'external_id_required' };
    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) return { ok: false, error: 'invalid_phone' };
    if (!customerName?.trim()) return { ok: false, error: 'invalid_name' };
    if (!reservedAt || Number.isNaN(Date.parse(reservedAt))) {
      return { ok: false, error: 'invalid_reserved_at' };
    }

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');

      const { rows: byPhone } = await client.query(
        `SELECT id, name FROM customers WHERE phone_norm = $1 FOR UPDATE`,
        [phoneNorm]
      );
      let customerId;
      if (byPhone.length > 0) {
        customerId = byPhone[0].id;
      } else {
        const inserted = await client.query(
          `INSERT INTO customers (name, phone_norm, birthday) VALUES ($1, $2, $3) RETURNING id`,
          [customerName.trim(), phoneNorm, birthday || null]
        );
        customerId = inserted.rows[0].id;
      }

      const staffId = await findOrCreateStaff(client, staffName);

      // xmax = 0 なら INSERT（新規）、そうでなければ UPDATE（更新）
      const { rows } = await client.query(
        `INSERT INTO reservations (customer_id, staff_id, menu, reserved_at, status, external_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (external_id) DO UPDATE
           SET customer_id = EXCLUDED.customer_id,
               staff_id = EXCLUDED.staff_id,
               menu = EXCLUDED.menu,
               reserved_at = EXCLUDED.reserved_at,
               status = EXCLUDED.status,
               updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [customerId, staffId, menu || null, reservedAt, status, externalId]
      );

      if (status === 'visited') {
        await touchLastVisit(client, customerId, reservedAt);
      }
      await client.query('COMMIT');
      result = {
        ok: true,
        reservationId: rows[0].id,
        customerId,
        created: rows[0].inserted === true,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 新規の確定予約のみ通知（更新のたびに鳴らさない）
    if (result.created && status === 'confirmed') {
      await notifyNewReservation({ customerName, reservedAt, menu, staffName });
    }
    return result;
  }

  /** 管理画面からの手入力予約 */
  async function createManual({ customerId, reservedAt, menu, staffId }) {
    if (!Number.isInteger(customerId)) return { ok: false, error: 'invalid_customer' };
    if (!reservedAt || Number.isNaN(Date.parse(reservedAt))) {
      return { ok: false, error: 'invalid_reserved_at' };
    }

    const { rows: customers } = await pool.query(`SELECT name FROM customers WHERE id = $1`, [
      customerId,
    ]);
    if (customers.length === 0) return { ok: false, error: 'customer_not_found' };

    const { rows } = await pool.query(
      `INSERT INTO reservations (customer_id, staff_id, menu, reserved_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [customerId, staffId || null, menu || null, reservedAt]
    );

    let staffName = null;
    if (staffId) {
      const { rows: staff } = await pool.query(`SELECT name FROM staff WHERE id = $1`, [staffId]);
      staffName = staff[0]?.name ?? null;
    }
    await notifyNewReservation({
      customerName: customers[0].name,
      reservedAt,
      menu,
      staffName,
    });
    return { ok: true, reservationId: rows[0].id };
  }

  /**
   * LIFF 予約フォームからのリクエスト。承認待ち（requested）で作成する。
   * 顧客は LINE の userId で特定するため、未登録の場合は受け付けない。
   */
  async function createRequest({ lineUserId, menuId, staffId, reservedAt, note }) {
    if (!reservedAt || Number.isNaN(Date.parse(reservedAt))) {
      return { ok: false, error: 'invalid_reserved_at' };
    }
    const when = new Date(reservedAt);
    if (when.getTime() <= Date.now()) return { ok: false, error: 'past_datetime' };
    if (when.getTime() > Date.now() + MAX_DAYS_AHEAD * 86400000) {
      return { ok: false, error: 'too_far_ahead' };
    }
    if (note && note.length > 500) return { ok: false, error: 'note_too_long' };

    const { rows: customers } = await pool.query(
      `SELECT id, name FROM customers WHERE line_user_id = $1 AND is_blocked = false`,
      [lineUserId]
    );
    const customer = customers[0];
    if (!customer) return { ok: false, error: 'not_registered' };

    // 承認待ちを溜めすぎないようにする
    const { rows: pending } = await pool.query(
      `SELECT count(*)::int AS n FROM reservations
       WHERE customer_id = $1 AND status = 'requested'`,
      [customer.id]
    );
    if (pending[0].n >= MAX_PENDING_REQUESTS) return { ok: false, error: 'too_many_pending' };

    // メニュー名は予約側にコピーする（後でメニューを改名しても過去の予約は変わらない）
    let menuName = null;
    if (menuId) {
      const { rows } = await pool.query(
        `SELECT name FROM menus WHERE id = $1 AND active = true`,
        [menuId]
      );
      if (rows.length === 0) return { ok: false, error: 'invalid_menu' };
      menuName = rows[0].name;
    }

    let staffName = null;
    if (staffId) {
      const { rows } = await pool.query(
        `SELECT name FROM staff WHERE id = $1 AND active = true`,
        [staffId]
      );
      if (rows.length === 0) return { ok: false, error: 'invalid_staff' };
      staffName = rows[0].name;
    }

    const { rows } = await pool.query(
      `INSERT INTO reservations (customer_id, staff_id, menu, reserved_at, status, note)
       VALUES ($1, $2, $3, $4, 'requested', $5)
       RETURNING id`,
      [customer.id, staffId || null, menuName, reservedAt, note || null]
    );

    await slack.notify(
      `:bell: *【要対応】LINEから予約リクエスト*\n` +
        `顧客: ${customer.name}（customer=${customer.id}）\n` +
        `希望日時: ${formatJstDateTime(when)}\n` +
        `メニュー: ${menuName ?? '未選択'}\n担当: ${staffName ?? '指定なし'}\n` +
        (note ? `ご要望: ${note}\n` : '') +
        `管理画面で承認または見送りの操作をお願いします。`
    );

    return {
      ok: true,
      reservationId: rows[0].id,
      customerName: customer.name,
      menu: menuName,
      staffName,
    };
  }

  /**
   * 承認待ちの予約が確定・見送りになったことを顧客へ知らせる（Push・通数を消費）。
   * 通知の失敗でステータス更新を巻き戻さない。
   */
  async function notifyCustomerDecision(reservation, status) {
    if (!lineClient || !reservation.line_user_id) return;
    const payload = {
      customerName: reservation.customer_name,
      reservedAt: reservation.reserved_at,
      menu: reservation.menu,
      staffName: reservation.staff_name,
    };
    const message =
      status === 'confirmed' ? buildConfirmedMessage(payload) : buildDeclinedMessage(payload);
    try {
      await lineClient.deliver({
        customerId: reservation.customer_id,
        lineUserId: reservation.line_user_id,
        jobType: 'reservation_confirmed',
        dedupeKey: `reservation_${status}:res:${reservation.id}`,
        reservationId: reservation.id,
        messages: [message],
      });
    } catch (err) {
      console.error(`[reservation] 顧客への結果通知に失敗: ${err.message}`);
    }
  }

  /** 予約ステータスの更新。visited は last_visit_at にも反映する */
  async function setStatus(reservationId, status) {
    const allowed = ['confirmed', 'cancelled', 'visited', 'no_show'];
    if (!allowed.includes(status)) return { ok: false, error: 'invalid_status' };

    const client = await pool.connect();
    let reservation;
    let wasRequested = false;
    try {
      await client.query('BEGIN');
      // 承認待ちからの遷移かどうかで顧客通知の要否が変わるため、変更前の状態を見る
      const { rows: before } = await client.query(
        `SELECT r.id, r.status, r.customer_id, r.reserved_at, r.menu,
                c.name AS customer_name, c.line_user_id, s.name AS staff_name
         FROM reservations r
         JOIN customers c ON c.id = r.customer_id
         LEFT JOIN staff s ON s.id = r.staff_id
         WHERE r.id = $1
         FOR UPDATE OF r`,
        [reservationId]
      );
      if (before.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'not_found' };
      }
      reservation = before[0];
      wasRequested = reservation.status === 'requested';

      await client.query(
        `UPDATE reservations SET status = $2, updated_at = now() WHERE id = $1`,
        [reservationId, status]
      );
      if (status === 'visited') {
        await touchLastVisit(client, reservation.customer_id, reservation.reserved_at);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 顧客が送ったリクエストへの回答は、確定・見送りとも本人に伝える
    if (wasRequested && (status === 'confirmed' || status === 'cancelled')) {
      await notifyCustomerDecision(reservation, status);
    }
    return { ok: true, notifiedCustomer: wasRequested };
  }

  return { upsertExternal, createManual, createRequest, setStatus };
}

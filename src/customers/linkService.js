// 顧客と LINE ユーザーの紐付け。全機能の土台なので、判断に迷うケースは
// 勝手にマージせず Slack へ通知して人間の判断に回す方針をとる。
import { normalizePhone } from './phone.js';

export function createLinkService({ pool, slack }) {
  /**
   * LIFF 登録フォームからの紐付け。
   * 電話番号で既存 customers を検索し、ヒットすれば line_user_id を更新、なければ新規作成。
   *
   * @returns {Promise<{ok: boolean, error?: string, customerId?: number,
   *   outcome?: 'linked_existing'|'created_new'|'conflict'}>}
   */
  async function registerFromLiff({ lineUserId, name, phone, birthday, consent }) {
    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) return { ok: false, error: 'invalid_phone' };
    if (!name || !name.trim()) return { ok: false, error: 'invalid_name' };
    if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
      return { ok: false, error: 'invalid_birthday' };
    }
    const optOut = !consent;

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');

      // 同時登録による競合を避けるため両方の行をロックして判断する
      const { rows: byPhone } = await client.query(
        'SELECT id, line_user_id FROM customers WHERE phone_norm = $1 FOR UPDATE',
        [phoneNorm]
      );
      const { rows: byLine } = await client.query(
        'SELECT id FROM customers WHERE line_user_id = $1 FOR UPDATE',
        [lineUserId]
      );
      const matched = byPhone[0] ?? null; // 電話番号が一致した既存顧客
      const selfRow = byLine[0] ?? null; // follow 時に作られた仮レコード

      if (matched && matched.line_user_id && matched.line_user_id !== lineUserId) {
        // その電話番号は既に別の LINE アカウントに紐付いている。
        // 勝手に付け替えると既存の紐付けを壊すため、本人のレコードにだけ情報を残して人間に回す
        let customerId;
        if (selfRow) {
          await client.query(
            `UPDATE customers SET name = $2, birthday = $3, opt_out = $4, updated_at = now()
             WHERE id = $1`,
            [selfRow.id, name.trim(), birthday || null, optOut]
          );
          customerId = selfRow.id;
        } else {
          const { rows } = await client.query(
            `INSERT INTO customers (line_user_id, name, birthday, opt_out)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [lineUserId, name.trim(), birthday || null, optOut]
          );
          customerId = rows[0].id;
        }
        result = { ok: true, customerId, outcome: 'conflict' };
      } else if (matched) {
        // 既存顧客にヒット。新規作成ではなく既存レコードを更新する。
        if (selfRow && selfRow.id !== matched.id) {
          // follow 時の仮レコードから line_user_id を外して既存顧客側へ付け替える
          await client.query('UPDATE customers SET line_user_id = NULL WHERE id = $1', [
            selfRow.id,
          ]);
        }
        // 初回の紐付けでは氏名を上書きしない（店舗の台帳側を正とする）が、
        // 既に本人と紐付いているレコードなら、本人による訂正として氏名も反映する
        const isOwnRecord = matched.line_user_id === lineUserId;
        await client.query(
          `UPDATE customers
           SET line_user_id = $2,
               name = CASE WHEN $5::boolean THEN $6 ELSE name END,
               birthday = COALESCE($3, birthday),
               opt_out = $4,
               is_blocked = false,
               updated_at = now()
           WHERE id = $1`,
          [matched.id, lineUserId, birthday || null, optOut, isOwnRecord, name.trim()]
        );
        if (selfRow && selfRow.id !== matched.id) {
          // 履歴のない仮レコードだけ掃除する。履歴があれば残して人間のマージ判断に委ねる
          await client.query(
            `DELETE FROM customers c
             WHERE c.id = $1
               AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM message_logs m WHERE m.customer_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM customer_responses x WHERE x.customer_id = c.id)`,
            [selfRow.id]
          );
        }
        result = { ok: true, customerId: matched.id, outcome: 'linked_existing' };
      } else if (selfRow) {
        // 台帳に該当なし。follow 時の仮レコードを本登録に昇格させる
        await client.query(
          `UPDATE customers
           SET name = $2, phone_norm = $3, birthday = $4, opt_out = $5, updated_at = now()
           WHERE id = $1`,
          [selfRow.id, name.trim(), phoneNorm, birthday || null, optOut]
        );
        result = { ok: true, customerId: selfRow.id, outcome: 'created_new' };
      } else {
        // follow イベントを取り逃している場合もここで救済する
        const { rows } = await client.query(
          `INSERT INTO customers (line_user_id, name, phone_norm, birthday, opt_out)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [lineUserId, name.trim(), phoneNorm, birthday || null, optOut]
        );
        result = { ok: true, customerId: rows[0].id, outcome: 'created_new' };
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 通知はトランザクション確定後に送る（通知失敗で登録を巻き戻さない）
    if (result.outcome === 'conflict') {
      await slack.notify(
        `:warning: *LIFF 登録: 電話番号の衝突*\n` +
          `電話番号 ${phoneNorm} は既に別の LINE アカウントに紐付いています。\n` +
          `customer=${result.customerId} を手動確認してください。`
      );
    } else if (result.outcome === 'created_new') {
      await slack.notify(
        `:bust_in_silhouette: LIFF から新規顧客登録（既存台帳に該当なし） customer=${result.customerId}`
      );
    }
    return result;
  }

  /**
   * 補助経路: テキストメッセージで受け取った電話番号での突合。
   * 新規顧客は作らない（LIFF 未経由では氏名・同意が取れないため）。
   *
   * @returns {Promise<{outcome: 'linked'|'not_found'|'conflict', customerId?: number}>}
   */
  async function linkByPhoneText({ lineUserId, displayName, text }) {
    const phoneNorm = normalizePhone(text);
    if (!phoneNorm) throw new Error('電話番号として解釈できない入力です');

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      const { rows: byPhone } = await client.query(
        'SELECT id, line_user_id FROM customers WHERE phone_norm = $1 FOR UPDATE',
        [phoneNorm]
      );
      const matched = byPhone[0] ?? null;

      if (!matched) {
        result = { outcome: 'not_found' };
      } else if (matched.line_user_id && matched.line_user_id !== lineUserId) {
        result = { outcome: 'conflict', customerId: matched.id };
      } else {
        const { rows: byLine } = await client.query(
          'SELECT id FROM customers WHERE line_user_id = $1 FOR UPDATE',
          [lineUserId]
        );
        const selfRow = byLine[0] ?? null;
        if (selfRow && selfRow.id !== matched.id) {
          await client.query('UPDATE customers SET line_user_id = NULL WHERE id = $1', [
            selfRow.id,
          ]);
        }
        await client.query(
          `UPDATE customers
           SET line_user_id = $2, is_blocked = false, updated_at = now()
           WHERE id = $1`,
          [matched.id, lineUserId]
        );
        result = { outcome: 'linked', customerId: matched.id };
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (result.outcome === 'not_found') {
      // 突合失敗はスタッフの手動対応に回す（spec 4. の通知要件）
      await slack.notify(
        `:mag: *電話番号の突合失敗*\n` +
          `受信した電話番号: ${phoneNorm}\nLINE表示名: ${displayName || '不明'}\n` +
          `台帳に該当がありません。手動での紐付けをお願いします。`
      );
    } else if (result.outcome === 'conflict') {
      await slack.notify(
        `:warning: *電話番号の突合: 衝突*\n` +
          `受信した電話番号 ${phoneNorm} は既に別の LINE アカウントに紐付いています。\n` +
          `customer=${result.customerId} を手動確認してください。`
      );
    }
    return result;
  }

  return { registerFromLiff, linkByPhoneText };
}

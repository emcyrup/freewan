// シフト変更申請（公式LINE からの自由記述 → 承認 → 本人へ通知）と、
// スタッフの LINE 連携。
//
// 日付・時刻は DB から文字列で取り出す（to_char）。Date へ変換すると UTC 基準になり、
// JST の日付が1日ずれるため。

import { randomInt } from 'node:crypto';
import { SETTING_KEYS } from '../settings.js';

const KIND_LABELS = {
  work: '出勤',
  am: 'AM半休',
  pm: 'PM半休',
  koukyu: '公休',
  yukyu: '有休',
  jikan: '時間休',
};

const LINK_CODE_TTL_HOURS = 24;

const weekdayFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });

/** 「8/1(土) 有休」「7/31(金) 時間休 10:00〜12:00」の形に整える */
export function formatShift(r) {
  const [, month, day] = r.target_date.split('-');
  const weekday = weekdayFmt.format(new Date(`${r.target_date}T00:00:00+09:00`));
  const label = KIND_LABELS[r.kind] ?? r.kind;
  const time = r.kind === 'jikan' && r.start_time ? ` ${r.start_time}〜${r.end_time}` : '';
  return `${Number(month)}/${Number(day)}(${weekday}) ${label}${time}`;
}

// 一覧・通知で共通して使う列。日付と時刻は必ず文字列で返す
const REQUEST_COLUMNS = `
  r.id, r.staff_id, s.name AS staff_name,
  to_char(r.target_date, 'YYYY-MM-DD') AS target_date,
  r.kind::text AS kind,
  to_char(r.start_time, 'HH24:MI') AS start_time,
  to_char(r.end_time, 'HH24:MI') AS end_time,
  r.reason, r.raw_text, r.status::text AS status, r.decided_at, r.created_at`;

export function createShiftService({ pool, lineClient, slack, settings = null, config = null }) {
  // ---- スタッフの LINE 連携 ----

  /** 管理画面から連携コードを発行する。既存のコードは上書きして使い捨てにする */
  async function issueLinkCode(staffId) {
    const code = String(randomInt(100000, 1000000));
    const { rows } = await pool.query(
      `UPDATE staff
       SET link_code = $2, link_code_expires_at = now() + make_interval(hours => $3)
       WHERE id = $1
       RETURNING id, name`,
      [staffId, code, LINK_CODE_TTL_HOURS]
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };
    return { ok: true, code, staff: rows[0], expiresInHours: LINK_CODE_TTL_HOURS };
  }

  /** スタッフが送ってきた合言葉で紐付ける。連携済みの LINE アカウントは付け替えない */
  async function linkStaffByCode({ lineUserId, code }) {
    const { rows } = await pool.query(
      `UPDATE staff
       SET line_user_id = $1, link_code = NULL, link_code_expires_at = NULL
       WHERE link_code = $2 AND link_code_expires_at > now()
         AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.line_user_id = $1 AND o.id <> staff.id)
       RETURNING id, name`,
      [lineUserId, code]
    );
    if (rows.length === 0) return { ok: false, error: 'invalid_code' };
    return { ok: true, staff: rows[0] };
  }

  /**
   * スタッフグループでの「スタッフ登録 高橋」による紐付け。
   * 同姓のスタッフがいると誤って別人に紐づくため、1人に絞れないときは紐付けない。
   */
  async function linkStaffByName({ lineUserId, name }) {
    // 姓名の間の空白は入れ方が揺れるため、両側から除いて比較する
    const { rows: matches } = await pool.query(
      `SELECT id, name FROM staff
       WHERE active = true
         AND replace(replace(name, ' ', ''), '　', '') = replace(replace($1, ' ', ''), '　', '')`,
      [name]
    );
    if (matches.length === 0) return { ok: false, error: 'not_found' };
    if (matches.length > 1) return { ok: false, error: 'ambiguous' };

    const { rows } = await pool.query(
      `UPDATE staff SET line_user_id = $1, link_code = NULL, link_code_expires_at = NULL
       WHERE id = $2
         AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.line_user_id = $1 AND o.id <> $2)
       RETURNING id, name`,
      [lineUserId, matches[0].id]
    );
    if (rows.length === 0) return { ok: false, error: 'already_linked_to_other' };
    return { ok: true, staff: rows[0] };
  }

  /**
   * 連携済みスタッフがスタッフグループに参加しているかを一覧で返す。
   * グループ未設定のときは判定そのものができないため、その旨だけを返す。
   */
  async function listStaffLineStatus() {
    const groupId =
      (settings ? await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null) : null) ??
      config?.staffLineGroupId ??
      null;
    if (!groupId) return { groupConfigured: false, membership: {} };

    const { rows } = await pool.query(
      `SELECT id, line_user_id FROM staff WHERE active = true AND line_user_id IS NOT NULL ORDER BY id`
    );
    const membership = {};
    // LINE のレート制限に配慮し、少人数前提で直列に確認する
    for (const s of rows) {
      membership[s.id] = await lineClient.getGroupMembership(groupId, s.line_user_id);
    }
    return { groupConfigured: true, membership };
  }

  async function findStaffByLineUserId(lineUserId) {
    const { rows } = await pool.query(
      `SELECT id, name FROM staff WHERE line_user_id = $1 AND active = true`,
      [lineUserId]
    );
    return rows[0] ?? null;
  }

  // ---- 申請 ----

  /**
   * 解釈済みの申請を保存する。
   * 同じ日について承認待ちが残っていると承認者がどちらを採るか判断できないため、
   * 新しい申請で置き換える（承認済みの履歴には手を付けない）。
   */
  async function createRequests({ staffId, entries, rawText }) {
    const created = [];
    let replaced = 0;
    for (const e of entries) {
      const { rowCount } = await pool.query(
        `DELETE FROM shift_requests
         WHERE staff_id = $1 AND target_date = $2 AND status = 'pending'`,
        [staffId, e.date]
      );
      replaced += rowCount;
      const { rows } = await pool.query(
        `INSERT INTO shift_requests
           (staff_id, target_date, kind, start_time, end_time, reason, raw_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, to_char(target_date, 'YYYY-MM-DD') AS target_date,
                   kind::text AS kind,
                   to_char(start_time, 'HH24:MI') AS start_time,
                   to_char(end_time, 'HH24:MI') AS end_time`,
        [staffId, e.date, e.kind, e.startTime, e.endTime, e.reason, rawText]
      );
      created.push(rows[0]);
    }
    return { created, replaced };
  }

  async function listRequests({ status = null } = {}) {
    const { rows } = await pool.query(
      `SELECT ${REQUEST_COLUMNS}
       FROM shift_requests r
       JOIN staff s ON s.id = r.staff_id
       WHERE ($1::text IS NULL OR r.status::text = $1)
       ORDER BY (r.status = 'pending') DESC, r.target_date, r.id
       LIMIT 200`,
      [status]
    );
    return rows;
  }

  // ---- 週次シフト ----

  /**
   * 1マス分の登録・更新。kind が null なら未入力に戻す（行を消す）。
   * @param {string} p.date YYYY-MM-DD（JST の日付）
   */
  async function upsertShift({ staffId, date, kind, startTime = null, endTime = null }) {
    if (!kind) {
      await pool.query(`DELETE FROM shifts WHERE staff_id = $1 AND work_date = $2`, [staffId, date]);
      return { ok: true, shift: null };
    }
    // 時間休以外に時刻が残ると表示が崩れるため、ここで落とす
    const jikan = kind === 'jikan';
    const { rows } = await pool.query(
      `INSERT INTO shifts (staff_id, work_date, kind, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (staff_id, work_date) DO UPDATE
         SET kind = EXCLUDED.kind, start_time = EXCLUDED.start_time,
             end_time = EXCLUDED.end_time, updated_at = now()
       RETURNING id, to_char(work_date, 'YYYY-MM-DD') AS work_date, kind::text AS kind,
                 to_char(start_time, 'HH24:MI') AS start_time,
                 to_char(end_time, 'HH24:MI') AS end_time`,
      [staffId, date, kind, jikan ? startTime : null, jikan ? endTime : null]
    );
    return { ok: true, shift: rows[0] };
  }

  /**
   * 期間内のシフトを、スタッフ一覧とあわせて返す。
   * スタッフを追加すれば、その人の行が自動で増える（シフトが未入力でも一覧には出す）。
   */
  async function listShifts({ from, to }) {
    const { rows: staff } = await pool.query(
      `SELECT id, name FROM staff WHERE active = true ORDER BY id`
    );
    const { rows: shifts } = await pool.query(
      `SELECT staff_id, to_char(work_date, 'YYYY-MM-DD') AS work_date, kind::text AS kind,
              to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM shifts
       WHERE work_date BETWEEN $1::date AND $2::date`,
      [from, to]
    );
    return { staff, shifts };
  }

  /**
   * 承認・却下。結果は必ず申請したスタッフへ LINE で伝える。
   * 通知に失敗しても判断自体は確定させ、Slack でスタッフに知らせる
   * （握り潰すと「承認したのに本人が知らない」状態になるため）。
   */
  async function decide({ id, status }) {
    if (!['approved', 'rejected'].includes(status)) return { ok: false, error: 'invalid_status' };

    const { rows } = await pool.query(
      `UPDATE shift_requests SET status = $2, decided_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [id, status]
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };

    const { rows: full } = await pool.query(
      `SELECT ${REQUEST_COLUMNS}, s.line_user_id
       FROM shift_requests r JOIN staff s ON s.id = r.staff_id
       WHERE r.id = $1`,
      [id]
    );
    const request = full[0];

    // 承認したら週次シフトへ反映する。ここを飛ばすと「承認したのに表が変わらない」ことになる
    if (status === 'approved') {
      await upsertShift({
        staffId: request.staff_id,
        date: request.target_date,
        kind: request.kind,
        startTime: request.start_time,
        endTime: request.end_time,
      });
    }

    const label = formatShift(request);
    const text =
      status === 'approved'
        ? `シフト変更が承認されました。\n${label}\nシフト表に反映しました。`
        : `シフト変更は見送りとなりました。\n${label}\nお手数ですが、店長へご相談ください。`;

    // 送れなかった理由（未連携／dry_run／失敗）を画面で区別できるようにする
    let delivery = request.line_user_id ? 'failed' : 'not_linked';
    if (request.line_user_id) {
      try {
        delivery = (await lineClient.pushStaff(request.line_user_id, text)).status;
      } catch (err) {
        await slack.notifyError(`シフト申請の結果通知に失敗（staff=${request.staff_id}）`, err);
      }
    }
    // line_user_id は返さない（画面・ログに出す必要がない）
    delete request.line_user_id;
    return { ok: true, request, notified: delivery === 'sent', delivery };
  }

  return {
    issueLinkCode,
    linkStaffByCode,
    linkStaffByName,
    listStaffLineStatus,
    upsertShift,
    listShifts,
    findStaffByLineUserId,
    createRequests,
    listRequests,
    decide,
  };
}

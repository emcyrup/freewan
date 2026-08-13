// 回数券・保育コース（定額プラン）の回数管理。
//
// 残回数は plan_credits の合計から常に導く（集計値を持たない）。
// 付与ごとの残数も同じ元帳から出すので、履歴と残数がずれることがない。

import { jstToday } from '../util/jst.js';

// 消化する順番。店舗の運用に合わせてここだけを見ればよいようにまとめてある。
//
//   保育コース … 当月分を先に消化し、繰越分は後回し（店舗の運用がこの順のため）。
//                結果として繰越分の方が失効しやすいが、それを承知の運用。
//   回数券 ……… 期限の近いものから消化する（失効を減らすため）。
//
// ※ この順番は店舗ごとに違いうる。変えるときはここだけを直す
const CONSUME_ORDER = {
  plan: 'g.effective_on DESC, g.id DESC',
  ticket: 'g.expires_on ASC NULLS LAST, g.id ASC',
};

// JST の月初・月末。付与と失効の基準日に使う（DB の TZ 設定に依存させない）
function monthRange({ year, month }) {
  const pad = (n) => String(n).padStart(2, '0');
  const first = `${year}-${pad(month)}-01`;
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  const nextFirst = new Date(Date.UTC(nextY, nextM - 1, 1));
  const last = new Date(nextFirst.getTime() - 86_400_000);
  return { first, last: last.toISOString().slice(0, 10) };
}

/** 月末から n ヶ月後の月末（繰越の期限）。0 なら当月末＝繰越なし */
function carryDeadline({ year, month }, carryOverMonths) {
  const total = month - 1 + carryOverMonths;
  return monthRange({ year: year + Math.floor(total / 12), month: (total % 12) + 1 }).last;
}

export function createPlanService({ pool }) {
  // ---- プランのマスタ ----
  async function listPlans({ all = false } = {}) {
    const { rows } = await pool.query(
      `SELECT id, name, monthly_quota, carry_over_months, active, sort_order
       FROM plans WHERE ($1 = true OR active = true) ORDER BY sort_order, id`,
      [all]
    );
    return rows;
  }

  async function createPlan({ name, monthlyQuota, carryOverMonths = 1, sortOrder = 0 }) {
    if (!name?.trim()) throw new Error('invalid_name');
    if (!Number.isInteger(monthlyQuota) || monthlyQuota < 1) throw new Error('invalid_quota');
    if (!Number.isInteger(carryOverMonths) || carryOverMonths < 0) throw new Error('invalid_carry_over');
    const { rows } = await pool.query(
      `INSERT INTO plans (name, monthly_quota, carry_over_months, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name.trim(), monthlyQuota, carryOverMonths, sortOrder]
    );
    return rows[0].id;
  }

  async function updatePlan(id, { name, monthlyQuota, carryOverMonths, active, sortOrder }) {
    if (!name?.trim()) throw new Error('invalid_name');
    if (!Number.isInteger(monthlyQuota) || monthlyQuota < 1) throw new Error('invalid_quota');
    if (!Number.isInteger(carryOverMonths) || carryOverMonths < 0) throw new Error('invalid_carry_over');
    const { rowCount } = await pool.query(
      `UPDATE plans SET name = $2, monthly_quota = $3, carry_over_months = $4,
              active = $5, sort_order = $6
       WHERE id = $1`,
      [id, name.trim(), monthlyQuota, carryOverMonths, active !== false, sortOrder ?? 0]
    );
    if (rowCount === 0) throw new Error('plan_not_found');
  }

  // ---- 加入・解約 ----
  /**
   * 加入。**当月分はその場で満額を付与する**（日割りしない）。
   * 月の途中で加入した子が翌月まで0回のままだと、加入したのに使えないため。
   */
  async function enroll({ petId, planId, startedOn = null, today = jstToday() }) {
    const { rows: plan } = await pool.query(
      `SELECT monthly_quota, carry_over_months FROM plans WHERE id = $1`,
      [planId]
    );
    if (plan.length === 0) throw new Error('plan_not_found');
    let enrollmentId;
    try {
      const { rows } = await pool.query(
        `INSERT INTO pet_plans (pet_id, plan_id, started_on) VALUES ($1, $2, $3) RETURNING id`,
        [petId, planId, startedOn || today.iso]
      );
      enrollmentId = rows[0].id;
    } catch (err) {
      // 部分ユニーク索引に当たったとき。加入中の子をもう一度加入させようとした場合
      if (err.code === '23505') throw new Error('already_enrolled');
      throw err;
    }
    // 月次付与と同じ形で入れるので、月初のジョブと重なっても二重にならない
    await pool.query(
      `INSERT INTO plan_credits (pet_id, source, kind, count, effective_on, expires_on, note)
       VALUES ($1, 'plan', 'grant', $2, $3, $4, '当月分')
       ON CONFLICT DO NOTHING`,
      [petId, plan[0].monthly_quota, monthRange(today).first, carryDeadline(today, plan[0].carry_over_months)]
    );
    return enrollmentId;
  }

  /** 解約。残っている回数はそのまま（期限まで使える）。消したいときは失効を別途記録する */
  async function cancelEnrollment(petPlanId, { endedOn = null } = {}) {
    const { rowCount } = await pool.query(
      `UPDATE pet_plans SET ended_on = $2 WHERE id = $1 AND ended_on IS NULL`,
      [petPlanId, endedOn || jstToday().iso]
    );
    if (rowCount === 0) throw new Error('enrollment_not_found');
  }

  // ---- 付与 ----
  async function grant({ petId, source, count, effectiveOn, expiresOn = null, note = null }) {
    if (!['ticket', 'plan'].includes(source)) throw new Error('invalid_source');
    if (!Number.isInteger(count) || count < 1) throw new Error('invalid_count');
    const { rows } = await pool.query(
      `INSERT INTO plan_credits (pet_id, source, kind, count, effective_on, expires_on, note)
       VALUES ($1, $2, 'grant', $3, $4, $5, $6) RETURNING id`,
      [petId, source, count, effectiveOn, expiresOn, note]
    );
    return rows[0].id;
  }

  // ---- 消化 ----
  /**
   * 回数を n 回消化する。期限切れの付与は対象にしない。
   * 残りが足りなければ足りるぶんだけ消化し、consumed で実際の回数を返す
   * （足りないから何もしない、にすると来店の記録が残らなくなるため）。
   */
  async function consume({ petId, source, count = 1, reservationId = null, note = null, on = null }) {
    if (!['ticket', 'plan'].includes(source)) throw new Error('invalid_source');
    if (!Number.isInteger(count) || count < 1) throw new Error('invalid_count');
    const date = on || jstToday().iso;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // 付与ごとの残数を出し、消化する順に並べる。
      // FOR UPDATE で同時実行時の二重消化を防ぐ
      const { rows: grants } = await client.query(
        // 残数は LATERAL で出す。GROUP BY と FOR UPDATE は併用できないため
        `SELECT g.id, g.count + COALESCE(u.used, 0) AS remaining
         FROM plan_credits g
         LEFT JOIN LATERAL (
           SELECT SUM(count) AS used FROM plan_credits WHERE grant_id = g.id
         ) u ON true
         WHERE g.pet_id = $1 AND g.source = $2 AND g.kind = 'grant'
           AND (g.expires_on IS NULL OR g.expires_on >= $3::date)
           AND g.count + COALESCE(u.used, 0) > 0
         ORDER BY ${CONSUME_ORDER[source]}
         FOR UPDATE OF g`,
        [petId, source, date]
      );

      let left = count;
      const used = [];
      for (const g of grants) {
        if (left === 0) break;
        const take = Math.min(left, Number(g.remaining));
        await client.query(
          `INSERT INTO plan_credits
             (pet_id, source, kind, count, effective_on, grant_id, reservation_id, note)
           VALUES ($1, $2, 'use', $3, $4, $5, $6, $7)`,
          [petId, source, -take, date, g.id, reservationId, note]
        );
        used.push({ grantId: g.id, count: take });
        left -= take;
      }
      await client.query('COMMIT');
      return { consumed: count - left, shortfall: left, used };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** 消化の取り消し（来店を取り消したときなど）。その予約に紐づく消化を全部戻す */
  async function revokeByReservation(reservationId) {
    const { rowCount } = await pool.query(
      `DELETE FROM plan_credits WHERE reservation_id = $1 AND kind = 'use'`,
      [reservationId]
    );
    return { revoked: rowCount };
  }

  // ---- 残回数 ----
  /** わんちゃんの残回数と、加入中のプラン・当月の利用状況 */
  async function summary(petId, { today = jstToday() } = {}) {
    const { first, last } = monthRange(today);
    // 期限切れかどうかは「今日」で判断する（月初で見ると、月の途中で切れた分が残って見える）
    const now = today.iso;

    const { rows: balances } = await pool.query(
      `SELECT g.source,
              COALESCE(SUM(g.count + COALESCE(u.used, 0)) FILTER (
                WHERE g.expires_on IS NULL OR g.expires_on >= $2::date
              ), 0)::int AS remaining,
              (min(g.expires_on) FILTER (
                WHERE (g.expires_on IS NULL OR g.expires_on >= $2::date)
                  AND g.count + COALESCE(u.used, 0) > 0
              ))::text AS next_expiry
       FROM plan_credits g
       LEFT JOIN LATERAL (
         SELECT SUM(count) AS used FROM plan_credits WHERE grant_id = g.id
       ) u ON true
       WHERE g.pet_id = $1 AND g.kind = 'grant'
       GROUP BY g.source`,
      [petId, now]
    );

    const { rows: enrollment } = await pool.query(
      `SELECT pp.id, pp.plan_id, pp.started_on::text, p.name, p.monthly_quota, p.carry_over_months
       FROM pet_plans pp JOIN plans p ON p.id = pp.plan_id
       WHERE pp.pet_id = $1 AND pp.ended_on IS NULL`,
      [petId]
    );

    // 当月分の消化数。繰越分と分けて出すため、当月に付与された分だけを見る
    const { rows: thisMonth } = await pool.query(
      `SELECT COALESCE(SUM(g.count), 0)::int AS granted,
              COALESCE(-SUM(u.used), 0)::int AS used
       FROM plan_credits g
       LEFT JOIN LATERAL (
         SELECT SUM(count) AS used FROM plan_credits WHERE grant_id = g.id AND kind = 'use'
       ) u ON true
       WHERE g.pet_id = $1 AND g.source = 'plan' AND g.kind = 'grant'
         AND g.effective_on BETWEEN $2::date AND $3::date`,
      [petId, first, last]
    );

    // 繰越分（当月より前の付与で、まだ期限内に残っているもの）
    const { rows: carried } = await pool.query(
      `SELECT COALESCE(SUM(g.count + COALESCE(u.used, 0)), 0)::int AS remaining,
              max(g.expires_on)::text AS expires_on
       FROM plan_credits g
       LEFT JOIN LATERAL (
         SELECT SUM(count) AS used FROM plan_credits WHERE grant_id = g.id
       ) u ON true
       WHERE g.pet_id = $1 AND g.source = 'plan' AND g.kind = 'grant'
         AND g.effective_on < $2::date
         AND (g.expires_on IS NULL OR g.expires_on >= $3::date)`,
      [petId, first, now]
    );

    const by = Object.fromEntries(balances.map((b) => [b.source, b]));
    return {
      ticket: {
        remaining: by.ticket?.remaining ?? 0,
        expiresOn: by.ticket?.next_expiry ?? null,
      },
      plan: enrollment[0]
        ? {
            enrollmentId: enrollment[0].id,
            planId: enrollment[0].plan_id,
            name: enrollment[0].name,
            quota: enrollment[0].monthly_quota,
            used: thisMonth[0].used,
            granted: thisMonth[0].granted,
            carry: carried[0].remaining,
            carryExpiresOn: carried[0].expires_on,
            remaining: by.plan?.remaining ?? 0,
          }
        : null,
    };
  }

  /** 失効した回数の履歴（カルテに出す） */
  async function lapsed(petId) {
    const { rows } = await pool.query(
      `SELECT effective_on::text, source, -count AS count, note
       FROM plan_credits
       WHERE pet_id = $1 AND kind = 'expire'
       ORDER BY effective_on DESC, id DESC
       LIMIT 20`,
      [petId]
    );
    return rows;
  }

  /** 元帳そのもの（付与・消化・失効）。数が合わないときの確認用 */
  async function history(petId, { limit = 50 } = {}) {
    const { rows } = await pool.query(
      `SELECT id, source, kind, count, effective_on::text, expires_on::text, reservation_id, note
       FROM plan_credits WHERE pet_id = $1
       ORDER BY effective_on DESC, id DESC LIMIT $2`,
      [petId, limit]
    );
    return rows;
  }

  // ---- 月次処理 ----
  /**
   * 当月分の付与。加入中のわんちゃん全員に monthly_quota を付ける。
   * 二重付与は部分ユニーク索引で防ぐので、同じ月に何度実行しても増えない。
   */
  async function grantMonthly({ today = jstToday() } = {}) {
    const { first } = monthRange(today);
    const { rows: enrolled } = await pool.query(
      `SELECT pp.pet_id, p.monthly_quota, p.carry_over_months
       FROM pet_plans pp JOIN plans p ON p.id = pp.plan_id
       WHERE pp.ended_on IS NULL AND pp.started_on <= $1::date AND p.active = true`,
      [monthRange(today).last]
    );
    let granted = 0;
    for (const e of enrolled) {
      const expiresOn = carryDeadline(today, e.carry_over_months);
      const { rowCount } = await pool.query(
        `INSERT INTO plan_credits (pet_id, source, kind, count, effective_on, expires_on, note)
         VALUES ($1, 'plan', 'grant', $2, $3, $4, '当月分')
         ON CONFLICT DO NOTHING`,
        [e.pet_id, e.monthly_quota, first, expiresOn]
      );
      granted += rowCount;
    }
    return { enrolled: enrolled.length, granted };
  }

  /**
   * 期限を過ぎた残りを失効させる。
   * 消化と同じ元帳に負の行として積むので、残数と履歴がずれない。
   */
  async function expireOverdue({ today = jstToday() } = {}) {
    const date = today.iso ?? `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`;
    const { rows } = await pool.query(
      `INSERT INTO plan_credits (pet_id, source, kind, count, effective_on, grant_id, note)
       SELECT g.pet_id, g.source, 'expire',
              -(g.count + COALESCE(SUM(u.count), 0)), $1::date, g.id, '期限切れ'
       FROM plan_credits g
       LEFT JOIN plan_credits u ON u.grant_id = g.id
       WHERE g.kind = 'grant' AND g.expires_on IS NOT NULL AND g.expires_on < $1::date
       GROUP BY g.id
       HAVING g.count + COALESCE(SUM(u.count), 0) > 0
       RETURNING pet_id, -count AS count`,
      [date]
    );
    return { expired: rows.length, total: rows.reduce((a, r) => a + r.count, 0) };
  }

  return {
    listPlans, createPlan, updatePlan,
    enroll, cancelEnrollment,
    grant, consume, revokeByReservation,
    summary, lapsed, history,
    grantMonthly, expireOverdue,
  };
}

export { monthRange, carryDeadline };

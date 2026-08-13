// リマインド配信の店舗設定（管理画面から個別／一括で ON/OFF できる）。
//
// 設定は app_settings に JSON 1行で持つ。行が無い状態＝これまでどおり全部 ON にしてあるので、
// 既存環境を移行しても挙動は変わらない。
import { SETTING_KEYS } from './settings.js';

// 画面の R番号と日次ジョブ名の対応。画面・API・ジョブで同じ並びを使う
export const REMINDER_JOBS = [
  { key: 'preReminder', id: 'R1', label: '前々日確認' },
  { key: 'afterVisit', id: 'R2', label: '来店7日後フォロー' },
  { key: 'dormant', id: 'R3', label: '休眠フォロー' },
  { key: 'birthday', id: 'R4', label: '誕生日メッセージ' },
];

const KEYS = REMINDER_JOBS.map((j) => j.key);

export function createReminderSettings({ settings }) {
  /** 4種すべての ON/OFF を返す（未設定は ON） */
  async function getAll() {
    let stored = {};
    if (settings) {
      const raw = await settings.get(SETTING_KEYS.remindersEnabled).catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') stored = parsed;
        } catch {
          // 壊れた値で配信が止まる方が害が大きいため、読めないときは全 ON として扱う
          console.error('[reminders] 設定を読めませんでした。全 ON として扱います');
        }
      }
    }
    return Object.fromEntries(KEYS.map((k) => [k, stored[k] !== false]));
  }

  /** 日次ジョブ側の判定。設定を読めないときは止めない（配信が黙って止まる方が危ない） */
  async function isEnabled(key) {
    if (!KEYS.includes(key)) return true;
    try {
      return (await getAll())[key];
    } catch (err) {
      console.error(`[reminders] 設定の取得に失敗したため実行します: ${err.message}`);
      return true;
    }
  }

  /** 与えられたぶんだけ更新して、更新後の全体を返す（一括 ON/OFF もこれ1本で行う） */
  async function update(patch) {
    if (!settings) throw new Error('設定を保存できません');
    const next = { ...(await getAll()) };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!KEYS.includes(k)) throw new Error(`未知のリマインドです: ${k}`);
      if (typeof v !== 'boolean') throw new Error(`ON/OFF は真偽値で指定してください: ${k}`);
      next[k] = v;
    }
    await settings.set(SETTING_KEYS.remindersEnabled, JSON.stringify(next));
    return next;
  }

  return { getAll, isEnabled, update };
}

/**
 * お客様ごとのリマインド ON/OFF。
 *
 * 店舗全体の設定（上の createReminderSettings）とは別枠で、両方 ON のときだけ送られる。
 * 判定はジョブ側の SQL に埋め込んである（対象者の抽出と同じクエリで済ませるため）。
 * ここは画面から読み書きするための入口。
 */
export function createCustomerReminders({ pool }) {
  async function get(customerId) {
    const { rows } = await pool.query(
      `SELECT job, enabled FROM customer_reminder_settings WHERE customer_id = $1`,
      [customerId]
    );
    const stored = Object.fromEntries(rows.map((r) => [r.job, r.enabled]));
    return Object.fromEntries(KEYS.map((k) => [k, stored[k] !== false]));
  }

  /** 変えるぶんだけ受け取り、更新後の全体を返す */
  async function update(customerId, patch) {
    const entries = Object.entries(patch ?? {});
    for (const [k, v] of entries) {
      if (!KEYS.includes(k)) throw new Error(`未知のリマインドです: ${k}`);
      if (typeof v !== 'boolean') throw new Error(`ON/OFF は真偽値で指定してください: ${k}`);
    }
    for (const [job, enabled] of entries) {
      await pool.query(
        `INSERT INTO customer_reminder_settings (customer_id, job, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, job)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [customerId, job, enabled]
      );
    }
    return get(customerId);
  }

  return { get, update };
}

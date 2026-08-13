// スタッフ通知の送信先を抽象化する。呼び出し側は従来どおり notify / notifyError を使い、
// 実際の送信先（Slack / LINE グループ / 両方）は STAFF_NOTIFY_CHANNEL で切り替える。
// 注意: LINE グループへの Push は通数を消費する（グループ宛は人数に関わらず1通）。

import { SETTING_KEYS } from '../settings.js';

// Slack 記法を LINE 用のプレーンテキストに変換する
const EMOJI_MAP = {
  ':rotating_light:': '🚨',
  ':warning:': '⚠️',
  ':calendar:': '📅',
  ':mag:': '🔍',
  ':package:': '📦',
  ':bust_in_silhouette:': '👤',
};

export function toPlainText(slackText) {
  let text = slackText;
  for (const [code, emoji] of Object.entries(EMOJI_MAP)) {
    text = text.replaceAll(code, emoji);
  }
  return text
    .replace(/:[a-z0-9_+-]+:/g, '') // 未知の絵文字コードは除去
    .replace(/\*([^*\n]+)\*/g, '$1') // *強調* を外す
    .replace(/```([\s\S]*?)```/g, '$1') // コードブロック記法を外す
    .replace(/^> ?/gm, ''); // 引用記法を外す
}

export function createStaffNotifier({ config, slack, lineClient, settings = null }) {
  const useSlack = ['slack', 'both'].includes(config.staffNotifyChannel);
  const useLine = ['line', 'both'].includes(config.staffNotifyChannel);

  // グループ ID は DB（join イベントで自動設定）を優先し、環境変数をフォールバックにする
  async function resolveGroupId() {
    if (settings) {
      const stored = await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null);
      if (stored) return stored;
    }
    return config.staffLineGroupId ?? null;
  }

  async function notify(text) {
    let delivered = false;
    if (useSlack && slack) {
      delivered = (await slack.notify(text)) || delivered;
    }
    if (useLine) {
      // LINE 側の失敗で本処理（予約登録など）を落とさない
      try {
        const groupId = await resolveGroupId();
        if (groupId) {
          await lineClient.pushStaff(groupId, toPlainText(text));
          delivered = true;
        } else {
          console.warn(
            '[staff-notify] 通知先グループが未設定です。Bot をスタッフ用グループに招待してください'
          );
        }
      } catch (err) {
        console.error(`[staff-notify] LINE 通知失敗: ${err.message}`);
      }
    }
    return delivered;
  }

  async function notifyError(context, err) {
    const stack = err?.stack || String(err);
    return notify(`:rotating_light: *${context}*\n\`\`\`${stack.slice(0, 2800)}\`\`\``);
  }

  return { notify, notifyError };
}

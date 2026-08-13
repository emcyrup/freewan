// 予約リクエストの受付・承認・見送りを顧客へ伝えるメッセージ。
// 受付時は応答メッセージ（通数無料）、承認・見送り時は Push（通数を消費）で送る。
import { formatJstDateTime } from '../../util/jst.js';

function detailLines({ reservedAt, menu, staffName }) {
  const lines = [`【日時】${formatJstDateTime(new Date(reservedAt))}`];
  if (menu) lines.push(`【メニュー】${menu}`);
  if (staffName) lines.push(`【担当】${staffName}`);
  return lines.join('\n');
}

/** 予約フォーム送信直後（まだ確定ではないことを明示する） */
export function buildRequestReceivedMessage({ customerName, reservedAt, menu, staffName }) {
  return {
    type: 'text',
    text:
      `${customerName}様\nご予約のリクエストを承りました。\n\n` +
      `${detailLines({ reservedAt, menu, staffName })}\n\n` +
      `※この時点ではまだ確定ではありません。店舗で確認のうえ、確定のご連絡をいたします。`,
  };
}

/** 店舗が承認したとき */
export function buildConfirmedMessage({ customerName, reservedAt, menu, staffName }) {
  return {
    type: 'text',
    text:
      `${customerName}様\nご予約が確定いたしました。\n\n` +
      `${detailLines({ reservedAt, menu, staffName })}\n\n` +
      `ご来店を心よりお待ちしております。`,
  };
}

/** 店舗が見送ったとき（枠が埋まっている等） */
export function buildDeclinedMessage({ customerName, reservedAt }) {
  return {
    type: 'text',
    text:
      `${customerName}様\n` +
      `恐れ入ります。ご希望いただいた ${formatJstDateTime(new Date(reservedAt))} は、` +
      `ご案内が難しい状況です。\n` +
      `別の日時をご提案させていただきますので、担当者からのご連絡をお待ちください。`,
  };
}

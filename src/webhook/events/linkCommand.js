// スタッフ LINE 連携コマンドの解釈。1:1 とグループで同じ書き方を受け付けるため共通化する。
//
// 顧客が偶然送る文面と衝突しないよう接頭辞を必須にする一方、送り方の細かな違い
// （区切りの有無・全角数字・全角空白）で弾かれると「送ったのに無反応」になるため、
// そこは広めに吸収する。

const PREFIX_RE = /^(?:スタッフ(?:登録|連携)|シフト登録|shift\s*link)[\s　:：]*(.+)$/i;
const CODE_RE = /^\d{6}$/;

// スマホの日本語入力では数字が全角になりやすい。半角へ寄せてから判定する
const toHalfWidth = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/**
 * @param {string} text 受信したテキスト
 * @returns {{arg: string, isCode: boolean} | null} 連携コマンドでなければ null
 */
export function parseLinkCommand(text) {
  const match = PREFIX_RE.exec(String(text ?? '').trim());
  if (!match) return null;
  // 全角空白を半角に寄せる（氏名の区切りとして残すのでここでは詰めない）
  const arg = toHalfWidth(match[1]).replace(/　/g, ' ').trim();
  if (!arg) return null;
  return { arg, isCode: CODE_RE.test(arg) };
}

/**
 * 接頭辞なしで6桁の数字だけが送られた場合のコード。
 *
 * 画面に出ている数字をそのまま送る人が多く、接頭辞を必須にすると連携できないまま
 * 顧客向けの応答に流れてしまう。発行済みで期限内のコードに一致した場合だけ連携する
 * 運用にすれば、たまたま6桁を送った顧客の会話を横取りすることはない。
 *
 * @returns {string | null} 6桁の数字。それ以外は null
 */
export function parseBareCode(text) {
  const trimmed = toHalfWidth(String(text ?? '').trim()).replace(/[\s　]/g, '');
  return CODE_RE.test(trimmed) ? trimmed : null;
}

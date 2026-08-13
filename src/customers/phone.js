// 電話番号の正規化。突合キーとして使うため、表記ゆれをここで一本化する。
// 正規化できない入力は null を返し、呼び出し側でエラー扱いにする。

export function normalizePhone(input) {
  if (!input) return null;
  let s = String(input)
    // 全角数字・全角プラスを半角へ
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/＋/g, '+')
    // ハイフン類（全角・長音符・ダッシュ含む）・空白・括弧を除去
    .replace(/[-－‐‑–—−ー\s().（）]/g, '');
  // 国際表記 +81 は国内表記の先頭 0 に戻す
  if (s.startsWith('+81')) s = '0' + s.slice(3);
  // 日本の電話番号: 0 始まりで10〜11桁のみ受け付ける
  if (!/^0\d{9,10}$/.test(s)) return null;
  return s;
}

/** テキストメッセージが電話番号の送信とみなせるか（補助経路の判定に使う） */
export function looksLikePhone(text) {
  return normalizePhone(text) !== null;
}

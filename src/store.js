// 店舗ごとに変わる情報。他店舗へ展開するとき、コードを分岐させずに済ませるための入口。
//
// 既定値は現行店舗（ここっとベール）の値にしてある。新しい店舗では .env で上書きする。
// 未設定なら既定値が使われるので、いまの環境は .env を触らなくても挙動が変わらない。
//
// ここに置くのは「店舗が違えば必ず変わる」ものだけ。運用中に変えたくなる設定
// （リマインドの ON/OFF など）は app_settings 側で持つ。

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// "木" / "木,日" / "4" のいずれでも受け付ける。曜日名で書けた方が .env を読みやすいため
function parseClosedDays(raw) {
  if (raw == null || raw === '') return [4]; // 既定は木曜定休
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const byName = WEEKDAYS.indexOf(s.replace(/曜日?$/, ''));
      if (byName >= 0) return byName;
      const n = Number(s);
      if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
      throw new Error(`STORE_CLOSED_DAYS が不正です: "${s}"（日〜土 または 0〜6）`);
    });
}

// "10:00" のみ受け付ける。表示にもカレンダーの時間軸にも使うため形式を固定する
function parseTime(raw, fallback, key) {
  const value = raw || fallback;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${key} が不正です: "${value}"（HH:MM 形式）`);
  }
  return value;
}

export function loadStoreProfile(env = process.env) {
  const closedDays = parseClosedDays(env.STORE_CLOSED_DAYS);
  const openTime = parseTime(env.STORE_OPEN_TIME, '10:00', 'STORE_OPEN_TIME');
  const closeTime = parseTime(env.STORE_CLOSE_TIME, '19:00', 'STORE_CLOSE_TIME');
  if (openTime >= closeTime) {
    throw new Error(`STORE_CLOSE_TIME は STORE_OPEN_TIME より後にしてください（${openTime}〜${closeTime}）`);
  }

  return {
    name: env.STORE_NAME || 'ここっとベール',
    tagline: env.STORE_TAGLINE || 'Dog Salon・Pet Hotel｜予約・顧客・自動配信',
    // サイドバーのロゴ。絵文字1文字を想定（画像を持たせると差し替えが重くなるため）
    logo: env.STORE_LOGO || '🌿',
    openTime,
    closeTime,
    closedDays,
    closedDayLabel: closedDays.map((d) => `${WEEKDAYS[d]}曜`).join('・') || 'なし',
    // 既定は現行店舗の値。空文字を渡したときだけ行ごと消す（新店舗で未入力のまま出さないため）
    address: env.STORE_ADDRESS ?? '〒540-0025 大阪市中央区徳井町2丁目2-5',
    phone: env.STORE_PHONE ?? '06-6947-8211',
  };
}

export { WEEKDAYS };

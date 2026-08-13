// 管理画面（Basic 認証）と取り込み API（Bearer トークン）の認証ミドルウェア。
// 資格情報が未設定の環境では該当機能ごと無効化する（誤って無認証公開しない）。
import { timingSafeEqual } from 'node:crypto';

// 長さの違いでタイミング差が出ないよう、固定長ハッシュ比較にはしない簡易パディング比較
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // 長さが違っても必ず比較を1回行い、早期 return の時間差を減らす
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function basicAuth({ user, password, realm = 'admin' }) {
  return (req, res, next) => {
    if (!user || !password) {
      return res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_USER / ADMIN_PASSWORD が未設定です' });
    }
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const sep = decoded.indexOf(':');
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (sep > 0 && safeEqual(u, user) && safeEqual(p, password)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    return res.status(401).json({ error: 'unauthorized' });
  };
}

export function bearerAuth({ token }) {
  return (req, res, next) => {
    if (!token) {
      return res.status(503).json({ error: 'import_disabled', message: 'INGEST_API_TOKEN が未設定です' });
    }
    const header = req.headers.authorization ?? '';
    const [scheme, value] = header.split(' ');
    if (scheme === 'Bearer' && value && safeEqual(value, token)) {
      return next();
    }
    return res.status(401).json({ error: 'unauthorized' });
  };
}

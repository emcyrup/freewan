// LIFF から送られた userId を無条件に信用しない（なりすまし防止）。
// ID トークンを LINE の検証エンドポイントに投げ、検証済みの sub を userId として使う。

const VERIFY_ENDPOINT = 'https://api.line.me/oauth2/v2.1/verify';

export function createIdTokenVerifier({ channelId, fetchFn = fetch }) {
  return async function verifyIdToken(idToken) {
    if (!idToken) throw new Error('IDトークンがありません');

    const res = await fetchFn(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`IDトークン検証失敗: ${body.error_description || body.error || res.status}`);
    }
    if (!body.sub) {
      throw new Error('IDトークン検証失敗: sub が含まれていません');
    }
    // sub = 検証済みの LINE userId
    return body;
  };
}

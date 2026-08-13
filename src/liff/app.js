// LIFF 登録フォーム。userId はクライアントから送らず、ID トークンをサーバで検証させる。
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit');

function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function main() {
  // LIFF ID はサーバから取得する（HTML に焼き込まない）
  const res = await fetch('./config');
  if (!res.ok) throw new Error('設定の取得に失敗しました');
  const { liffId } = await res.json();

  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
  const idToken = liff.getIDToken();

  // 登録済みなら現在の内容を出して「変更」として使えるようにする
  let registered = false;
  try {
    const profileRes = await fetch('./profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      if (profile.registered) {
        registered = true;
        document.getElementById('name').value = profile.name ?? '';
        document.getElementById('phone').value = profile.phone ?? '';
        document.getElementById('birthday').value = profile.birthday ?? '';
        document.getElementById('consent').checked = profile.consent;
        document.getElementById('heading').textContent = 'お客様情報の確認・変更';
        document.getElementById('lead').textContent =
          '現在ご登録いただいている内容です。変更する場合は書き換えて保存してください。';
        submitBtn.textContent = '保存する';
        document.getElementById('to-reserve').classList.remove('hidden');
      }
    }
  } catch {
    // 取得に失敗しても新規登録として続行できるようにする
  }
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('form').classList.remove('hidden');

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    showStatus('送信中…', '');
    try {
      const body = {
        idToken,
        name: document.getElementById('name').value,
        phone: document.getElementById('phone').value,
        birthday: document.getElementById('birthday').value || null,
        consent: document.getElementById('consent').checked,
      };
      const resp = await fetch('./register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        const messages = {
          invalid_phone: '電話番号の形式をご確認ください。',
          invalid_name: 'お名前を入力してください。',
          invalid_birthday: '誕生日の形式をご確認ください。',
        };
        showStatus(messages[data.error] || '登録に失敗しました。時間をおいてお試しください。', 'error');
        submitBtn.disabled = false;
        return;
      }
      showStatus(
        registered
          ? '変更を保存しました。この画面は閉じて構いません。'
          : 'ご登録ありがとうございました。この画面は閉じて構いません。',
        'ok'
      );
      // LIFF ブラウザ内ならウィンドウを閉じる
      setTimeout(() => { if (liff.isInClient()) liff.closeWindow(); }, 1500);
    } catch (err) {
      showStatus('通信エラーが発生しました。時間をおいてお試しください。', 'error');
      submitBtn.disabled = false;
    }
  });
}

main().catch(() => {
  document.getElementById('loading').classList.add('hidden');
  showStatus('初期化に失敗しました。LINE アプリから開き直してください。', 'error');
});

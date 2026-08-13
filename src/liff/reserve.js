// LIFF 予約フォーム。userId はクライアントから送らず、ID トークンをサーバーで検証させる。
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit');
let idToken = null;

function show(id) {
  document.getElementById(id).classList.remove('hidden');
}
function hide(id) {
  document.getElementById(id).classList.add('hidden');
}
function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind;
}

// datetime-local は端末のローカル時刻で入力される。JST 前提のサービスなので
// +09:00 を明示して送り、サーバー側の解釈を端末設定に依存させない
function toJstIso(datetimeLocal) {
  return `${datetimeLocal}:00+09:00`;
}

function jstNowPlusHours(hours) {
  const jst = new Date(Date.now() + hours * 3600000 + 9 * 3600000);
  return jst.toISOString().slice(0, 16);
}

const ERROR_MESSAGES = {
  not_registered: 'お客様情報が未登録のため受け付けられませんでした。登録後にお試しください。',
  past_datetime: '過去の日時は選べません。',
  too_far_ahead: 'ご予約は半年先までとなります。',
  too_many_pending: '確認中のご予約が複数あります。店舗からの連絡をお待ちください。',
  invalid_menu: 'メニューをもう一度お選びください。',
  invalid_staff: 'ご指名の担当者をもう一度お選びください。',
  invalid_reserved_at: '日時の形式をご確認ください。',
  invalid_token: '認証に失敗しました。LINEアプリから開き直してください。',
};

async function main() {
  const res = await fetch('./config');
  if (!res.ok) throw new Error('設定の取得に失敗しました');
  const { liffId } = await res.json();

  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
  idToken = liff.getIDToken();

  // 顧客登録の有無とメニュー・担当の一覧をまとめて取得する
  const optionsRes = await fetch('./reserve/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const options = await optionsRes.json();
  hide('loading');

  if (!optionsRes.ok || !options.registered) {
    show('unregistered');
    return;
  }

  const menuSelect = document.getElementById('menu');
  menuSelect.innerHTML = '<option value="">メニューを選択</option>';
  for (const m of options.menus) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.duration_minutes ? `${m.name}（約${m.duration_minutes}分）` : m.name;
    menuSelect.appendChild(opt);
  }

  const staffSelect = document.getElementById('staff');
  for (const s of options.staff) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    staffSelect.appendChild(opt);
  }

  // 当日直前の駆け込み予約を避け、最短でも翌日以降を初期値にする
  const datetime = document.getElementById('datetime');
  datetime.min = jstNowPlusHours(1);
  datetime.value = `${jstNowPlusHours(24).slice(0, 10)}T10:00`;

  document.getElementById('greeting').textContent = `（${options.customerName}様）`;
  show('form');

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    showStatus('送信中…', '');
    try {
      const resp = await fetch('./reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idToken,
          menuId: Number(menuSelect.value) || null,
          staffId: Number(staffSelect.value) || null,
          reservedAt: toJstIso(datetime.value),
          note: document.getElementById('note').value || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        showStatus(ERROR_MESSAGES[data.error] ?? '送信に失敗しました。時間をおいてお試しください。', 'error');
        submitBtn.disabled = false;
        return;
      }
      hide('form');
      show('status');
      showStatus(
        'ご予約のリクエストを承りました。\n店舗で確認のうえ、確定のご連絡をLINEでお送りします。',
        'ok'
      );
      setTimeout(() => {
        if (liff.isInClient()) liff.closeWindow();
      }, 2500);
    } catch {
      showStatus('通信エラーが発生しました。時間をおいてお試しください。', 'error');
      submitBtn.disabled = false;
    }
  });
}

main().catch(() => {
  hide('loading');
  show('form');
  showStatus('初期化に失敗しました。LINEアプリから開き直してください。', 'error');
});

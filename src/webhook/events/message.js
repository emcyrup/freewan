// message イベント:
//   1. グループでの「会員情報」等のコマンド → 店舗管理画面の顧客一覧（参照・編集）への導線を返信
//   2. 連携済みスタッフからの 1:1 発言 → シフト変更申請として解釈（Phase 8）
//   3. 電話番号らしき文字列 → 突合を試行（補助経路・Phase 2）
//   4. それ以外のテキスト → 直近に来店フォローを送った顧客なら Claude Haiku で分類（Phase 4）
//      concern / question のみ Slack へ通知する
import { looksLikePhone } from '../../customers/phone.js';

// フォロー送信からこの日数以内の返信をフォロー回答とみなす
const FOLLOWUP_WINDOW_DAYS = 14;

// スタッフが既存顧客を参照・編集する導線。グループ（＝スタッフの場）でのみ応答する。
// 顧客自身の登録・変更は友だち追加あいさつやリッチメニューの LIFF に任せる
const INFO_COMMANDS = new Set(['お客様情報', '登録情報', '会員情報', 'マイページ', '顧客情報']);
const normalizeInfoCommand = (text) => text.replace(/[\s　]/g, '').replace(/[?？!！。、]/g, '');

export function createMessageHandler({
  pool,
  lineClient,
  slack,
  linkService,
  classifier,
  staffCommand = null,
  staffShift = null,
  adminUrl = null,
}) {
  async function handlePhoneText(event, text) {
    const lineUserId = event.source.userId;
    // 突合失敗時の Slack 通知に表示名を添える（取れなくても処理は続行）
    let displayName = null;
    try {
      const profile = await lineClient.getProfile(lineUserId);
      displayName = profile?.displayName ?? null;
    } catch {
      // プロフィール非公開でも突合は行う
    }

    const result = await linkService.linkByPhoneText({ lineUserId, displayName, text });

    if (event.replyToken) {
      const replyText =
        result.outcome === 'linked'
          ? 'ご登録ありがとうございます。お客様情報とお繋ぎしました。'
          : 'お電話番号を確認のうえ、担当者よりご連絡いたします。少々お待ちください。';
      await lineClient.reply(event.replyToken, [{ type: 'text', text: replyText }], {
        customerId: result.customerId,
      });
    }
  }

  async function handleFollowupReply(event, text) {
    const lineUserId = event.source.userId;
    const { rows } = await pool.query(
      `SELECT id, name, last_visit_at FROM customers WHERE line_user_id = $1`,
      [lineUserId]
    );
    const customer = rows[0];
    if (!customer) return;

    // 直近にフォローを送っていない顧客の雑談まで分類・通知しない
    const { rows: recent } = await pool.query(
      `SELECT 1 FROM message_logs
       WHERE customer_id = $1 AND job_type = 'after_visit' AND status = 'sent'
         AND sent_at > now() - make_interval(days => $2)`,
      [customer.id, FOLLOWUP_WINDOW_DAYS]
    );
    if (recent.length === 0) return;

    const label = await classifier.classify(text);
    const needsNotify = label === 'concern' || label === 'question';

    await pool.query(
      `INSERT INTO customer_responses (customer_id, kind, raw_text, notified_at)
       VALUES ($1, $2, $3, ${needsNotify ? 'now()' : 'NULL'})`,
      [customer.id, label, text]
    );

    if (needsNotify) {
      const heading = label === 'concern' ? 'フォロー回答: 懸念あり' : 'フォロー回答: 質問';
      await slack.notify(
        `:warning: *${heading}*\n` +
          `顧客: ${customer.name}（customer=${customer.id}）\n` +
          `前回来店日: ${customer.last_visit_at ?? '不明'}\n` +
          `回答本文:\n> ${text}`
      );
    }

    if (event.replyToken) {
      const replyText =
        label === 'good'
          ? 'お知らせいただきありがとうございます！またのご来店をお待ちしております。'
          : 'ご連絡ありがとうございます。内容を確認し、担当者よりご連絡いたします。';
      await lineClient.reply(event.replyToken, [{ type: 'text', text: replyText }], {
        customerId: customer.id,
      });
    }
  }

  return async function handleMessage(event) {
    if (event.message?.type !== 'text') return;
    const text = event.message.text ?? '';

    // スタッフグループからのコマンドを先に処理する（顧客向けの分類には回さない）
    if (staffCommand && (await staffCommand(event, text))) return;

    // 顧客情報の呼び出し。グループ（スタッフの場）でのみ管理画面へ誘導し、
    // 1:1 では応答しない。分類（Haiku）にも回さない
    if (INFO_COMMANDS.has(normalizeInfoCommand(text))) {
      const inGroup = event.source?.type === 'group' || event.source?.type === 'room';
      if (inGroup && adminUrl && event.replyToken) {
        await lineClient.reply(event.replyToken, [
          {
            type: 'text',
            text: `お客様情報の参照・編集は店舗管理画面から行えます。\n${adminUrl}`,
          },
        ]);
      }
      return;
    }

    if (!event.source?.userId) return;

    // 連携済みスタッフからの 1:1 発言はシフト申請として扱う。
    // 未連携＝顧客とみなし、下の従来処理へ落とす
    if (staffShift && (await staffShift(event, text))) return;

    if (looksLikePhone(text)) {
      await handlePhoneText(event, text);
    } else {
      await handleFollowupReply(event, text);
    }
  };
}

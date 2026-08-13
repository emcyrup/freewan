// スタッフからの 1:1 メッセージを、LINE 連携とシフト変更申請として処理する。
//
// 顧客の発言を巻き込まないための線引き:
//   - 1:1 のトークのみ（グループの雑談は対象外）
//   - 連携済みスタッフの line_user_id と一致する発言だけを申請の解釈に回す
// 未連携の相手の発言は false を返し、従来どおり顧客向けの処理へ委ねる。

import { formatShift } from '../../shifts/service.js';
import { parseLinkCommand, parseBareCode } from './linkCommand.js';

const jstDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const linkedMessage = (name) =>
  `${name}さん、連携しました。\n` +
  'このトークにシフトのご希望をそのまま送っていただければ、申請として店長に届きます。\n' +
  '例：8/1 有休でお願いします';

export function createStaffShiftHandler({ shiftService, shiftParser, lineClient, slack, now = () => new Date() }) {
  async function replyText(event, text) {
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [{ type: 'text', text }]);
    }
  }

  // 1:1 では6桁の連携コードだけを受け付ける。名前での連携を許すと、名前さえ知っていれば
  // 誰でもそのスタッフに成りすませてしまうため、名前はスタッフグループ限定にしている
  async function handleLink(event, { arg, isCode }) {
    if (!isCode) {
      // 名前で送られた場合。ここで黙って落とすと顧客向けの処理に流れ、
      // 送った本人には何も返らないため、送り方を案内する
      await replyText(
        event,
        'このトークでは6桁の連携コードで登録できます。\n' +
          '例：スタッフ登録 123456\n' +
          'コードは店長が店舗管理画面から発行できます。\n' +
          'お名前での登録は、スタッフ用のLINEグループでのみ受け付けています。'
      );
      return true;
    }
    const result = await shiftService.linkStaffByCode({
      lineUserId: event.source.userId,
      code: arg,
    });
    // 原因を追えるようにするが、LINE userId は残さない
    console.log(`[staff-link] source=user by=code ok=${result.ok}`);
    if (!result.ok) {
      await replyText(
        event,
        '連携コードを確認できませんでした。\n有効期限が切れている可能性があります。店長に再発行をご依頼ください。'
      );
      return true;
    }
    await replyText(event, linkedMessage(result.staff.name));
    return true;
  }

  /**
   * @returns {Promise<boolean>} 処理したら true（顧客向けの処理へは渡さない）
   */
  return async function handleStaffShift(event, text) {
    if (event.source?.type !== 'user' || !event.source.userId) return false;

    const link = parseLinkCommand(text);
    if (link) return handleLink(event, link);

    // 接頭辞なしで数字だけ送られた場合。発行済みのコードに一致したときだけ連携する。
    // 一致しなければ何も起きなかったものとして、以降の通常処理へそのまま進む
    const bare = parseBareCode(text);
    if (bare) {
      const result = await shiftService.linkStaffByCode({
        lineUserId: event.source.userId,
        code: bare,
      });
      console.log(`[staff-link] source=user by=bare-code ok=${result.ok}`);
      if (result.ok) {
        await replyText(event, linkedMessage(result.staff.name));
        return true;
      }
    }

    const staff = await shiftService.findStaffByLineUserId(event.source.userId);
    if (!staff) return false;

    const parsed = await shiftParser.parse({ text, today: jstDateFmt.format(now()) });
    if (!parsed.isRequest) {
      await replyText(
        event,
        'シフトの申請として読み取れませんでした。\n' +
          'お手数ですが、日付と種別を入れて送ってください。\n' +
          '例：8/1 有休 ／ 7/31 10時から12時まで時間休'
      );
      return true;
    }

    const { created, replaced } = await shiftService.createRequests({
      staffId: staff.id,
      entries: parsed.entries,
      rawText: text,
    });
    const lines = created.map((r) => `・${formatShift(r)}`).join('\n');

    await replyText(
      event,
      'シフト変更を受け付けました。\n' +
        `${staff.name}さん\n${lines}\n` +
        (replaced > 0 ? '（同じ日の申請は今回の内容で上書きしました）\n' : '') +
        '店長の承認後にシフト表へ反映されます。'
    );

    // 承認待ちが溜まっていることに気付けるよう、店長側にも知らせる
    await slack.notify(
      `:calendar: *シフト変更の申請*\n${staff.name}さん（staff=${staff.id}）\n${lines}\n` +
        `申請本文:\n> ${text}`
    );
    return true;
  };
}

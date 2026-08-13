// join イベント: Bot がグループに招待されたら、スタッフ通知先として自動登録する。
//
// 乗っ取り防止のため、自動適用は「通知先が未設定のとき」だけに限る。
// 誰でも Bot をグループに招待できてしまうため、設定済みの通知先を
// 招待だけで奪えると顧客名入りの通知が第三者に流れるリスクがある。
import { SETTING_KEYS } from '../../settings.js';

export function createJoinHandler({ lineClient, settings, slack }) {
  return async function handleJoin(event) {
    if (event.source?.type !== 'group') return;
    const groupId = event.source.groupId;
    console.log('[join] グループに参加しました');

    const current = await settings.get(SETTING_KEYS.staffLineGroupId);

    if (!current) {
      // 未設定 → このグループを通知先として自動適用
      await settings.set(SETTING_KEYS.staffLineGroupId, groupId);
      console.log('[join] スタッフ通知先グループを自動設定しました');
      if (event.replyToken) {
        await lineClient.reply(event.replyToken, [
          {
            type: 'text',
            text:
              'グループに追加ありがとうございます。\n' +
              'このグループをスタッフ通知先として設定しました。\n' +
              '今後、新規予約や要対応のお知らせがここに届きます。',
          },
        ]);
      }
      // 監査用: 既存の通知経路（Slack 等）にも変更を知らせる
      await slack.notify(':warning: スタッフ通知先の LINE グループが新しく設定されました。');
      return;
    }

    if (current === groupId) {
      // 同じグループへの再参加。設定はそのまま
      return;
    }

    // 既に別のグループが設定済み → 勝手に切り替えない
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [
        {
          type: 'text',
          text:
            'グループに追加ありがとうございます。\n' +
            'スタッフ通知先は既に別のグループに設定されているため、変更していません。\n' +
            'このグループへ切り替える場合は、現在の通知先グループから Bot を退出させたあと、もう一度招待してください。',
        },
      ]);
    }
    await slack.notify(
      ':warning: 設定済みのスタッフ通知先とは別のグループに Bot が招待されました（設定は変更していません）。心当たりがない場合は確認してください。'
    );
  };
}

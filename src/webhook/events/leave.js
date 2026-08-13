// leave イベント: Bot が通知先グループから退出（削除）されたら設定をクリアする。
// これにより、別グループへの招待で通知先を再設定できるようになる。
import { SETTING_KEYS } from '../../settings.js';

export function createLeaveHandler({ settings, slack }) {
  return async function handleLeave(event) {
    if (event.source?.type !== 'group') return;
    const groupId = event.source.groupId;

    const current = await settings.get(SETTING_KEYS.staffLineGroupId);
    if (current !== groupId) return;

    await settings.remove(SETTING_KEYS.staffLineGroupId);
    console.log('[leave] スタッフ通知先グループの設定をクリアしました');
    await slack.notify(
      ':warning: Bot がスタッフ通知先グループから退出したため、LINE 通知先の設定をクリアしました。新しいグループに Bot を招待すると再設定されます。'
    );
  };
}

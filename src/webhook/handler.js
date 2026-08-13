// Webhook イベントの振り分け。署名検証は index.js 側の @line/bot-sdk middleware が行う。
// イベントは1件ずつ捕捉し、1件の失敗で他イベントの処理を止めない。
import { createFollowHandler } from './events/follow.js';
import { createUnfollowHandler } from './events/unfollow.js';
import { createMessageHandler } from './events/message.js';
import { createPostbackHandler } from './events/postback.js';
import { createJoinHandler } from './events/join.js';
import { createLeaveHandler } from './events/leave.js';
import { createStaffCommandHandler } from './events/staffCommand.js';
import { createStaffShiftHandler } from './events/staffShift.js';

export function createWebhookHandler({
  pool,
  lineClient,
  slack,
  linkService,
  classifier,
  settings,
  shiftService = null,
  shiftParser = null,
  config = null,
  liffUrl = null,
}) {
  const staffCommand = createStaffCommandHandler({ settings, lineClient, config, shiftService });
  const staffShift =
    shiftService && shiftParser
      ? createStaffShiftHandler({ shiftService, shiftParser, lineClient, slack })
      : null;
  // グループの「会員情報」コマンドで案内する店舗管理画面（顧客一覧 → カルテで参照・編集）の URL
  const adminUrl = config?.publicBaseUrl ? `${config.publicBaseUrl}/mock/#list` : null;
  const handlers = {
    follow: createFollowHandler({ pool, lineClient, liffUrl }),
    unfollow: createUnfollowHandler({ pool }),
    message: createMessageHandler({
      pool, lineClient, slack, linkService, classifier, staffCommand, staffShift, adminUrl,
    }),
    postback: createPostbackHandler({ pool, lineClient, slack }),
    join: createJoinHandler({ lineClient, settings, slack }),
    leave: createLeaveHandler({ settings, slack }),
  };

  return async function webhookHandler(req, res) {
    // LINE 側の再送を防ぐため、処理を待たずに即 200 を返す
    res.status(200).end();

    const events = req.body?.events ?? [];
    for (const event of events) {
      const handler = handlers[event.type];
      if (!handler) continue;
      try {
        await handler(event);
      } catch (err) {
        console.error(`[webhook] ${event.type} 処理失敗: ${err.message}`);
        await slack.notifyError(`Webhook ${event.type} イベント処理失敗`, err);
      }
    }
  };
}

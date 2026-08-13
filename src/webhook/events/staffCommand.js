// スタッフ用グループからの問い合わせコマンド。
//
// 日次ジョブの結果は Push すると1通ごとに通数を消費するため、実行時は保存だけしておき、
// グループで「配信結果」と聞かれたときに応答メッセージで返す（応答は通数を消費しない）。
//
// 顧客が同じ言葉を送っても反応しないよう、**スタッフ通知先に設定済みのグループからの
// 発言だけ**を受け付ける。店内の数字を第三者に読ませないため。
import { SETTING_KEYS } from '../../settings.js';
import { toPlainText } from '../../notify/staffNotifier.js';
import { parseLinkCommand, parseBareCode } from './linkCommand.js';

// 表記ゆれを吸収する。スペースと記号だけ落として比較する
const COMMANDS = {
  配信結果: 'jobSummary',
  ジョブ結果: 'jobSummary',
  実行結果: 'jobSummary',
};

function normalize(text) {
  return text.replace(/[\s　]/g, '').replace(/[?？!！。、]/g, '');
}

const linkedMessage = (name) =>
  `${name}さんのLINEアカウントを連携しました。\n` +
  'これから、Botとの1対1のトークにシフトのご希望を送っていただければ申請できます。\n' +
  '例：8/1 有休でお願いします';

export function createStaffCommandHandler({ settings, lineClient, config, shiftService = null }) {
  async function resolveGroupId() {
    const stored = await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null);
    return stored ?? config?.staffLineGroupId ?? null;
  }

  /**
   * スタッフグループからのコマンドなら処理して true を返す。
   * それ以外（顧客の発言・未設定のグループ）は false を返し、通常の処理へ委ねる。
   */
  async function replyText(event, text) {
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [{ type: 'text', text }]);
    }
  }

  async function handleLink(event, { arg, isCode }) {
    const lineUserId = event.source.userId;
    // 6桁の数字は管理画面で発行した連携コード。名前と取り違えないよう先に判定する
    const result = isCode
      ? await shiftService.linkStaffByCode({ lineUserId, code: arg })
      : await shiftService.linkStaffByName({ lineUserId, name: arg });
    // 原因を追えるようにするが、LINE userId は残さない
    console.log(`[staff-link] source=group by=${isCode ? 'code' : 'name'} ok=${result.ok}`);

    const messages = {
      invalid_code: '連携コードを確認できませんでした。\n有効期限が切れている可能性があります。店長に再発行をご依頼ください。',
      not_found: `「${arg}」というスタッフが見つかりません。店舗管理画面に登録された名前で送ってください。`,
      ambiguous: `「${arg}」に当てはまるスタッフが複数います。店舗管理画面から LINE ID を直接設定してください。`,
      already_linked_to_other: 'この LINE アカウントは既に別のスタッフに紐付いています。',
    };
    const body = result.ok ? linkedMessage(result.staff.name) : messages[result.error];
    await replyText(event, body);
    return true;
  }

  return async function handleStaffCommand(event, text) {
    if (event.source?.type !== 'group') return false;

    const link = shiftService ? parseLinkCommand(text) : null;
    const bare = shiftService && !link ? parseBareCode(text) : null;
    const command = COMMANDS[normalize(text)];
    if (!command && !link && !bare) return false;

    const staffGroupId = await resolveGroupId();
    const isStaffGroup = Boolean(staffGroupId) && event.source.groupId === staffGroupId;

    // 接頭辞なしで数字だけ送られた場合。発行済みのコードに一致したときだけ連携し、
    // 一致しなければ黙って通常の処理へ委ねる（グループの雑談を横取りしないため）
    if (bare) {
      if (!isStaffGroup || !event.source.userId) return false;
      const result = await shiftService.linkStaffByCode({
        lineUserId: event.source.userId,
        code: bare,
      });
      console.log(`[staff-link] source=group by=bare-code ok=${result.ok}`);
      if (!result.ok) return false;
      await replyText(event, linkedMessage(result.staff.name));
      return true;
    }

    // 連携コマンドは意図の明確な操作なので、どのグループでも必ず返事をする。
    // 無言で終わると「送ったのに反応がない」となり、原因にたどり着けないため
    if (link) {
      if (!isStaffGroup) {
        console.log(`[staff-link] source=group 対象外のグループ configured=${Boolean(staffGroupId)}`);
        await replyText(
          event,
          staffGroupId
            ? 'このグループはスタッフ通知先として設定されていないため、ここでは連携できません。\n' +
              'スタッフ通知先のグループか、Botとの1対1のトークで「スタッフ登録 123456」をお送りください。'
            : 'スタッフ通知先のLINEグループがまだ設定されていません。\n' +
              'Botとの1対1のトークで「スタッフ登録 123456」（店舗管理画面で発行した6桁）をお送りください。'
        );
        return true;
      }
      if (!event.source.userId) {
        await replyText(
          event,
          '送信された方のLINEアカウントを特定できませんでした。\n' +
            'お手数ですが、Botとの1対1のトークから「スタッフ登録 123456」をお送りください。'
        );
        return true;
      }
      return handleLink(event, link);
    }

    // 問い合わせ系のコマンドは、店内の数字を第三者に見せないため対象グループ以外では黙る
    if (!isStaffGroup) return false;

    if (command === 'jobSummary') {
      const summary = await settings.get(SETTING_KEYS.lastJobSummary);
      const body = summary
        ? toPlainText(summary)
        : 'まだ実行結果がありません。配信ジョブは毎朝10時に動きます。';
      if (event.replyToken) {
        await lineClient.reply(event.replyToken, [{ type: 'text', text: body }]);
      }
      return true;
    }
    return false;
  };
}

// follow イベント: customers に line_user_id を upsert する。
// 再フォロー（ブロック解除）の場合は is_blocked を戻して配信対象に復帰させる。

export function createFollowHandler({ pool, lineClient, liffUrl = null }) {
  return async function handleFollow(event) {
    const lineUserId = event.source?.userId;
    if (!lineUserId) return;

    // 氏名は LIFF 登録で確定させる。それまでは LINE の表示名を仮置きする
    let displayName = '未登録';
    try {
      const profile = await lineClient.getProfile(lineUserId);
      if (profile?.displayName) displayName = profile.displayName;
    } catch {
      // プロフィール非公開などで取れなくても登録は続行する
    }

    const { rows } = await pool.query(
      `INSERT INTO customers (line_user_id, name)
       VALUES ($1, $2)
       ON CONFLICT (line_user_id)
       DO UPDATE SET is_blocked = false, updated_at = now()
       RETURNING id`,
      [lineUserId, displayName]
    );
    console.log(`[follow] customer=${rows[0].id}`);

    // あいさつ（応答メッセージなので通数無料）。LIFF 登録への導線を必ず入れる
    if (event.replyToken) {
      const lines = [
        '友だち追加ありがとうございます！',
        'ご予約の確認やご案内をお届けするため、お客様情報のご登録をお願いいたします。',
      ];
      if (liffUrl) {
        lines.push('', `▼ご登録はこちら（1分で完了します）`, liffUrl);
      }
      await lineClient.reply(
        event.replyToken,
        [{ type: 'text', text: lines.join('\n') }],
        { customerId: rows[0].id }
      );
    }
  };
}

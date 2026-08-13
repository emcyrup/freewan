// unfollow イベント: is_blocked を立て、以降の全配信対象から外す。
// レコードは消さない（再フォロー時に来店履歴との紐付けを保つため）。

export function createUnfollowHandler({ pool }) {
  return async function handleUnfollow(event) {
    const lineUserId = event.source?.userId;
    if (!lineUserId) return;

    const { rows } = await pool.query(
      `UPDATE customers SET is_blocked = true, updated_at = now()
       WHERE line_user_id = $1
       RETURNING id`,
      [lineUserId]
    );
    if (rows.length > 0) {
      console.log(`[unfollow] customer=${rows[0].id}`);
    }
  };
}

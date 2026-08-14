// 複数端末で同じ管理画面を開いているときの反映用。
//
// 誰かが予約を承認した・来店を登録した、といった変更を、開いている全端末へ即座に知らせる。
// ライブラリは足さず Server-Sent Events（HTTP のまま片方向に流すだけ）で済ませる。
//
// 取りこぼしの備えは画面側の定期更新に任せる。ここで配れなかった変更（LINE からの
// シフト申請など）も、次の定期更新で追いつく。

// プロキシに切られないよう、無通信が続くときに送る合図の間隔
const HEARTBEAT_MS = 25_000;

export function createChangeFeed({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Set();

  /** 接続してきた端末を購読者に加える。切断時の後始末もここで行う */
  function subscribe(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // リバースプロキシに溜め込まれると即時に届かなくなる
      'X-Accel-Buffering': 'no',
    });
    // 最初の1行を流して接続を確定させる（ここで詰まると画面側が待ち続ける）
    res.write(': connected\n\n');

    const timer = setInterval(() => {
      res.write(': ping\n\n');
    }, heartbeatMs);

    const client = { res, timer };
    clients.add(client);

    const close = () => {
      clearInterval(timer);
      clients.delete(client);
    };
    req.on('close', close);
    req.on('error', close);
    return close;
  }

  /**
   * 変更を全端末へ知らせる。何が変わったかだけを送り、中身は送らない
   * （受け取った端末が自分で読み直す。権限や表示中の画面が端末ごとに違うため）
   */
  function publish(topic) {
    const line = `data: ${JSON.stringify({ topic, at: Date.now() })}\n\n`;
    for (const c of clients) {
      // 1台の書き込み失敗で他への配信を止めない
      try {
        c.res.write(line);
      } catch {
        clearInterval(c.timer);
        clients.delete(c);
      }
    }
  }

  /** 開いている端末の数（動作確認用） */
  function size() {
    return clients.size;
  }

  return { subscribe, publish, size };
}

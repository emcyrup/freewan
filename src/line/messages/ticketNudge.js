// 回数券の来店促し（要件 R6）の Flex Message テンプレート。
// 期限切れで失効させてしまうのが一番の損なので、残回数と期限を具体的に示す。
// 営業色を抑え、末尾に配信停止導線を必ず入れる（休眠フォローと同じ方針）。

function formatDateJp(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-').map(Number);
  return `${m}月${d}日`;
}

export function buildTicketNudgeMessage({ customerName, pets }) {
  const lines = pets.map((p) => {
    const expiry = formatDateJp(p.expiresOn);
    return `・${p.name}ちゃん：残り${p.remaining}回${expiry ? `（${expiry}まで）` : ''}`;
  });
  return {
    type: 'flex',
    altText: '回数券の残り回数のお知らせ',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `${customerName}様`, weight: 'bold', size: 'md' },
          {
            type: 'text',
            text:
              `回数券の残り回数のご案内です。\n${lines.join('\n')}\n` +
              '期限内にぜひご利用ください。ご予約はこのトークからいつでもどうぞ。',
            size: 'sm',
            wrap: true,
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'postback',
              label: '今後この案内が不要な方はこちら',
              data: 'action=opt_out',
              displayText: '案内の配信を停止する',
            },
          },
        ],
      },
    },
  };
}

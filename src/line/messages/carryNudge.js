// 繰越分の消化案内（要件 R8）の Flex Message テンプレート。
// 「失効しますよ」という警告色を出しすぎず、残り回数と失効日を具体的に示す。
// 営業色を抑え、末尾に配信停止導線を必ず入れる（他のリマインドと同じ方針）。

function formatDateJp(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-').map(Number);
  return `${m}月${d}日`;
}

export function buildCarryNudgeMessage({ customerName, pets }) {
  const lines = pets.map((p) => {
    const expiry = formatDateJp(p.expiresOn);
    return `・${p.name}ちゃん：繰越分 残り${p.remaining}回${expiry ? `（${expiry}で失効）` : ''}`;
  });
  return {
    type: 'flex',
    altText: '繰越分の回数のご案内',
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
              `先月から繰り越した回数のご案内です。\n${lines.join('\n')}\n` +
              '期限までにぜひご利用ください。ご予約はこのトークからいつでもどうぞ。',
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

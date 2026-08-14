// ワクチン更新案内（要件 R3）の Flex Message テンプレート。
// 「期限が近い」ことだけを伝え、接種の予約先（動物病院）はお客様に委ねる。
// サロン利用には接種証明が必要なため、更新後の証明書持参のお願いを添える。

function formatDateJp(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-').map(Number);
  return `${m}月${d}日`;
}

export function buildVaccineMessage({ customerName, pets }) {
  const lines = pets.map((p) => {
    const expiry = formatDateJp(p.expiresOn);
    return `・${p.name}ちゃん：${p.vaccine}${expiry ? `（${expiry}まで）` : ''}`;
  });
  return {
    type: 'flex',
    altText: 'ワクチン更新時期のご案内',
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
              `ワクチンの更新時期が近づいています。\n${lines.join('\n')}\n` +
              'お済みになりましたら、次回ご来店時に接種証明書をお持ちください。',
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

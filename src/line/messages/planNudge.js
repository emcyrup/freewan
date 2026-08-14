// 定額コース会員の残回数案内（要件 R7）の Flex Message テンプレート。
// 「月4回・月8回」等の会員が使い忘れないよう、月内の残り回数を知らせる。
// コース名は店舗ごとに違う（保育コース／スクール会員）ため、DB のプラン名をそのまま使う。

export function buildPlanNudgeMessage({ customerName, pets }) {
  const lines = pets.map(
    (p) => `・${p.name}ちゃん（${p.planName}）：残り${p.remaining}回`
  );
  return {
    type: 'flex',
    altText: 'コースの残り回数のお知らせ',
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
              `コースの残り回数のご案内です。\n${lines.join('\n')}\n` +
              'ご来店をお待ちしております。ご予約はこのトークからいつでもどうぞ。',
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

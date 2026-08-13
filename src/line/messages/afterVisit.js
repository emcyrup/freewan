// 来店7日後フォローの Flex Message テンプレート。

export function buildAfterVisitMessage({ customerName, reservationId }) {
  return {
    type: 'flex',
    altText: 'ご来店ありがとうございました',
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
            text: '先日はご来店いただきありがとうございました。\nその後の調子はいかがでしょうか？',
            size: 'sm',
            wrap: true,
          },
          {
            type: 'text',
            text: '気になる点があれば、このままメッセージでお知らせください。',
            size: 'sm',
            wrap: true,
            margin: 'md',
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
            style: 'primary',
            action: {
              type: 'postback',
              label: '調子いいです',
              data: `action=followup&res=${reservationId}&v=good`,
              displayText: '調子いいです',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '気になることがある',
              data: `action=followup&res=${reservationId}&v=concern`,
              displayText: '気になることがある',
            },
          },
        ],
      },
    },
  };
}

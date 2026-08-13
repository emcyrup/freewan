// 休眠フォローの Flex Message テンプレート。
// 営業色を抑え、末尾に配信停止導線を必ず入れる（spec 2-3）。

export function buildDormantMessage({ customerName }) {
  return {
    type: 'flex',
    altText: 'ご無沙汰しております',
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
            // 業種に依存しない言い回しにしている（他店舗へ展開しても書き換えずに済むように）
            text: 'ご無沙汰しております。その後お変わりありませんか？\n気になることがあれば、いつでもお気軽にご相談ください。',
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

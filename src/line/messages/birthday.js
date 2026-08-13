// 誕生日祝いの Flex Message テンプレート。
// クーポンは LINE 公式アカウントのクーポン機能で作成した URL を埋め込む（通数を消費しない）。

export function buildBirthdayMessage({ customerName, couponUrl }) {
  const body = {
    type: 'box',
    layout: 'vertical',
    spacing: 'md',
    contents: [
      { type: 'text', text: `${customerName}様`, weight: 'bold', size: 'md' },
      {
        type: 'text',
        text: 'お誕生日おめでとうございます🎉\nいつもご利用いただきありがとうございます。\n素敵な一年になりますように！',
        size: 'sm',
        wrap: true,
      },
    ],
  };

  const contents = { type: 'bubble', body };

  if (couponUrl) {
    body.contents.push({
      type: 'text',
      text: 'ささやかですが、バースデークーポンをご用意しました。今月末までお使いいただけます。',
      size: 'sm',
      wrap: true,
      margin: 'md',
    });
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: { type: 'uri', label: 'クーポンを見る', uri: couponUrl },
        },
      ],
    };
  }

  return {
    type: 'flex',
    altText: 'お誕生日おめでとうございます🎉',
    contents,
  };
}

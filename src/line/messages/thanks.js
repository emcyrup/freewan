// 来店お礼（要件 R9）のメッセージ。当日の写真を添えてお礼を送る。
// 来店に紐づくお礼で販促ではないため、他のリマインドと違い opt_out 導線は付けない
// （opt_out 済みのお客様にはそもそも送らない。抽出はジョブ側で行う）。
// LINE の画像メッセージは URL 指定のため、写真は公開 URL で渡す。

export function buildThanksMessages({ customerName, petName, photoUrls }) {
  const who = petName ? `${petName}ちゃん` : 'わんちゃん';
  const messages = [
    {
      type: 'text',
      text:
        `${customerName}様\n本日はご来店ありがとうございました🐾\n` +
        `${who}の本日のお写真をお送りします。\n` +
        'またのご来店を心よりお待ちしております。',
    },
  ];
  for (const url of photoUrls) {
    messages.push({ type: 'image', originalContentUrl: url, previewImageUrl: url });
  }
  return messages;
}

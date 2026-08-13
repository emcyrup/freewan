// フォロー返信のネガポジ分類（Claude Haiku）。
// 失敗時は必ず安全側（concern = スタッフ確認行き）に倒す。ここで例外を外に漏らさない。

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = [
  'あなたは店舗（サロン）の「来店後フォローメッセージ」への顧客返信を分類する分類器です。',
  '返信本文を次の3値のいずれかに分類し、JSON のみを返してください。',
  '- good: 好意的、問題なし、感謝など',
  '- concern: 不調、不満、痛み、違和感、クレームなど懸念を含む',
  '- question: 質問、予約希望、要望など返答が必要なもの',
  '判断に迷う場合は concern を選んでください。',
].join('\n');

// enum 制約付きの構造化出力。モデルの出力ゆれ自体を抑える
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', enum: ['good', 'concern', 'question'] },
  },
  required: ['label'],
  additionalProperties: false,
};

export function createFollowupClassifier({ apiKey, fetchFn = fetch }) {
  /**
   * @param {string} text 顧客の返信本文
   * @returns {Promise<'good'|'concern'|'question'>}
   */
  async function classify(text) {
    if (!apiKey) {
      console.warn('[classify] ANTHROPIC_API_KEY 未設定のため concern 扱いにします');
      return 'concern';
    }
    try {
      const res = await fetchFn(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 128,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: text }],
          output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.error(`[classify] API エラー: HTTP ${res.status}`);
        return 'concern';
      }
      const body = await res.json();
      if (body.stop_reason === 'refusal') return 'concern';
      const raw = body.content?.[0]?.text;
      const parsed = JSON.parse(raw); // 失敗は catch で concern に倒す
      if (['good', 'concern', 'question'].includes(parsed.label)) {
        return parsed.label;
      }
      return 'concern';
    } catch (err) {
      console.error(`[classify] 分類失敗のため concern 扱い: ${err.message}`);
      return 'concern';
    }
  }

  return { classify };
}

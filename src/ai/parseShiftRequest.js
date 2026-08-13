// スタッフが公式LINEへ自由記述で送るシフト変更申請の解釈（Claude Haiku）。
//
// 分類器（classifyFollowup）と違い、迷ったときの安全側は「解釈できなかった」。
// 読み違えたまま申請を作ると誤った勤怠が承認されうるため、確信が持てない場合は
// 申請を作らずスタッフに書き直してもらう。

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

// 管理画面のシフト表と同じ区分に揃える
const KINDS = ['work', 'am', 'pm', 'koukyu', 'yukyu', 'jikan'];

const SYSTEM_PROMPT = [
  'あなたは店舗（ドッグサロン）のスタッフが送るシフト変更の申請文を、構造化データに変換する担当です。',
  '申請文から「対象日」「区分」「時間帯」「理由」を読み取り、JSON のみを返してください。',
  '',
  '区分は次のいずれかです。',
  '- work: 出勤（休みの取り消し・出勤への変更）',
  '- am: 午前half休（AM半休）',
  '- pm: 午後half休（PM半休）',
  '- koukyu: 公休（シフト上の休み）',
  '- yukyu: 有給休暇',
  '- jikan: 時間休（開始と終了の時刻を指定する休み）',
  '',
  '規則:',
  '- 日付は必ず YYYY-MM-DD 形式。年の指定がなければ、今日以降でもっとも近い日付として解釈する。',
  '- 「明日」「来週の月曜」などの相対表現は、指定された今日の日付を基準に解決する。',
  '- 複数の日にちが含まれる場合（「8/1と8/2」「8/1〜8/3」など）は、日ごとに entries を分ける。',
  '- 時間休のときだけ startTime / endTime を HH:MM で入れる。それ以外は null。',
  '- 「半休」で午前・午後の別が書かれていない場合は、確信が持てないので isRequest を false にする。',
  '- 理由が書かれていればそのまま reason に入れる。無ければ null。',
  '- シフトと無関係な雑談、あいさつ、日付が特定できない依頼は isRequest を false にする。',
  '- 少しでも解釈に迷う場合は isRequest を false にすること。誤った申請を作る方が害が大きい。',
].join('\n');

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    isRequest: { type: 'boolean' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          startTime: { type: ['string', 'null'] },
          endTime: { type: ['string', 'null'] },
          reason: { type: ['string', 'null'] },
        },
        required: ['date', 'kind', 'startTime', 'endTime', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['isRequest', 'entries'],
  additionalProperties: false,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// モデルの出力をそのまま信用せず、DB に入る形かどうかをこちら側でも検証する
function sanitize(parsed) {
  if (!parsed?.isRequest || !Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    return { isRequest: false, entries: [] };
  }
  const entries = [];
  for (const e of parsed.entries) {
    if (!DATE_RE.test(e?.date ?? '') || !KINDS.includes(e?.kind)) return { isRequest: false, entries: [] };
    const jikan = e.kind === 'jikan';
    // 時間休は開始・終了が揃っていないと勤怠として成立しない
    if (jikan && !(TIME_RE.test(e.startTime ?? '') && TIME_RE.test(e.endTime ?? ''))) {
      return { isRequest: false, entries: [] };
    }
    if (jikan && e.startTime >= e.endTime) return { isRequest: false, entries: [] };
    entries.push({
      date: e.date,
      kind: e.kind,
      startTime: jikan ? e.startTime : null,
      endTime: jikan ? e.endTime : null,
      reason: e.reason?.trim() || null,
    });
  }
  return { isRequest: true, entries };
}

export function createShiftRequestParser({ apiKey, fetchFn = fetch }) {
  /**
   * @param {object} p
   * @param {string} p.text     スタッフの申請文
   * @param {string} p.today    今日の日付（JST・YYYY-MM-DD）。相対表現の基準にする
   * @returns {Promise<{isRequest: boolean, entries: object[]}>}
   */
  async function parse({ text, today }) {
    if (!apiKey) {
      console.warn('[shift-parse] ANTHROPIC_API_KEY 未設定のため解釈できません');
      return { isRequest: false, entries: [] };
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
          max_tokens: 1024,
          system: `${SYSTEM_PROMPT}\n\n今日の日付（JST）: ${today}`,
          messages: [{ role: 'user', content: text }],
          output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.error(`[shift-parse] API エラー: HTTP ${res.status}`);
        return { isRequest: false, entries: [] };
      }
      const body = await res.json();
      if (body.stop_reason === 'refusal') return { isRequest: false, entries: [] };
      return sanitize(JSON.parse(body.content?.[0]?.text));
    } catch (err) {
      console.error(`[shift-parse] 解釈失敗: ${err.message}`);
      return { isRequest: false, entries: [] };
    }
  }

  return { parse };
}

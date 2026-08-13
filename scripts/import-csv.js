// 予約 CSV を取り込み API（POST /api/import/reservations）へ流すスクリプト。
// EPARK など「CSV エクスポートしかない」予約システムとの連携用。
// 列名の対応はマッピングファイル（JSON）で吸収するため、上流が変わってもここは書き換えない。
//
// 使い方:
//   node scripts/import-csv.js --file=reservations.csv --map=scripts/mappings/epark.json \
//     [--url=http://127.0.0.1:3000] [--token=$INGEST_API_TOKEN] [--dry-run]
//
// --dry-run は API に送らず、変換結果の JSON を表示するだけ（マッピング調整用）
import { readFile } from 'node:fs/promises';

function getArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

// 引用符・カンマ・改行（CRLF/LF）対応の素朴な CSV パーサ
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** 「2026/08/01」「2026-08-01」+「14:00」を ISO(+09:00) にする */
export function toJstIso(dateStr, timeStr) {
  const d = (dateStr ?? '').trim().replaceAll('/', '-');
  const m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const t = (timeStr ?? '').trim().match(/^(\d{1,2}):(\d{2})/) ?? ['', '0', '00'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(t[1])}:${t[2]}:00+09:00`;
}

/** 1行を取り込み API の形式に変換する */
export function convertRow(row, header, mapping) {
  const col = (name) => {
    const key = mapping.columns[name];
    if (!key) return null;
    const idx = header.indexOf(key);
    return idx >= 0 ? (row[idx] ?? '').trim() : null;
  };

  const reservedAt = mapping.columns.reserved_datetime
    ? toJstIso(...(col('reserved_datetime') ?? '').split(/\s+/))
    : toJstIso(col('reserved_date'), col('reserved_time'));

  const rawStatus = col('status');
  const status = (rawStatus && mapping.statusMap?.[rawStatus]) || mapping.defaultStatus || 'confirmed';

  return {
    external_id: `${mapping.externalIdPrefix ?? ''}${col('external_id')}`,
    customer_name: col('customer_name'),
    phone: col('phone'),
    birthday: col('birthday') || undefined,
    menu: col('menu') || undefined,
    staff_name: col('staff_name') || undefined,
    reserved_at: reservedAt,
    status,
  };
}

async function main() {
  const filePath = getArg('file');
  const mapPath = getArg('map');
  const baseUrl = getArg('url', 'http://127.0.0.1:3000');
  const token = getArg('token', process.env.INGEST_API_TOKEN ?? '');
  const dryRun = process.argv.includes('--dry-run');

  if (!filePath || !mapPath) {
    console.error(
      '使い方: node scripts/import-csv.js --file=<csv> --map=<mapping.json> [--url=...] [--token=...] [--dry-run]'
    );
    process.exit(1);
  }

  const mapping = JSON.parse(await readFile(mapPath, 'utf8'));
  const buf = await readFile(filePath);
  const text = new TextDecoder(mapping.encoding || 'utf-8').decode(buf);

  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error('CSV にデータ行がありません');
    process.exit(1);
  }
  const [header, ...dataRows] = rows;
  const reservations = dataRows.map((row) => convertRow(row, header, mapping));

  if (dryRun) {
    console.log(JSON.stringify({ count: reservations.length, reservations }, null, 2));
    return;
  }
  if (!token) {
    console.error('--token または INGEST_API_TOKEN が必要です');
    process.exit(1);
  }

  // API 側の上限に合わせて分割送信
  const BATCH = 100;
  const totals = { total: 0, created: 0, updated: 0, failed: 0 };
  for (let i = 0; i < reservations.length; i += BATCH) {
    const batch = reservations.slice(i, i + BATCH);
    const res = await fetch(`${baseUrl}/api/import/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reservations: batch }),
    });
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const { summary, results } = await res.json();
    for (const key of Object.keys(totals)) totals[key] += summary[key];
    for (const r of results.filter((x) => !x.ok)) {
      console.error(`  失敗: ${r.external_id}: ${r.error}`);
    }
  }
  console.log(
    `取り込み完了: 全${totals.total}件 / 新規${totals.created} / 更新${totals.updated} / 失敗${totals.failed}`
  );
}

// テストから import できるよう、直接実行時のみ main を走らせる
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

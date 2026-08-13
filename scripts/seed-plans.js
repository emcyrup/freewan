// 定額コース（保育コース）のマスタ投入。新しい店舗の立ち上げで使う。
// 使い方: node scripts/seed-plans.js
//         node scripts/seed-plans.js --file=scripts/store-data/freewan.plans.json
// 店舗ごとのコースは --file で JSON（[{name, monthlyQuota, carryOverMonths, sortOrder}]）を渡す。
// 未指定ならこれまでどおり既定値（保育コース 月4回/月8回）を入れる。
// 同じ名前があれば飛ばすので、何度実行しても増えない。

const DEFAULT_PLANS = [
  { name: '保育コース 月4回', monthlyQuota: 4, carryOverMonths: 1, sortOrder: 1 },
  { name: '保育コース 月8回', monthlyQuota: 8, carryOverMonths: 1, sortOrder: 2 },
];

async function loadPlansFile(path) {
  const { readFile } = await import('node:fs/promises');
  const plans = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(plans) || plans.length === 0) {
    throw new Error(`${path}: コースの配列ではありません`);
  }
  for (const p of plans) {
    if (!p || typeof p.name !== 'string' || p.name.trim() === '') {
      throw new Error(`${path}: name が無い項目があります`);
    }
    for (const key of ['monthlyQuota', 'carryOverMonths', 'sortOrder']) {
      if (!Number.isInteger(p[key]) || p[key] < 0) {
        throw new Error(`${path}: ${p.name} の ${key} は 0 以上の整数にしてください`);
      }
    }
  }
  return plans;
}

const fileArg = process.argv.find((a) => a.startsWith('--file='));
const plans = fileArg ? await loadPlansFile(fileArg.slice('--file='.length)) : DEFAULT_PLANS;
if (fileArg) console.log(`[seed-plans] ${fileArg.slice('--file='.length)} から投入`);

const { pool } = await import('../src/db/pool.js');

const added = [];
for (const p of plans) {
  const { rows } = await pool.query(`SELECT 1 FROM plans WHERE name = $1`, [p.name]);
  if (rows.length > 0) continue;
  await pool.query(
    `INSERT INTO plans (name, monthly_quota, carry_over_months, sort_order) VALUES ($1, $2, $3, $4)`,
    [p.name, p.monthlyQuota, p.carryOverMonths, p.sortOrder]
  );
  added.push(p.name);
}
console.log(added.length ? `[seed-plans] 追加 ${added.length}件: ${added.join('、')}` : '[seed-plans] 追加なし（すべて登録済み）');
await pool.end();

// デモ用の顧客＋ペットの投入。モック（/mock/）の顧客一覧と同じ10世帯・14頭を
// 実DBに登録し、顧客管理ページ（/admin/customers.html）で参照・編集を試せるようにする。
// 使い方:
//   docker compose exec app node scripts/seed-customers.js            … 投入
//   docker compose exec app node scripts/seed-customers.js --remove   … 投入したデモ顧客を削除
//
// 電話番号（架空）で重複を判定するため、何度実行しても二重登録されない。
// --remove は下記リストの電話番号に一致する顧客だけを消す（ペットは CASCADE で一緒に消える）。
// LINE 連携済みになった顧客は実運用に入っているとみなし、削除しない。
import { normalizePhone } from '../src/customers/phone.js';

export const DEMO_FAMILIES = [
  { name: '田中 里奈', phone: '090-1234-5678', pets: [
    { name: 'マロン', breed: 'トイプードル', birthday: '2021-02-14', notes: '♀。テディベアカット・耳周り短めのご希望。保育コース 月4回。かかりつけ: 北区どうぶつ病院' },
    { name: 'ムギ', breed: '柴', birthday: '2024-05-03', notes: '♂。マロンと同時来店が多い。回数券利用' },
  ]},
  { name: '山口 健太', phone: '080-2345-6789', pets: [
    { name: 'ソラ', breed: '柴', birthday: '2025-06-20', notes: '♂。保育コース 月8回。トイレトレーニング中。かかりつけ: 梅田ペットクリニック' },
  ]},
  { name: '佐々木 由美', phone: '090-3456-7890', pets: [
    { name: 'ココ', breed: 'チワワ', birthday: '2019-01-09', notes: '♀。皮膚が乾燥気味のため低刺激シャンプー使用' },
    { name: 'モモ', breed: 'MIX', birthday: '2022-08-30', notes: '♀。人見知りが強め。少人数の日をご案内' },
  ]},
  { name: '中島 翔太', phone: '070-4567-8901', pets: [
    { name: 'レオ', breed: 'ポメラニアン', birthday: '2024-03-18', notes: '♂。保育コース 月4回。ボール遊びが得意。かかりつけ: 天満どうぶつ病院' },
  ]},
  { name: '藤本 恵子', phone: '090-5678-9012', pets: [
    { name: 'ハナ', breed: 'チワワ', birthday: '2023-04-02', notes: '♀。ワクチン更新の確認が必要' },
    { name: 'きなこ', breed: '豆柴', birthday: '2020-11-11', notes: '♀。回数券の期限切れに注意' },
  ]},
  { name: '大西 亮', phone: '080-6789-0123', pets: [
    { name: 'モカ', breed: 'トイプードル', birthday: '2018-02-28', notes: '♀。シニアのため休憩を挟みながら短時間で。かかりつけ: 扇町アニマルクリニック' },
  ]},
  { name: '小林 さやか', phone: '090-7890-1234', pets: [
    { name: 'クッキー', breed: 'M.ダックス', birthday: '2025-03-07', notes: '♂。元気いっぱい。ご家族で通うか検討中' },
  ]},
  { name: '森田 直樹', phone: '080-8901-2345', pets: [
    { name: 'プリン', breed: 'ヨークシャテリア', birthday: '2022-09-15', notes: '♀。リボン付け。写真の掲載OK' },
    { name: 'チョコ', breed: 'ラブラドール', birthday: '2023-06-01', notes: '♂。大型犬。抜け毛ケア' },
  ]},
  { name: '岡田 美穂', phone: '090-9012-3456', pets: [
    { name: 'ラテ', breed: 'シーズー', birthday: '2017-05-22', notes: '♀。シニア。目まわりのケアを丁寧に' },
  ]},
  { name: '西村 大輔', phone: '070-0123-4567', pets: [
    { name: 'ベル', breed: 'M.シュナウザー', birthday: '2021-07-07', notes: '♀。保育コース 月8回。宿泊利用あり（ワンず写メ日記）。かかりつけ: 扇町アニマルクリニック' },
  ]},
];

export async function seedCustomers(pool, families = DEMO_FAMILIES) {
  const result = { added: [], skipped: [] };
  for (const family of families) {
    const phoneNorm = normalizePhone(family.phone);
    const { rows: existing } = await pool.query(
      `SELECT id FROM customers WHERE phone_norm = $1`,
      [phoneNorm]
    );
    if (existing.length > 0) {
      result.skipped.push(family.name);
      continue;
    }
    const { rows } = await pool.query(
      `INSERT INTO customers (name, phone_norm) VALUES ($1, $2) RETURNING id`,
      [family.name, phoneNorm]
    );
    const customerId = rows[0].id;
    for (const pet of family.pets) {
      await pool.query(
        `INSERT INTO pets (customer_id, name, breed, birthday, notes) VALUES ($1, $2, $3, $4, $5)`,
        [customerId, pet.name, pet.breed, pet.birthday, pet.notes]
      );
    }
    result.added.push(`${family.name}（${family.pets.map((p) => p.name).join('・')}）`);
  }
  return result;
}

export async function removeCustomers(pool, families = DEMO_FAMILIES) {
  const phones = families.map((f) => normalizePhone(f.phone));
  // LINE 連携済みは実顧客になっている可能性があるため残す
  const { rows } = await pool.query(
    `DELETE FROM customers
     WHERE phone_norm = ANY($1) AND line_user_id IS NULL
     RETURNING name`,
    [phones]
  );
  return { removed: rows.map((r) => r.name) };
}

async function main() {
  const { pool } = await import('../src/db/pool.js');
  if (process.argv.includes('--remove')) {
    const { removed } = await removeCustomers(pool);
    console.log(`[seed-customers] 削除 ${removed.length}件: ${removed.join('、') || 'なし'}`);
  } else {
    const result = await seedCustomers(pool);
    console.log(`[seed-customers] 追加 ${result.added.length}件:`);
    for (const line of result.added) console.log(`  ${line}`);
    if (result.skipped.length > 0) {
      console.log(`[seed-customers] 既存のためスキップ: ${result.skipped.join('、')}`);
    }
  }
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

// デモ用の予約の投入。予約管理ページ（予約一覧）とカレンダーを、実データが入る前でも
// 本番と同じ画面で確認できるようにする。seed-customers.js のデモ世帯にぶら下げる。
// 使い方:
//   docker compose exec app node scripts/seed-reservations.js            … 投入
//   docker compose exec app node scripts/seed-reservations.js --remove   … 投入したデモ予約を削除
//
// 【誤爆防止】このスクリプトは予約サービス（createManual）を通さず SQL で直接入れる。
// createManual はスタッフ通知（Slack／LINE）を伴うため、デモ投入で本物の通知が飛んでしまう。
// あわせて、LINE 連携済み（line_user_id IS NOT NULL）の顧客には絶対にぶら下げない。
// 配信ジョブは全て line_user_id IS NOT NULL を条件にしているので、
// この2点を守る限り SEND_MODE=live でもデモ予約が飼い主様へ配信されることはない。
//
// external_id に 'demo:' 接頭辞を付けて投入するため、何度実行しても二重登録されず、
// --remove もその接頭辞だけを消す（手入力した本物の予約は残る）。

export const DEMO_PREFIX = 'demo:';

// メニューが未登録でも動くようにする。menus テーブルにあればそちらを優先する
const MENU_FALLBACK = {
  'シャンプーコース': { category: 'trimming', durationMinutes: 60 },
  'カットコース': { category: 'trimming', durationMinutes: 90 },
  'シャンプー＆カットコース': { category: 'trimming', durationMinutes: 120 },
  '部分カット（顔・足まわり）': { category: 'trimming', durationMinutes: 30 },
  'ペットスクール': { category: 'school', durationMinutes: 480 },
  '体験入園': { category: 'school', durationMinutes: 90 },
  'ペットホテル': { category: 'hotel', durationMinutes: 1440 },
};

// 実行日からの日数で置く。いつ投入しても「これからの予約」として一覧に出るようにするため。
// 一覧の既定表示は当日から14日先までなので、day が 0〜13 のものが最初から見える。
export const DEMO_RESERVATIONS = [
  { ref: 'r01', pet: 'マロン', menu: 'シャンプー＆カットコース', day: 0, time: '10:30',
    staff: '佐藤', status: 'confirmed', confirmed: true, note: '' },
  // r01 と同じ担当・重なる時間。予約一覧の「時間が重複」の赤表示を確かめるためのもの
  { ref: 'r02', pet: 'モカ', menu: 'カットコース', day: 0, time: '11:30',
    staff: '佐藤', status: 'confirmed', note: 'シニアなので休憩をはさみながらお願いします。' },
  { ref: 'r03', pet: 'ソラ', menu: 'ペットスクール', day: 0, time: '9:00',
    staff: '中村', status: 'confirmed', stage: 'enrolled', note: '' },
  // 当日の来店済。写真を付けると 19:00 のお礼配信（R9）の対象になる導線を試せる
  { ref: 'r04', pet: 'ハナ', menu: '体験入園', day: 0, time: '13:00',
    staff: '中村', status: 'visited', stage: 'trial', note: '' },
  { ref: 'r05', pet: 'ムギ', menu: 'シャンプーコース', day: 1, time: '10:00',
    staff: '高橋', status: 'confirmed', confirmed: true, note: '' },
  { ref: 'r06', pet: 'レオ', menu: 'ペットスクール', day: 1, time: '9:00',
    staff: '山本', status: 'confirmed', stage: 'enrolled', note: '' },
  { ref: 'r07', pet: 'クッキー', menu: 'シャンプー＆カットコース', day: 2, time: '11:00',
    staff: null, status: 'requested', note: 'はじめてなので、短くしすぎない仕上がりを希望します。' },
  { ref: 'r08', pet: 'ラテ', menu: 'シャンプーコース', day: 3, time: '14:30',
    staff: '高橋', status: 'requested', note: '' },
  { ref: 'r09', pet: 'ベル', menu: 'ペットホテル', day: 4, time: '13:00',
    staff: null, status: 'confirmed', note: 'お迎えは18時半ごろになります。' },
  { ref: 'r10', pet: 'チョコ', menu: '体験入園', day: 5, time: '17:00',
    staff: '中村', status: 'confirmed', stage: 'counseling', note: '大型犬ですが対応可能でしょうか。' },
  { ref: 'r11', pet: 'ココ', menu: '部分カット（顔・足まわり）', day: 7, time: '10:00',
    staff: '佐藤', status: 'confirmed', note: '' },
  { ref: 'r12', pet: 'きなこ', menu: 'シャンプーコース', day: 9, time: '15:00',
    staff: '高橋', status: 'cancelled', note: '' },
  { ref: 'r13', pet: 'プリン', menu: 'シャンプー＆カットコース', day: 12, time: '11:00',
    staff: '佐藤', status: 'confirmed', note: 'リボンはピンクでお願いします。' },
  // 過去ぶん。期間を指定して振り返る操作を試せるようにする
  { ref: 'r14', pet: 'マロン', menu: 'ペットスクール', day: -7, time: '9:00',
    staff: '山本', status: 'visited', stage: 'enrolled', note: '' },
  { ref: 'r15', pet: 'モモ', menu: 'シャンプーコース', day: -3, time: '13:00',
    staff: '高橋', status: 'no_show', note: '' },
];

/** メニューの区分と所要時間。menus テーブルを正とし、無ければ組み込みの表で補う */
async function menuSpecs(pool, names) {
  const { rows } = await pool.query(
    `SELECT name, category, duration_minutes FROM menus WHERE name = ANY($1)`,
    [names]
  );
  const byName = new Map(rows.map((r) => [r.name, r]));
  const specs = new Map();
  for (const name of names) {
    const row = byName.get(name);
    const fallback = MENU_FALLBACK[name] ?? {};
    specs.set(name, {
      category: row?.category ?? fallback.category ?? null,
      durationMinutes: row?.duration_minutes ?? fallback.durationMinutes ?? null,
    });
  }
  return specs;
}

/** 担当スタッフの id。居なければ作る（デモの担当割り当てを見せるため） */
async function staffIds(pool, names) {
  const ids = new Map();
  for (const name of names) {
    const { rows } = await pool.query(`SELECT id FROM staff WHERE name = $1`, [name]);
    if (rows.length > 0) {
      ids.set(name, rows[0].id);
      continue;
    }
    const created = await pool.query(`INSERT INTO staff (name) VALUES ($1) RETURNING id`, [name]);
    ids.set(name, created.rows[0].id);
  }
  return ids;
}

/**
 * ペット名から「デモ顧客の」ペットを引く。
 * line_user_id が入っている顧客は実運用に入っているとみなして除外する（配信対象になり得るため）
 */
async function demoPets(pool, names) {
  const { rows } = await pool.query(
    `SELECT p.id AS pet_id, p.name, p.customer_id
     FROM pets p
     JOIN customers c ON c.id = p.customer_id
     WHERE p.name = ANY($1) AND c.line_user_id IS NULL
     ORDER BY p.id`,
    [names]
  );
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.name)) byName.set(row.name, row);
  }
  return byName;
}

export async function seedReservations(pool, items = DEMO_RESERVATIONS) {
  const petNames = [...new Set(items.map((i) => i.pet))];
  const menuNames = [...new Set(items.map((i) => i.menu))];
  const staffNames = [...new Set(items.map((i) => i.staff).filter(Boolean))];

  const pets = await demoPets(pool, petNames);
  const specs = await menuSpecs(pool, menuNames);
  const staff = await staffIds(pool, staffNames);

  const result = { added: [], skipped: [], missing: [] };
  for (const item of items) {
    const pet = pets.get(item.pet);
    if (!pet) {
      // デモ顧客が未投入か、その子の飼い主が LINE 連携済み
      if (!result.missing.includes(item.pet)) result.missing.push(item.pet);
      continue;
    }
    const spec = specs.get(item.menu);
    const { rows } = await pool.query(
      `INSERT INTO reservations
         (customer_id, staff_id, menu, note, pet_id, category, duration_minutes,
          school_stage, reserved_at, status, confirmed_by_customer, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               ((now() AT TIME ZONE 'Asia/Tokyo')::date + ($9::int * INTERVAL '1 day') + $10::time)
                 AT TIME ZONE 'Asia/Tokyo',
               $11, $12, $13)
       ON CONFLICT (external_id) DO NOTHING
       RETURNING id`,
      [
        pet.customer_id,
        item.staff ? staff.get(item.staff) : null,
        item.menu,
        item.note || null,
        pet.pet_id,
        spec.category,
        spec.durationMinutes,
        item.stage ?? null,
        item.day,
        item.time,
        item.status,
        item.confirmed === true,
        DEMO_PREFIX + item.ref,
      ]
    );
    if (rows.length === 0) result.skipped.push(item.ref);
    else result.added.push(`${item.pet} ${item.menu}（${item.status}）`);
  }
  return result;
}

export async function removeReservations(pool) {
  const { rows } = await pool.query(
    `DELETE FROM reservations WHERE external_id LIKE $1 RETURNING id`,
    [DEMO_PREFIX + '%']
  );
  return { removed: rows.length };
}

async function main() {
  const { pool } = await import('../src/db/pool.js');
  if (process.argv.includes('--remove')) {
    const { removed } = await removeReservations(pool);
    console.log(`[seed-reservations] 削除 ${removed}件`);
  } else {
    const result = await seedReservations(pool);
    console.log(`[seed-reservations] 追加 ${result.added.length}件:`);
    for (const line of result.added) console.log(`  ${line}`);
    if (result.skipped.length > 0) {
      console.log(`[seed-reservations] 投入済みのためスキップ: ${result.skipped.join('、')}`);
    }
    if (result.missing.length > 0) {
      console.log(
        `[seed-reservations] 対象のペットが見つからず飛ばしました: ${result.missing.join('、')}\n` +
        '  先に node scripts/seed-customers.js を実行してください'
      );
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

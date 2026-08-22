// .env をアプリ自身で読み込む。
//
// 以前は npm scripts で node の --env-file-if-missing を使っていたが、
// サーバーによって node のバージョンが違い、
// 「node: bad option: --env-file-if-missing」で起動できないことがあった。
// 起動方法（npm start / node src/index.js / 各 scripts/）によって
// 読まれたり読まれなかったりするのも事故のもとだったため、
// 設定の入口（config.js）で必ず一度だけ読む形に寄せている。
//
// 【重要】既に環境変数がある場合は .env で上書きしない。
// SEND_MODE=live は .env に書かず実行時に渡す運用のため、
// ここで .env 側を優先すると live 指定が握り潰される。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** .env 1ファイル分の中身を { key: value } に変換する（テストから直接呼べるよう分けている） */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === '`') && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      // 二重引用符のときだけエスケープを解く（node の --env-file と同じ扱い）
      if (quote === '"') {
        value = value.replace(/\\([nrt"\\])/g, (_, c) =>
          c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
        );
      }
    } else {
      // 引用符なしの # 以降はコメント。
      // パスワードに # を含む DATABASE_URL は %23 に書き換えて渡すこと
      const hash = value.indexOf('#');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** .env があれば process.env へ流し込む。無ければ何もしない（Docker では compose 側が渡すため） */
export function loadDotEnv(filePath = ENV_PATH, env = process.env) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return env;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

loadDotEnv();

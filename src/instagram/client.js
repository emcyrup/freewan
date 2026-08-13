// Instagram 投稿クライアント。投稿は必ずここを経由する（LINE の client.js と同じ役割）。
//
// 誤投稿防止のため IG_POST_MODE で2段階に制御する。
//   dry_run — 投稿せず、内容を標準出力に出すだけ（デフォルト）
//   live    — 実際に Instagram へ投稿する
//
// 画像は「公開 URL を渡して Instagram 側に取得させる」仕様のため、
// 事前に /sns-media/ で公開されているファイルの URL を渡すこと。
import { SETTING_KEYS } from '../settings.js';

const API_VERSION = 'v21.0';
// 60日トークンの残りが切れる前に延長する。リフレッシュは発行から24時間後以降のみ可能
const REFRESH_INTERVAL_DAYS = 7;

export function createInstagramClient({
  config,
  settings = null,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const base = `${config.igGraphBase}/${API_VERSION}`;

  // トークンは DB（リフレッシュで更新される）を優先し、env を初期値にする
  async function resolveToken() {
    if (settings) {
      const stored = await settings.get(SETTING_KEYS.igAccessToken).catch(() => null);
      if (stored) return stored;
    }
    return config.igAccessToken ?? null;
  }

  // どの呼び出しで失敗したかが分からないと切り分けできないため、
  // パスと Meta 側の詳細（error_user_msg / code / subcode）をメッセージに含める
  function apiError(status, path, error = {}) {
    const detail = [error.message, error.error_user_msg].filter(Boolean).join(' / ') || 'unknown error';
    const codes = error.code
      ? `, code=${error.code}${error.error_subcode ? `/${error.error_subcode}` : ''}`
      : '';
    return new Error(`Instagram API ${status}: ${detail}（at ${path.split('?')[0]}${codes}）`);
  }

  async function apiGet(path) {
    const token = await resolveToken();
    if (!token) throw new Error('Instagram のアクセストークンが未設定です');
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetchFn(`${base}${path}${sep}access_token=${encodeURIComponent(token)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(res.status, path, json.error);
    return json;
  }

  /**
   * コンテナの処理完了を待つ。Instagram は画像をこちらのサーバーへ取りに来て処理するため、
   * 完了前に公開すると「Media ID is not available」で失敗する（Meta の推奨手順どおり待つ）。
   */
  async function waitForContainer(creationId, { tries = 20, intervalMs = 2000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const { status_code: status } = await apiGet(`/${creationId}?fields=status_code`);
      if (status === 'FINISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new Error(
          `画像の処理に失敗しました（status=${status}）。画像URLに Instagram が到達できているか確認してください`
        );
      }
      await sleepFn(intervalMs);
    }
    throw new Error('画像の処理が時間内に完了しませんでした（あとで再投稿してください）');
  }

  async function api(path, params) {
    const token = await resolveToken();
    if (!token) throw new Error('Instagram のアクセストークンが未設定です');
    const body = new URLSearchParams({ ...params, access_token: token });
    const res = await fetchFn(`${base}${path}`, { method: 'POST', body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(res.status, `POST ${path}`, json.error);
    return json;
  }

  /**
   * 1〜10枚の画像を1件の投稿として公開する。
   * @param {string[]} imageUrls 公開 URL（1枚なら通常投稿、2枚以上はカルーセル）
   * @returns {Promise<{status: 'dry_run'|'published', mediaId?: string}>}
   */
  async function publishPost({ imageUrls, caption }) {
    if (!imageUrls?.length) throw new Error('画像がありません');
    if (imageUrls.length > 10) throw new Error('1投稿は10枚まで（分割は呼び出し側で行う）');

    if (config.igPostMode !== 'live') {
      console.log(
        `[dry_run instagram] ${imageUrls.length}枚\n` +
          `caption: ${caption}\n${imageUrls.join('\n')}`
      );
      return { status: 'dry_run' };
    }

    // トークン自身がアカウントを特定するため、ID 未設定なら 'me' で呼ぶ。
    // ID の手入力ミス（別画面の ID を貼る等）が実際に起きたための措置
    const igUserId = config.igUserId || 'me';

    let creationId;
    if (imageUrls.length === 1) {
      const media = await api(`/${igUserId}/media`, { image_url: imageUrls[0], caption });
      creationId = media.id;
    } else {
      // カルーセル: 各画像のコンテナ → 束ねるコンテナ → 公開 の3段階
      const children = [];
      for (const url of imageUrls) {
        const item = await api(`/${igUserId}/media`, { image_url: url, is_carousel_item: 'true' });
        children.push(item.id);
      }
      const container = await api(`/${igUserId}/media`, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        caption,
      });
      creationId = container.id;
    }

    await waitForContainer(creationId);
    const published = await api(`/${igUserId}/media_publish`, { creation_id: creationId });
    return { status: 'published', mediaId: published.id };
  }

  /**
   * 長期トークン（60日）の延長。前回の延長から一定期間空いたときだけ実行する。
   * 失敗しても投稿処理は止めない（既存トークンが有効な間は動くため）。
   */
  async function refreshTokenIfNeeded() {
    if (!settings) return { refreshed: false, reason: 'no_settings' };
    const token = await resolveToken();
    if (!token) return { refreshed: false, reason: 'no_token' };

    const last = await settings.get(SETTING_KEYS.igTokenRefreshedAt).catch(() => null);
    if (last) {
      const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
      if (days < REFRESH_INTERVAL_DAYS) return { refreshed: false, reason: 'fresh' };
    }

    const url = `${config.igGraphBase}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
    const res = await fetchFn(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`トークン延長に失敗: ${json.error?.message ?? res.status}`);
    }
    await settings.set(SETTING_KEYS.igAccessToken, json.access_token);
    await settings.set(SETTING_KEYS.igTokenRefreshedAt, new Date().toISOString());
    return { refreshed: true };
  }

  /** 接続確認（読み取りのみ）。アカウント名を返す */
  async function whoAmI() {
    const token = await resolveToken();
    if (!token) throw new Error('Instagram のアクセストークンが未設定です');
    const res = await fetchFn(`${base}/me?fields=user_id,username&access_token=${encodeURIComponent(token)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Instagram API ${res.status}: ${json.error?.message ?? 'unknown'}`);
    return json;
  }

  const enabled = Boolean(config.igAccessToken || settings);
  return { publishPost, refreshTokenIfNeeded, whoAmI, enabled };
}

/**
 * 11枚以上を Instagram の上限（10枚/投稿）に合わせて分割し、
 * 2件目以降のキャプションに「つづき（n/m）」を追記する。
 */
export function splitIntoPosts(files, caption) {
  const chunks = [];
  for (let i = 0; i < files.length; i += 10) chunks.push(files.slice(i, i + 10));
  return chunks.map((chunk, i) => ({
    files: chunk,
    caption:
      chunks.length === 1 ? caption : i === 0 ? caption : `${caption}\n\nつづき（${i + 1}/${chunks.length}）`,
  }));
}

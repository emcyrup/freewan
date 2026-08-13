// Threads 投稿クライアント。投稿は必ずここを経由する（LINE・Instagram の client.js と同じ役割）。
//
// 誤投稿防止のため THREADS_POST_MODE で2段階に制御する。
//   dry_run — 投稿せず、内容を標準出力に出すだけ（デフォルト）
//   live    — 実際に Threads へ投稿する
//
// 画像は Instagram と同じく「公開 URL を渡して Threads 側に取得させる」仕様のため、
// 事前に /sns-media/ で公開されているファイルの URL を渡すこと。
import { SETTING_KEYS } from '../settings.js';

const API_VERSION = 'v1.0';
// カルーセルは2〜20枚。1枚のときは通常の画像投稿になる
export const MAX_ITEMS = 20;
// 本文は500文字まで（Instagram の2200文字とは別枠なので、共用する画面側で切り分ける）
export const MAX_TEXT = 500;
const REFRESH_INTERVAL_DAYS = 7;

export function createThreadsClient({
  config,
  settings = null,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const base = `${config.threadsGraphBase}/${API_VERSION}`;

  async function resolveToken() {
    if (settings) {
      const stored = await settings.get(SETTING_KEYS.threadsAccessToken).catch(() => null);
      if (stored) return stored;
    }
    return config.threadsAccessToken ?? null;
  }

  function apiError(status, path, error = {}) {
    const detail = [error.message, error.error_user_msg].filter(Boolean).join(' / ') || 'unknown error';
    const codes = error.code
      ? `, code=${error.code}${error.error_subcode ? `/${error.error_subcode}` : ''}`
      : '';
    return new Error(`Threads API ${status}: ${detail}（at ${path.split('?')[0]}${codes}）`);
  }

  async function apiGet(path) {
    const token = await resolveToken();
    if (!token) throw new Error('Threads のアクセストークンが未設定です');
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetchFn(`${base}${path}${sep}access_token=${encodeURIComponent(token)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(res.status, path, json.error);
    return json;
  }

  async function api(path, params) {
    const token = await resolveToken();
    if (!token) throw new Error('Threads のアクセストークンが未設定です');
    const body = new URLSearchParams({ ...params, access_token: token });
    const res = await fetchFn(`${base}${path}`, { method: 'POST', body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(res.status, `POST ${path}`, json.error);
    return json;
  }

  /**
   * コンテナの処理完了を待つ。Threads がこちらのサーバーへ画像を取りに来て処理するため、
   * 完了前に公開すると失敗する（Instagram と同じ理由・同じ手順）。
   */
  async function waitForContainer(creationId, { tries = 20, intervalMs = 2000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const { status, error_message: message } = await apiGet(`/${creationId}?fields=status,error_message`);
      if (status === 'FINISHED' || status === 'PUBLISHED') return;
      if (status === 'ERROR' || status === 'EXPIRED') {
        throw new Error(
          `画像の処理に失敗しました（status=${status}${message ? `: ${message}` : ''}）。` +
            '画像URLに Threads が到達できているか確認してください'
        );
      }
      await sleepFn(intervalMs);
    }
    throw new Error('画像の処理が時間内に完了しませんでした（あとで再投稿してください）');
  }

  /**
   * 1〜20枚の画像を1件の投稿として公開する。
   * @param {string[]} imageUrls 公開 URL（1枚なら通常投稿、2枚以上はカルーセル）
   * @returns {Promise<{status: 'dry_run'|'published', mediaId?: string}>}
   */
  async function publishPost({ imageUrls, caption }) {
    if (!imageUrls?.length) throw new Error('画像がありません');
    if (imageUrls.length > MAX_ITEMS) throw new Error(`1投稿は${MAX_ITEMS}枚までです`);
    const text = (caption ?? '').slice(0, MAX_TEXT);

    if (config.threadsPostMode !== 'live') {
      console.log(
        `[dry_run threads] ${imageUrls.length}枚\ntext: ${text}\n${imageUrls.join('\n')}`
      );
      return { status: 'dry_run' };
    }

    // トークン自身がアカウントを特定するため、ID 未設定なら 'me' で呼ぶ（Instagram と同じ）
    const userId = config.threadsUserId || 'me';

    let creationId;
    if (imageUrls.length === 1) {
      const media = await api(`/${userId}/threads`, {
        media_type: 'IMAGE',
        image_url: imageUrls[0],
        text,
      });
      creationId = media.id;
    } else {
      const children = [];
      for (const url of imageUrls) {
        const item = await api(`/${userId}/threads`, {
          media_type: 'IMAGE',
          image_url: url,
          is_carousel_item: 'true',
        });
        children.push(item.id);
      }
      const container = await api(`/${userId}/threads`, {
        media_type: 'CAROUSEL',
        children: children.join(','),
        text,
      });
      creationId = container.id;
    }

    await waitForContainer(creationId);
    const published = await api(`/${userId}/threads_publish`, { creation_id: creationId });
    return { status: 'published', mediaId: published.id };
  }

  /** 長期トークン（60日）の延長。Instagram と同じ考え方で、失敗しても投稿処理は止めない */
  async function refreshTokenIfNeeded() {
    if (!settings) return { refreshed: false, reason: 'no_settings' };
    const token = await resolveToken();
    if (!token) return { refreshed: false, reason: 'no_token' };

    const last = await settings.get(SETTING_KEYS.threadsTokenRefreshedAt).catch(() => null);
    if (last) {
      const days = (Date.now() - new Date(last).getTime()) / 86_400_000;
      if (days < REFRESH_INTERVAL_DAYS) return { refreshed: false, reason: 'fresh' };
    }

    const url = `${config.threadsGraphBase}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`;
    const res = await fetchFn(url);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new Error(`トークン延長に失敗: ${json.error?.message ?? res.status}`);
    }
    await settings.set(SETTING_KEYS.threadsAccessToken, json.access_token);
    await settings.set(SETTING_KEYS.threadsTokenRefreshedAt, new Date().toISOString());
    return { refreshed: true };
  }

  /** 接続確認（読み取りのみ）。アカウント名を返す */
  async function whoAmI() {
    const token = await resolveToken();
    if (!token) throw new Error('Threads のアクセストークンが未設定です');
    const res = await fetchFn(`${base}/me?fields=id,username&access_token=${encodeURIComponent(token)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Threads API ${res.status}: ${json.error?.message ?? 'unknown'}`);
    return json;
  }

  const enabled = Boolean(config.threadsAccessToken || settings);
  return { publishPost, refreshTokenIfNeeded, whoAmI, enabled };
}

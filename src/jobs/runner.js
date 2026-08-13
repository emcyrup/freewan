// ジョブ共通処理: cron 登録・実行サマリのスタッフ通知・異常終了の捕捉。
// 個々の対象者のエラーはジョブ側で捕捉する前提（1件の失敗で他を止めない）。
// ここで捕捉するのはジョブ全体の異常（DB 接続断など）。
import cron from 'node-cron';
import { SETTING_KEYS } from '../settings.js';
import { formatJstDateTime } from '../util/jst.js';

const JOB_LABELS = {
  preReminder: '前々日確認',
  afterVisit: '来店フォロー',
  dormant: '休眠フォロー',
  birthday: '誕生日',
};

// まとめ通知の1行。0 の項目は省いて読みやすくする
export function summaryLine(name, summary) {
  const label = JOB_LABELS[name] ?? name;
  if (!summary) return `・${label}: 🚨 異常終了（詳細は別途通知）`;
  if (summary.disabled) return `・${label}: 停止中（管理画面で OFF）`;
  const parts = [`対象 ${summary.total}`];
  if (summary.sent > 0) parts.push(`送信 ${summary.sent}`);
  if (summary.dryRun > 0) parts.push(`dry_run ${summary.dryRun}`);
  if (summary.skipped > 0) parts.push(`スキップ ${summary.skipped}`);
  if (summary.failed > 0) parts.push(`⚠️ 失敗 ${summary.failed}`);
  return `・${label}: ${parts.join(' / ')}`;
}

export function createJobRunner({ slack, settings = null, reminders = null }) {
  /**
   * ジョブを1つ実行する。
   * ジョブ関数は { total, sent, dryRun, skipped, failed, errors } を返す規約とする。
   * notify=false のときは通知せずサマリだけ返す（日次のまとめ通知用）。
   */
  async function runJob(name, jobFn, { notify = true } = {}) {
    // 管理画面で OFF にされたリマインドはここで止める。手動実行も同じ判定にしておかないと
    // 「画面では止めたのに送られた」が起きるため、経路を分けない
    if (reminders && !(await reminders.isEnabled(name))) {
      console.log(`[job:${name}] 停止中のため実行しません`);
      return { total: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [], disabled: true };
    }
    const startedAt = Date.now();
    console.log(`[job:${name}] 開始`);
    try {
      const summary = await jobFn();
      const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const line =
        `対象 ${summary.total} / 送信 ${summary.sent} / dry_run ${summary.dryRun}` +
        ` / スキップ ${summary.skipped} / 失敗 ${summary.failed}（${sec}秒）`;
      console.log(`[job:${name}] 完了 ${line}`);
      if (notify) {
        await slack.notify(`:package: ジョブ実行結果 *${name}*\n${line}`);
        if (summary.failed > 0 && summary.errors?.length) {
          // 顧客は内部 id でのみ参照する（氏名・LINE userId を通知に含めない）
          const detail = summary.errors
            .slice(0, 10)
            .map((e) => `customer=${e.customerId}: ${e.message}`)
            .join('\n');
          await slack.notify(`:warning: *${name}* 失敗詳細（最大10件）\n\`\`\`${detail}\`\`\``);
        }
      }
      return summary;
    } catch (err) {
      console.error(`[job:${name}] 異常終了: ${err.message}`);
      // 異常終了はまとめを待たずスタックトレース付きで即時通知する
      await slack.notifyError(`ジョブ異常終了: ${name}`, err);
      return null;
    }
  }

  /**
   * 通数残数の警告文を返す（警告不要・確認失敗時は null）。
   * 閾値は上限の割合から算出する。プランを変えても設定変更が要らないようにするため。
   * warnRemaining を明示した場合のみ、その通数を閾値として使う。
   */
  async function quotaWarning(lineClient, { warnRatio = 0.1, warnRemaining = null } = {}) {
    try {
      const quota = await lineClient.getQuota();
      if (!quota.limited) return null;
      const threshold = warnRemaining ?? Math.ceil(quota.limit * warnRatio);
      if (quota.remaining > threshold) return null;

      const percent = Math.round((quota.remaining / quota.limit) * 100);
      return (
        `:warning: *LINE 月間通数の残りが少なくなっています*\n` +
        `使用済み ${quota.used} / 上限 ${quota.limit}（残り ${quota.remaining} 通・約${percent}%）\n` +
        `プランの見直し、または休眠フォローの日次上限の引き下げを検討してください。`
      );
    } catch (err) {
      console.error(`[quota] 残数確認失敗: ${err.message}`);
      return null;
    }
  }

  /** 単発の通数チェック＋通知（手動確認用） */
  async function checkQuota(lineClient, options = {}) {
    const warning = await quotaWarning(lineClient, options);
    if (warning) await slack.notify(warning);
  }

  /**
   * 全ジョブを直列実行し、結果を1つのまとめにして保存する。
   * 失敗詳細（ジョブごとに最大5件）と通数警告も同じまとめに含める。
   *
   * 結果は Push せず保存だけする。グループへの Push は1通ごとに通数を消費するため、
   * スタッフが「配信結果」と聞いたときに応答メッセージ（無料）で返す運用にしている。
   * 保存できなかった場合のみ、結果が消えないよう従来どおり Push する。
   */
  async function runAll(jobs, { lineClient, quotaWarnRatio, quotaWarnRemaining } = {}) {
    const lines = [];
    const failures = [];
    for (const [name, jobFn] of Object.entries(jobs)) {
      const summary = await runJob(name, jobFn, { notify: false });
      lines.push(summaryLine(name, summary));
      if (summary?.failed > 0 && summary.errors?.length) {
        const label = JOB_LABELS[name] ?? name;
        failures.push(
          ...summary.errors.slice(0, 5).map((e) => `${label}: customer=${e.customerId}: ${e.message}`)
        );
      }
    }

    let text = `:package: *ジョブ実行結果*（${formatJstDateTime(new Date())} 実行）\n${lines.join('\n')}`;
    if (failures.length > 0) {
      text += `\n\n:warning: 失敗詳細（ジョブごとに最大5件）\n\`\`\`${failures.join('\n')}\`\`\``;
    }
    if (lineClient) {
      const warning = await quotaWarning(lineClient, {
        warnRatio: quotaWarnRatio,
        warnRemaining: quotaWarnRemaining,
      });
      if (warning) text += `\n\n${warning}`;
    }

    if (!settings) {
      await slack.notify(text);
      return text;
    }
    try {
      await settings.set(SETTING_KEYS.lastJobSummary, text);
    } catch (err) {
      // 保存に失敗したら結果が確認できなくなるため、このときだけ Push する
      console.error(`[job] 実行結果の保存に失敗: ${err.message}`);
      await slack.notify(text);
    }
    return text;
  }

  /**
   * 毎日 10:00 JST に全ジョブを実行する。
   * 配信時刻は 10:00 JST 固定（深夜・早朝の送信は絶対に行わない）。
   */
  function scheduleDaily(jobs, options = {}) {
    return cron.schedule('0 10 * * *', () => runAll(jobs, options), { timezone: 'Asia/Tokyo' });
  }

  return { runJob, runAll, scheduleDaily, checkQuota, quotaWarning };
}

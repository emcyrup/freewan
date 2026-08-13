// 外部予約システムからの取り込み API。Bearer トークン認証（index.js 側で適用）配下。
// external_id で冪等に upsert するため、同じデータを何度送っても安全。
import express from 'express';

const MAX_BATCH = 500;

export function createImportRouter({ reservationService, slack }) {
  const router = express.Router();

  /**
   * POST /api/import/reservations
   * body: { reservations: [{ external_id, customer_name, phone, birthday?,
   *                          menu?, staff_name?, reserved_at, status? }] }
   */
  router.post('/reservations', async (req, res, next) => {
    try {
      const items = req.body?.reservations;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'reservations_required' });
      }
      if (items.length > MAX_BATCH) {
        return res.status(400).json({ error: 'too_many', max: MAX_BATCH });
      }

      const results = [];
      // 1件のエラーで全体を止めない。行ごとに結果を返す
      for (const item of items) {
        try {
          const result = await reservationService.upsertExternal({
            externalId: item.external_id,
            customerName: item.customer_name,
            phone: item.phone,
            birthday: item.birthday,
            menu: item.menu,
            staffName: item.staff_name,
            reservedAt: item.reserved_at,
            status: item.status || 'confirmed',
          });
          results.push({ external_id: item.external_id ?? null, ...result });
        } catch (err) {
          results.push({ external_id: item.external_id ?? null, ok: false, error: err.message });
        }
      }

      const summary = {
        total: results.length,
        created: results.filter((r) => r.ok && r.created).length,
        updated: results.filter((r) => r.ok && !r.created).length,
        failed: results.filter((r) => !r.ok).length,
      };
      if (summary.failed > 0) {
        await slack.notify(
          `:warning: 予約取り込みで ${summary.failed}/${summary.total} 件が失敗しました。API レスポンスを確認してください。`
        );
      }
      res.json({ summary, results });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
